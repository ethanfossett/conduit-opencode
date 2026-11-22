// ─── v2 message ordering ─────────────────────────────────────────────────────
// OpenCode v2 returns GET /api/session/:id/message NEWEST-FIRST (its list
// cursor encodes `"order":"desc"`). Conduit's internal Message[] contract is
// chronological (oldest-first): session history, the pagination cursor, the
// message poller and the frontend all assume it. This test locks in the
// normalisation applied at the API boundary — without it, session_switched
// history is delivered upside-down and the newest reply renders at the top.

import { describe, expect, it } from "vitest";
import { mapMessages } from "../../../src/lib/instance/opencode-client.js";

const SESSION = "ses_order";

/** Raw v2 wire message (assistant, with a single text part). */
function assistant(id: string, text: string, created: number) {
	return {
		id,
		type: "assistant",
		content: [{ type: "text", text }],
		time: { created },
	};
}

function user(id: string, text: string, created: number) {
	return { id, type: "user", text, time: { created } };
}

describe("mapMessages — v2 newest-first → chronological", () => {
	it("reverses a desc-ordered page into oldest-first order", () => {
		// API order: newest (index 0) → oldest (last).
		const raw = [
			assistant("msg_c", "third", 3000),
			assistant("msg_b", "second", 2000),
			assistant("msg_a", "first", 1000),
		];

		const mapped = mapMessages(raw, SESSION);

		expect(mapped.map((m) => m.id)).toEqual(["msg_a", "msg_b", "msg_c"]);
	});

	it("drops non-renderable messages before ordering without scrambling the rest", () => {
		const raw = [
			{ id: "msg_idle", type: "idle" }, // skipped by mapMessage
			assistant("msg_b", "second", 2000),
			{ id: "msg_synthetic", type: "synthetic", text: "<shell/>" }, // skipped
			user("msg_a", "hello", 1000),
		];

		const mapped = mapMessages(raw, SESSION);

		expect(mapped.map((m) => m.id)).toEqual(["msg_a", "msg_b"]);
		expect(mapped.map((m) => m.role)).toEqual(["user", "assistant"]);
	});

	it("returns an empty array for a non-array payload", () => {
		expect(mapMessages(null, SESSION)).toEqual([]);
		expect(mapMessages({ data: [] }, SESSION)).toEqual([]);
	});

	it("preserves part order within a message", () => {
		const raw = [
			{
				id: "msg_x",
				type: "assistant",
				content: [
					{ type: "text", text: "before" },
					{
						type: "tool",
						id: "call_1",
						name: "read",
						state: { status: "completed", output: "ok" },
					},
					{ type: "text", text: "after" },
				],
			},
		];

		const mapped = mapMessages(raw, SESSION);
		expect(mapped).toHaveLength(1);
		expect(mapped[0]?.parts?.map((p) => p.type)).toEqual([
			"text",
			"tool",
			"text",
		]);
	});
});
