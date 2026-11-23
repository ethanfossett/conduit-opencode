import { randomUUID } from "node:crypto";
import {
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { OpenCodeClient } from "../instance/opencode-client.js";
import { nodecodeModel } from "../nodecode.js";

import type { ChatAttachment, ChatConversation, ChatMessage } from "./types.js";

export class ChatError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

const MAX_INPUT = 24_000;
const MAX_REPLY = 64_000;
const MAX_TURNS = 100;
const MAX_CONVERSATIONS = 300;
const TEMPORARY_LIFETIME = 60 * 60 * 1000;

export class ChatService {
	private readonly temporary = new Map<string, ChatConversation>();
	private readonly pending = new Set<string>();
	private creating = false;

	constructor(
		private readonly directory: string,
		private readonly generate: (input: string) => Promise<string>,
	) {}

	async list() {
		const files = await readdir(this.directory).catch(
			(err: NodeJS.ErrnoException) => {
				if (err.code === "ENOENT") return [];
				throw err;
			},
		);
		const conversations: Pick<
			ChatConversation,
			"id" | "title" | "updatedAt"
		>[] = [];
		for (const name of files) {
			if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
			try {
				const { id, title, updatedAt } = await this.get(name.slice(0, -5));
				conversations.push({ id, title, updatedAt });
			} catch (err) {
				if (!(err instanceof ChatError && err.status === 404)) throw err;
			}
		}
		return conversations.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	async create(temporary: boolean): Promise<ChatConversation> {
		if (this.creating)
			throw new ChatError(409, "Another conversation is being created.");
		this.creating = true;
		try {
			this.expireTemporary();
			if (
				temporary
					? this.temporary.size >= MAX_CONVERSATIONS
					: (await this.list()).length >= MAX_CONVERSATIONS
			) {
				throw new ChatError(
					409,
					"Delete an old conversation before starting another.",
				);
			}
			const chat = {
				id: randomUUID(),
				title: "New chat",
				updatedAt: Date.now(),
				temporary,
				messages: [],
			};
			await this.save(chat);
			return chat;
		} finally {
			this.creating = false;
		}
	}

	async get(id: string): Promise<ChatConversation> {
		this.expireTemporary();
		const temporary = this.temporary.get(id);
		if (temporary) return temporary;
		try {
			return JSON.parse(
				await readFile(this.path(id), "utf8"),
			) as ChatConversation;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT")
				throw new ChatError(404, "Conversation not found.");
			throw err;
		}
	}

	async remove(id: string): Promise<void> {
		if (this.pending.has(id))
			throw new ChatError(409, "Wait for the reply before deleting this chat.");
		this.expireTemporary();
		this.pending.add(id);
		try {
			const chat = await this.get(id);
			if (chat.temporary) this.temporary.delete(id);
			else await rm(this.path(id), { force: true });
		} finally {
			this.pending.delete(id);
		}
	}

	async send(
		id: string,
		input: string,
		attachments: ChatAttachment[] = [],
	): Promise<ChatConversation> {
		this.expireTemporary();
		const text = input.trim();
		if (!text || text.length > MAX_INPUT)
			throw new ChatError(400, "Enter a message of at most 24,000 characters.");
		if (this.pending.has(id))
			throw new ChatError(409, "This chat is already waiting for a reply.");
		if (this.pending.size >= 4)
			throw new ChatError(
				429,
				"Chat is busy. Try again when a reply finishes.",
			);
		this.pending.add(id);
		try {
			const chat = await this.get(id);
			if (
				chat.messages.length >= MAX_TURNS * 2 ||
				JSON.stringify(chat.messages).length >= 500_000
			)
				throw new ChatError(
					409,
					"This conversation is full. Start a new chat.",
				);
			const messages: ChatMessage[] = [
				...chat.messages,
				{ role: "user", text, ...(attachments.length && { attachments }) },
			];
			// Include recent complete turns while capping the size of the transmitted context.
			const context = messages.slice(-21);
			while (JSON.stringify(context).length > 100_000 && context.length > 1)
				context.splice(0, 2);
			const reply = await this.generate(
				"You are a conversational assistant. Use the following JSON transcript as context and reply to its last user message. Return only your reply.\n\n" +
					JSON.stringify(context),
			).catch(() => {
				throw new ChatError(
					502,
					"The Chat model could not reply. Check the configured OpenCode instance.",
				);
			});
			if (!reply.trim())
				throw new ChatError(502, "The Chat model returned an empty reply.");
			const updated = {
				...chat,
				title: chat.messages.length
					? chat.title
					: text.replace(/\s+/g, " ").slice(0, 60),
				updatedAt: Date.now(),
				messages: [
					...messages,
					{ role: "assistant" as const, text: reply.slice(0, MAX_REPLY) },
				],
			};
			await this.save(updated);
			return updated;
		} finally {
			this.pending.delete(id);
		}
	}

	private path(id: string): string {
		if (!/^[0-9a-f-]{36}$/.test(id))
			throw new ChatError(404, "Conversation not found.");
		return join(this.directory, `${id}.json`);
	}

	private expireTemporary() {
		for (const [id, chat] of this.temporary) {
			if (
				chat.updatedAt < Date.now() - TEMPORARY_LIFETIME &&
				!this.pending.has(id)
			)
				this.temporary.delete(id);
		}
	}

	private async save(chat: ChatConversation) {
		if (chat.temporary) {
			this.temporary.set(chat.id, chat);
			return;
		}
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const path = this.path(chat.id);
		const staging = `${path}.${randomUUID()}.tmp`;
		try {
			await writeFile(staging, JSON.stringify(chat), {
				mode: 0o600,
				flag: "wx",
			});
			await rename(staging, path);
		} finally {
			await rm(staging, { force: true });
		}
	}
}

export function createConfiguredChat(
	directory: string,
	codePorts: () => number[],
): ChatService | undefined {
	const configured = process.env["CONDUIT_CHAT_OPENCODE_URL"];
	const password = process.env["CONDUIT_CHAT_OPENCODE_PASSWORD"];
	if (!configured || !password) return undefined;
	const endpoint = new URL(configured);

	// Dedicated loopback port and its own credentials are required. The relay
	// never falls back to a Code instance for generation.
	if (
		endpoint.protocol !== "http:" ||
		endpoint.hostname !== "127.0.0.1" ||
		endpoint.pathname !== "/" ||
		endpoint.search ||
		endpoint.hash ||
		endpoint.username ||
		endpoint.password ||
		!endpoint.port ||
		codePorts().includes(Number(endpoint.port))
	) {
		throw new Error("Chat requires its own OpenCode loopback port.");
	}
	const client = new OpenCodeClient({
		baseUrl: endpoint.origin,
		auth: { username: "opencode", password },
		timeout: 60_000,
		retries: 0,
	});
	return new ChatService(directory, (input) => {
		if (codePorts().includes(Number(endpoint.port)))
			throw new Error("The Chat port is assigned to Code.");
		return client.generateText(nodecodeModel, input);
	});
}
