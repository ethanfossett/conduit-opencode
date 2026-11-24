import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { CompletionMessage } from "../../../src/lib/chat/nodecode-stream.js";
import { ChatService } from "../../../src/lib/chat/service.js";
import type { ChatReasoning } from "../../../src/lib/chat/types.js";

it("uses the selected model per turn and preserves only the played reply on an interruption", async () => {
	const directory = await mkdtemp(join(tmpdir(), "conduit-voice-chat-"));
	const generate = vi.fn(
		async (
			_input: string,
			signal: AbortSignal,
			onText: (text: string) => void,
			_reasoning?: ChatReasoning,
			model?: string,
			_structured?: CompletionMessage[],
		) => {
			const answer = "I heard you. This part never played.";
			onText(answer);
			if (model === "cloud")
				await new Promise<void>((resolve) =>
					signal.addEventListener("abort", () => resolve(), { once: true }),
				);
			return answer;
		},
	);
	const service = new ChatService(directory, generate, undefined, true, [
		{ id: "cloud", label: "Cloud", reasoning: true },
		{ id: "local", label: "Local", reasoning: false, local: true },
	]);
	try {
		const { id } = await service.create(true);
		await expect(
			service.startTurn(id, {
				requestId: randomUUID(),
				model: "wrong",
				text: "Ping",
			}),
		).rejects.toMatchObject({ status: 409 });
		const first = randomUUID();
		await service.startTurn(id, {
			requestId: first,
			model: "cloud",
			reasoning: "low",
			voice: true,
			text: "Remember the test code.",
		});
		await vi.waitFor(() =>
			expect(service.turnProgress(id)?.reply).toContain("never played"),
		);
		const interrupted = await service.interruptVoice(
			id,
			first,
			"I heard you.".length,
		);
		expect(interrupted.messages.at(-1)).toMatchObject({
			text: "I heard you.",
			interrupted: true,
			model: "cloud",
		});
		const second = randomUUID();
		await service.startTurn(id, {
			requestId: second,
			model: "local",
			voice: true,
			text: "What did you hear?",
		});
		await vi.waitFor(async () =>
			expect((await service.get(id)).turn).toBeUndefined(),
		);
		expect(generate.mock.lastCall?.[4]).toBe("local");
		expect(generate.mock.lastCall?.[0]).toContain("I heard you.");
		expect(generate.mock.lastCall?.[5]?.at(-1)).toEqual({
			role: "user",
			content: "What did you hear?",
		});
		expect(generate.mock.lastCall?.[0]).not.toContain("never played");
		const late = await service.interruptVoice(id, second, 0);
		expect(late.messages.at(-1)).toMatchObject({
			text: "",
			interrupted: true,
			model: "local",
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
