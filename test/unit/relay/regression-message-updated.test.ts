// ─── Regression: step.ended usage/cost must reach the browser ────────────────
// v1 carried usage/cost on `message.updated`; v2 emits `session.step.ended`
// with a `tokens` object ({ input, output, reasoning, cache: {read, write} })
// and a `cost`. This verifies the v2 shape is mapped to a `result` message.

import { describe, expect, it } from "vitest";
import { translateStepEnded } from "../../../src/lib/relay/event-translator.js";
import type { OpenCodeEvent } from "../../../src/lib/types.js";

function stepEnded(props: Record<string, unknown>): OpenCodeEvent {
	return { type: "session.step.ended", properties: props };
}

describe("translateStepEnded — usage/cost regression", () => {
	it("extracts usage from the v2 tokens object", () => {
		const event = stepEnded({
			sessionID: "ses_abc",
			assistantMessageID: "msg_123",
			tokens: {
				input: 100,
				output: 200,
				reasoning: 5,
				cache: { read: 50, write: 10 },
			},
			cost: 0.0042,
		});

		const result = translateStepEnded(event);
		expect(result).not.toBeNull();
		expect(result?.type).toBe("result");
		if (result?.type === "result") {
			expect(result.usage.input).toBe(100);
			expect(result.usage.output).toBe(200);
			expect(result.usage.cache_read).toBe(50);
			expect(result.usage.cache_creation).toBe(10);
			expect(result.cost).toBe(0.0042);
			expect(result.sessionId).toBe("ses_abc");
			expect(result.messageId).toBe("msg_123");
		}
	});

	it("defaults missing optional fields to 0", () => {
		const event = stepEnded({ sessionID: "ses_xyz" });

		const result = translateStepEnded(event);
		expect(result).not.toBeNull();
		if (result?.type === "result") {
			expect(result.usage.input).toBe(0);
			expect(result.usage.output).toBe(0);
			expect(result.usage.cache_read).toBe(0);
			expect(result.usage.cache_creation).toBe(0);
			expect(result.cost).toBe(0);
			expect(result.duration).toBe(0);
		}
	});

	it("returns null for a non-step.ended event", () => {
		const event: OpenCodeEvent = {
			type: "session.text.delta",
			properties: { delta: "hi" },
		};
		expect(translateStepEnded(event)).toBeNull();
	});
});
