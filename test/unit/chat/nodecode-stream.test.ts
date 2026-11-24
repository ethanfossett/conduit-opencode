import { afterEach, expect, it, vi } from "vitest";
import { streamNodeCode } from "../../../src/lib/chat/nodecode-stream.js";

afterEach(() => vi.unstubAllGlobals());

function provideStream(body: string) {
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(body, {
					headers: { "Content-Type": "text/event-stream" },
				}),
		),
	);
}

it("keeps a completed answer when the provider closes without a DONE sentinel", async () => {
	provideStream(
		[
			'data: {"choices":[{"delta":{"reasoning_content":"internal"}}]}',
			'data: {"choices":[{"delta":{"content":"One sentence."}}]}',
			'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
		].join("\n"),
	);
	const progress = vi.fn();
	await expect(
		streamNodeCode(
			"test-token",
			"synthetic",
			new AbortController().signal,
			progress,
		),
	).resolves.toBe("One sentence.");
	expect(progress.mock.calls).toEqual([["One sentence."]]);
});

it("distinguishes an interrupted provider stream from a complete answer and shows partial text", async () => {
	provideStream(
		'data: {"choices":[{"delta":{"content":"A partial answer."}}]}\n',
	);
	const progress = vi.fn();
	await expect(
		streamNodeCode("", "synthetic", new AbortController().signal, progress),
	).rejects.toThrow("disconnected before finishing");
	expect(progress).toHaveBeenCalledWith("A partial answer.");
});
