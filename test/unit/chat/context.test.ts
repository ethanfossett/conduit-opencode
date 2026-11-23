import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { assembleHistory } from "../../../src/lib/chat/context.js";
import { ChatService } from "../../../src/lib/chat/service.js";
import type {
	ChatConversation,
	ChatMessage,
} from "../../../src/lib/chat/types.js";

const user = (text: string): ChatMessage => ({ role: "user", text });
const assistant = (text: string): ChatMessage => ({ role: "assistant", text });

it("recalls original options across topic changes while keeping the latest working brief", () => {
	const messages = [
		user("I want to ship a private assistant."),
		assistant("Option one is SQLite. Option two is PostgreSQL."),
		user("Decision: PostgreSQL"),
		assistant("Recorded."),
		user("Decision: SQLite"),
		assistant("Recorded."),
		user("Constraint: Tailnet only"),
		assistant("Recorded."),
		...Array.from({ length: 18 }, (_, index) => [
			user(`Gardening discussion ${index}`),
			assistant("Let's discuss that."),
		]).flat(),
	];
	const chat: ChatConversation = {
		id: "test",
		title: "Test",
		updatedAt: 0,
		temporary: false,
		messages,
	};
	const entries = assembleHistory(
		chat,
		messages.length,
		"Return to the first option",
		50,
	);
	expect(entries).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ index: 1, kind: "Recalled" }),
			expect.objectContaining({ index: 4, kind: "Decision", text: "SQLite" }),
			expect.objectContaining({ index: 6, kind: "Constraint" }),
		]),
	);
	expect(entries).not.toContainEqual(expect.objectContaining({ index: 2 }));
	expect(entries.at(-1)?.index).toBe(messages.length - 1);
	expect(
		assembleHistory(
			chat,
			messages.length,
			"Return to the first option",
			96_000,
		),
	).toEqual([]);
});

it("persists context choices and remembers reasoning on regeneration without sending excluded or sourced history", async () => {
	const directory = await mkdtemp(join(tmpdir(), "conduit-context-"));
	const generate = vi.fn(
		async (
			_input: string,
			_signal: AbortSignal,
			_onText: (text: string) => void,
			_reasoning?: string,
		) => "A test reply",
	);
	const service = new ChatService(directory, generate, undefined, true);
	try {
		const { id } = await service.create(false);
		await service.send(id, "Goal: preserve the original deployment decision");
		await service.send(id, "Private example to exclude");
		await service.send(id, "Use attached source", [
			{ name: "secret.txt", text: "Sensitive attachment" },
		]);
		const current = await service.get(id);
		const pinned = await service.updateContext(id, 0, "pin", current.updatedAt);
		await expect(
			service.updateContext(id, 2, "exclude", current.updatedAt),
		).rejects.toMatchObject({ status: 409 });
		const excluded = await service.updateContext(
			id,
			2,
			"exclude",
			pinned.updatedAt,
		);
		await expect(
			service.updateContext(id, 5, "pin", excluded.updatedAt),
		).rejects.toMatchObject({ status: 400 });
		const preview = await service.previewContext(id, "How do we deploy?");
		expect(preview.map(({ index }) => index)).toEqual([0, 1]);

		await service.startTurn(id, {
			requestId: randomUUID(),
			text: "How do we deploy?",
			reasoning: "high",
		});
		await vi.waitFor(async () =>
			expect((await service.get(id)).turn).toBeUndefined(),
		);
		expect(generate.mock.lastCall).toEqual([
			expect.stringContaining("original deployment decision"),
			expect.any(AbortSignal),
			expect.any(Function),
			"high",
			undefined,
		]);
		expect(generate.mock.lastCall?.[0]).not.toMatch(
			/Private example|Sensitive attachment|Use attached source/,
		);

		const restarted = new ChatService(directory, generate, undefined, true);
		const saved = await restarted.get(id);
		expect(saved.lastContext?.entries).toContainEqual({
			index: 0,
			kind: "Pinned",
		});
		await restarted.startTurn(id, {
			requestId: randomUUID(),
			regenerate: true,
		});
		await vi.waitFor(async () =>
			expect((await restarted.get(id)).turn).toBeUndefined(),
		);
		expect(generate.mock.lastCall?.[3]).toBe("high");
		expect(
			(await restarted.create(false, { id, through: 2 })).excludedContext,
		).toEqual([]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
