// ─── Translator: session.text.ended recovery + tool name correlation ─────────
//
// Regression coverage for two v2 streaming gaps:
//
//  1. `session.text.ended` carries the completed block's full text. When the
//     relay never observed the `session.text.delta` frames for that block
//     (late join, SSE gap, stopped poller) the ended frame is the *only*
//     remaining carrier of the assistant's reply. It must emit the text,
//     while de-duplicating against already-seen deltas.
//
//  2. `session.tool.called` carries no tool name in v2 — the name is only on
//     the earlier `session.tool.input.started`. The translator must correlate
//     so `tool_executing` messages are not emitted with `name: ""`.

import { describe, expect, it } from "vitest";
import {
	createTranslator,
	translateTextEnded,
} from "../../../src/lib/relay/event-translator.js";
import type { OpenCodeEvent } from "../../../src/lib/types.js";

const SESSION = "ses_text";

function textDelta(
	messageId: string,
	ordinal: number,
	delta: string,
): OpenCodeEvent {
	return {
		type: "session.text.delta",
		properties: {
			sessionID: SESSION,
			assistantMessageID: messageId,
			ordinal,
			delta,
		},
	};
}

function textEnded(
	messageId: string,
	ordinal: number,
	text: string,
): OpenCodeEvent {
	return {
		type: "session.text.ended",
		properties: {
			sessionID: SESSION,
			assistantMessageID: messageId,
			ordinal,
			text,
		},
	};
}

describe("translator — session.text.ended text recovery", () => {
	it("emits the full text as a delta when no deltas were observed", () => {
		const translator = createTranslator();
		const result = translator.translate(
			textEnded("msg_a", 0, "the final answer"),
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.messages).toHaveLength(1);
			expect(result.messages[0]).toMatchObject({
				type: "delta",
				text: "the final answer",
				messageId: "msg_a",
			});
		}
	});

	it("suppresses the full text when deltas were already streamed", () => {
		const translator = createTranslator();
		translator.translate(textDelta("msg_b", 0, "the "));
		translator.translate(textDelta("msg_b", 0, "final "));
		translator.translate(textDelta("msg_b", 0, "answer"));

		const result = translator.translate(
			textEnded("msg_b", 0, "the final answer"),
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain("deltas already streamed");
		}
	});

	it("does not double up when the same ended frame is delivered twice", () => {
		const translator = createTranslator();
		const first = translator.translate(textEnded("msg_c", 0, "answer"));
		const second = translator.translate(textEnded("msg_c", 0, "answer"));

		expect(first.ok).toBe(true);
		expect(second.ok).toBe(false);
	});

	it("emits text for an ordinal whose deltas were not seen", () => {
		const translator = createTranslator();
		// Deltas observed for the first text block only.
		translator.translate(textDelta("msg_d", 0, "first block"));

		const result = translator.translate(textEnded("msg_d", 1, "second block"));

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.messages[0]).toMatchObject({
				type: "delta",
				text: "second block",
			});
		}
	});

	it("does not emit when the ended frame carries no text", () => {
		const translator = createTranslator();
		const result = translator.translate({
			type: "session.text.ended",
			properties: {
				sessionID: SESSION,
				assistantMessageID: "msg_e",
				ordinal: 0,
			},
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain("empty text");
		}
	});

	it("reset(session) clears delta tracking so a later ended frame re-emits", () => {
		const translator = createTranslator();
		translator.translate(textDelta("msg_f", 0, "partial"));
		expect(
			translator.translate(textEnded("msg_f", 0, "partial final")).ok,
		).toBe(false);

		translator.reset(SESSION);

		const result = translator.translate(textEnded("msg_f", 0, "partial final"));
		expect(result.ok).toBe(true);
	});
});

describe("translateTextEnded (pure)", () => {
	it("maps ended → delta with the messageId", () => {
		expect(translateTextEnded(textEnded("msg_x", 0, "hi"))).toEqual({
			type: "delta",
			text: "hi",
			messageId: "msg_x",
		});
	});

	it("returns null for a non-ended event", () => {
		expect(translateTextEnded(textDelta("msg_x", 0, "hi"))).toBeNull();
	});
});

describe("translator — tool name correlation", () => {
	it("recovers the tool name for session.tool.called (which omits it)", () => {
		const translator = createTranslator();
		translator.translate({
			type: "session.tool.input.started",
			properties: {
				sessionID: SESSION,
				assistantMessageID: "msg_t",
				id: "call_1",
				name: "bash",
			},
		});

		const result = translator.translate({
			type: "session.tool.called",
			properties: {
				sessionID: SESSION,
				assistantMessageID: "msg_t",
				id: "call_1",
				input: { command: "ls" },
			},
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.messages[0]).toMatchObject({
				type: "tool_executing",
				name: "Bash",
			});
		}
	});

	it("prefers the name carried by tool.called when present", () => {
		const translator = createTranslator();
		translator.translate({
			type: "session.tool.input.started",
			properties: { sessionID: SESSION, id: "call_2", name: "read" },
		});

		const result = translator.translate({
			type: "session.tool.called",
			properties: { sessionID: SESSION, id: "call_2", name: "grep", input: {} },
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.messages[0]).toMatchObject({ name: "Grep" });
		}
	});

	it("recovers the tool name from a v2 `tool` field on tool.called", () => {
		const translator = createTranslator();
		translator.translate({
			type: "session.tool.input.started",
			properties: { sessionID: SESSION, id: "call_3", name: "write" },
		});

		// tool.progress also lacks a name; must recover it too.
		const result = translator.translate({
			type: "session.tool.progress",
			properties: { sessionID: SESSION, id: "call_3" },
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.messages[0]).toMatchObject({
				type: "tool_executing",
				name: "Write",
			});
		}
	});
});
