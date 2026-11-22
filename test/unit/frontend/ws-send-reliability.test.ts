import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_resetRateLimit,
	rawSend,
	setWsGetter,
	wsSend,
} from "../../../src/lib/frontend/stores/ws-send.svelte.js";

vi.mock("../../../src/lib/frontend/stores/ui.svelte.js", () => ({
	showToast: vi.fn(),
}));

beforeEach(() => {
	vi.stubGlobal("WebSocket", { OPEN: 1 });
	_resetRateLimit();
});
afterEach(() => {
	setWsGetter(() => null);
	vi.unstubAllGlobals();
});

describe("submission transport", () => {
	it("reports disconnected sends instead of claiming success", () => {
		setWsGetter(() => null);
		expect(wsSend({ type: "message", text: "keep my draft" })).toBe(false);
		expect(wsSend({ type: "run_command", name: "test" })).toBe(false);
	});
	it("handles a socket closing during send without throwing", () => {
		setWsGetter(
			() =>
				({
					readyState: 1,
					send: () => {
						throw new Error("closed");
					},
				}) as unknown as WebSocket,
		);
		expect(rawSend({ type: "message" })).toBe(false);
	});
	it("rejects excess submissions and never replays them in a different chat", () => {
		vi.useFakeTimers();
		const send = vi.fn();
		setWsGetter(() => ({ readyState: 1, send }) as unknown as WebSocket);
		for (let i = 0; i < 5; i++)
			expect(wsSend({ type: "message", text: `${i}` })).toBe(true);
		expect(wsSend({ type: "message", text: "six" })).toBe(false);
		expect(wsSend({ type: "run_command", name: "seven" })).toBe(false);
		vi.advanceTimersByTime(20_000);
		expect(send).toHaveBeenCalledTimes(5);
		expect(wsSend({ type: "message", text: "manual retry" })).toBe(true);
		vi.useRealTimers();
	});
	it("does not consume rate-limit capacity for disconnected attempts", () => {
		setWsGetter(() => null);
		for (let i = 0; i < 5; i++) wsSend({ type: "message", text: "offline" });
		const send = vi.fn();
		setWsGetter(() => ({ readyState: 1, send }) as unknown as WebSocket);
		expect(wsSend({ type: "message", text: "back online" })).toBe(true);
	});
});
