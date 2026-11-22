import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	handleSubmissionResult,
	submissionState,
	submitPrompt,
} from "../../../src/lib/frontend/stores/submissions.svelte.js";
import { wsSend } from "../../../src/lib/frontend/stores/ws-send.svelte.js";

vi.mock("../../../src/lib/frontend/stores/ws-send.svelte.js", () => ({
	wsSend: vi.fn(() => true),
}));
vi.mock("../../../src/lib/frontend/stores/ui.svelte.js", () => ({
	showToast: vi.fn(),
}));

beforeEach(() => {
	vi.useFakeTimers();
	vi.mocked(wsSend).mockReturnValue(true);
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

describe("upstream submission acknowledgements", () => {
	it("does not consider a socket write to be upstream acceptance", async () => {
		const item = await submitPrompt({
			type: "message",
			text: "accepted",
			sessionId: "s1",
		});
		if (!item) throw new Error("not submitted");
		expect(submissionState.statuses[item.requestId]).toBe("sending");
		handleSubmissionResult({
			type: "submission_result",
			requestId: item.requestId,
			sessionId: "s1",
			accepted: true,
		});
		expect(await item.accepted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("retains failed submissions for the composer", async () => {
		const item = await submitPrompt({
			type: "message",
			text: "failed",
			sessionId: "s1",
		});
		if (!item) throw new Error("not submitted");
		handleSubmissionResult({
			type: "submission_result",
			requestId: item.requestId,
			sessionId: "s1",
			accepted: false,
		});
		expect(await item.accepted).toBe(false);
		expect(submissionState.statuses[item.requestId]).toBe("failed");
	});
	it("marks timed-out receipts uncertain and reuses their ID for manual retry", async () => {
		const payload = { type: "message", text: "unknown", sessionId: "s1" };
		const item = await submitPrompt(payload);
		if (!item) throw new Error("not submitted");
		vi.advanceTimersByTime(30_000);
		expect(await item.accepted).toBe(false);
		expect(submissionState.statuses[item.requestId]).toBe("unknown");
		const retry = await submitPrompt(payload);
		expect(retry?.requestId).toBe(item.requestId);
		handleSubmissionResult({
			type: "submission_result",
			requestId: item.requestId,
			sessionId: "s1",
			accepted: true,
		});
		expect(await retry?.accepted).toBe(true);
	});
	it("returns immediately for a local send failure and leaves no timers", async () => {
		vi.mocked(wsSend).mockReturnValue(false);
		expect(await submitPrompt({ type: "message", text: "offline" })).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
	});
});
