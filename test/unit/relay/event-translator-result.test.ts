// ─── Tests: TranslateResult discriminated union ─────────────────────────────
// Verifies that createTranslator().translate() returns TranslateResult
// (ok: true with messages array, or ok: false with reason string).

import { describe, expect, it } from "vitest";
import type { TranslateResult } from "../../../src/lib/relay/event-translator.js";
import { createTranslator } from "../../../src/lib/relay/event-translator.js";

describe("translator returns TranslateResult", () => {
	const translator = createTranslator();

	it("returns ok: true with messages for known events", () => {
		const result = translator.translate({
			type: "session.text.delta",
			properties: { sessionID: "s1", delta: "hello" },
		});
		expect(result).toHaveProperty("ok", true);
		if (result.ok) {
			expect(result.messages.length).toBeGreaterThan(0);
		}
	});

	it("returns ok: false with reason for unknown events", () => {
		const result = translator.translate({
			type: "some.unknown.event",
			properties: {},
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain("unhandled event type");
		}
	});

	it("returns ok: false for events handled by the bridge", () => {
		const result = translator.translate({
			type: "permission.replied",
			properties: { requestID: "per_1" },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain("handled by bridge");
		}
	});

	it("messages array is always an array (never single message)", () => {
		const result = translator.translate({
			type: "session.text.delta",
			properties: { delta: "hi" },
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(Array.isArray(result.messages)).toBe(true);
		}
	});

	it("session.idle succeeded yields a done message", () => {
		const result = translator.translate({
			type: "session.idle",
			properties: { sessionID: "s1", outcome: "succeeded" },
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.messages).toHaveLength(1);
			expect(result.messages[0]?.type).toBe("done");
		}
	});

	it("session.execution.failed yields an error message", () => {
		const result = translator.translate({
			type: "session.execution.failed",
			properties: { sessionID: "s1", error: { message: "boom" } },
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.messages[0]).toMatchObject({
				type: "error",
				code: "EXECUTION_FAILED",
			});
		}
	});

	it("returns ok: false for ignored events (session.updated)", () => {
		const result = translator.translate({
			type: "session.updated",
			properties: { sessionID: "s1" },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBeTruthy();
		}
	});

	it("type narrows correctly after ok check", () => {
		const result: TranslateResult = translator.translate({
			type: "session.reasoning.delta",
			properties: { delta: "thinking" },
		});

		if (result.ok) {
			expect(result.messages.length).toBeGreaterThan(0);
		} else {
			expect(typeof result.reason).toBe("string");
		}
	});

	it("returns ok: true for a text delta event", () => {
		const result = translator.translate({
			type: "session.text.delta",
			properties: { delta: "hello" },
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.messages).toHaveLength(1);
			expect(result.messages[0]?.type).toBe("delta");
		}
	});
});
