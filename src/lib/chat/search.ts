import { randomUUID } from "node:crypto";
import type { ChatSearchResult, ChatSource } from "./types.js";

const SEARCH_LIFETIME = 10 * 60_000;
const MAX_SEARCHES = 40;

export class ChatSearch {
	private readonly pending = new Map<
		string,
		{ result: ChatSearchResult; expiresAt: number; timer: NodeJS.Timeout }
	>();

	constructor(
		private readonly lookup: (query: string) => Promise<ChatSource[]>,
		private readonly readPage: (url: string) => Promise<string>,
	) {}

	async search(chatId: string, query: string): Promise<ChatSearchResult> {
		const sources = await this.lookup(query);
		this.clear(chatId);
		if (this.pending.size >= MAX_SEARCHES) {
			const oldest = this.pending.keys().next().value;
			if (oldest) this.clear(oldest);
		}
		const result = { id: randomUUID(), query, sources };
		this.pending.set(chatId, {
			result,
			expiresAt: Date.now() + SEARCH_LIFETIME,
			timer: setTimeout(() => this.clear(chatId), SEARCH_LIFETIME).unref(),
		});
		return result;
	}

	async read(
		chatId: string,
		searchId: string,
		index: number,
	): Promise<ChatSearchResult | undefined> {
		const result = this.get(chatId, searchId);
		const source = result?.sources[index];
		if (!result || !source) return undefined;
		source.excerpt = await this.readPage(source.url);
		return result;
	}

	get(chatId: string, searchId: string): ChatSearchResult | undefined {
		const stored = this.pending.get(chatId);
		if (!stored) return undefined;
		if (stored.expiresAt <= Date.now()) {
			this.clear(chatId);
			return undefined;
		}
		return stored.result.id === searchId ? stored.result : undefined;
	}

	clear(chatId: string) {
		const stored = this.pending.get(chatId);
		if (stored) clearTimeout(stored.timer);
		this.pending.delete(chatId);
	}
}

export function parseSources(input: unknown): ChatSource[] {
	if (!Array.isArray(input)) throw new TypeError("Expected search results.");
	const sources: ChatSource[] = [];
	for (const item of input.slice(0, 5)) {
		if (!item || typeof item !== "object") continue;
		const { url, title, snippet } = item as Partial<ChatSource>;
		if (
			typeof url !== "string" ||
			url.length > 2048 ||
			typeof title !== "string" ||
			typeof snippet !== "string"
		)
			continue;
		const link = URL.parse(url);
		if (!link || link.protocol !== "https:" || link.username || link.password)
			continue;
		sources.push({
			url: link.href,
			title: title.slice(0, 240),
			snippet: snippet.slice(0, 1200),
		});
	}
	return sources;
}

export function createConfiguredSearch(): ChatSearch | undefined {
	const configured = process.env["CONDUIT_CHAT_SEARCH_URL"];
	const token = process.env["CONDUIT_CHAT_SEARCH_TOKEN"];
	if (!configured || !token || !/^[a-f0-9]{64}$/.test(token)) return undefined;
	const url = URL.parse(configured);
	if (
		!url ||
		url.protocol !== "http:" ||
		url.hostname !== "127.0.0.1" ||
		!url.port ||
		url.pathname !== "/" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		return undefined;
	const origin = url.origin;
	async function workerRequest(path: string, body: unknown) {
		const response = await fetch(new URL(path, origin), {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(23_000),
			redirect: "error",
		});
		if (!response.ok) throw new Error("Search unavailable.");
		const data: unknown = await response.json();
		if (!data || typeof data !== "object")
			throw new Error("Invalid search response.");
		return data;
	}
	return new ChatSearch(
		async (query) => {
			const data = await workerRequest("/search", { query });
			return parseSources("sources" in data ? data.sources : null);
		},
		async (pageUrl) => {
			const data = await workerRequest("/read", { url: pageUrl });
			if (
				!("excerpt" in data) ||
				typeof data.excerpt !== "string" ||
				!data.excerpt
			)
				throw new Error("Invalid excerpt response.");
			return data.excerpt.slice(0, 2400);
		},
	);
}
