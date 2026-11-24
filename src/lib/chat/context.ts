import type {
	ChatContextEntry,
	ChatConversation,
	ChatMessage,
} from "./types.js";

const STOP_WORDS = new Set(
	"about after again also another because before could does first from have just like make more only other should some that their them then there these they this those want were what when where which will with would your".split(
		" ",
	),
);

function terms(text: string) {
	return new Set(
		(
			text
				.slice(0, 12_000)
				.toLowerCase()
				.match(/[\p{L}\p{N}][\p{L}\p{N}-]{3,}/gu) ?? []
		).filter((word) => !STOP_WORDS.has(word)),
	);
}

function hasSources(message: ChatMessage | undefined) {
	return !!(
		message?.documents?.length ||
		message?.attachments?.length ||
		message?.sourceContext ||
		message?.fileCitations?.length
	);
}

export function canRecall(
	chat: ChatConversation,
	index: number,
	through = chat.messages.length,
) {
	const message = chat.messages[index];
	return (
		Number.isInteger(index) &&
		index >= (chat.contextStart ?? 0) &&
		index < through &&
		!!message &&
		!hasSources(message) &&
		!(message.role === "assistant" && hasSources(chat.messages[index - 1]))
	);
}

const BRIEF =
	/^(?:[-*]\s+)?(goal|decision|constraint|open question)\s*:\s*(\S.{0,599})$/i;
const NATURAL_BRIEF =
	/^(?:(?<goal>(?:my|our|the) goal is|i want to|we want to)|(?<decision>let['’]s go with|i decided to|we decided to|we(?:'|’)ll use|use .* instead)|(?<constraint>(?:we|you|it) must|do not|never)|(?<question>(?:the|an) open question is|we still need to decide))\b.{1,570}$/i;
const KIND = {
	goal: "Goal",
	decision: "Decision",
	constraint: "Constraint",
	"open question": "Open question",
} as const;

export function assembleHistory(
	chat: ChatConversation,
	through: number,
	prompt: string,
	latestBytes: number,
	voice = false,
): ChatContextEntry[] {
	const indices = Array.from({ length: through }, (_, index) => index).filter(
		(index) =>
			canRecall(chat, index, through) &&
			!chat.excludedContext?.includes(index) &&
			!(
				chat.messages[index]?.role === "assistant" &&
				chat.excludedContext?.includes(index - 1)
			),
	);
	const pins = new Set(chat.pinnedContext);
	const selected = new Map<number, ChatContextEntry>();
	let budget = Math.max(0, (voice ? 18_000 : 96_000) - latestBytes);
	const recentLimit = voice ? 1_800 : 6_000;
	const recallLimit = voice ? 1_200 : 4_000;
	function add(index: number, kind: ChatContextEntry["kind"], text: string) {
		const role = chat.messages[index]?.role;
		if (!role || !text || selected.has(index)) return;
		const entry = { index, kind, role, text };
		const bytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
		if (bytes > budget) return;
		budget -= bytes;
		selected.set(index, entry);
	}

	// Reserve space for the current exchange and explicit user decisions before retrieval.
	for (const index of indices.slice(-4).reverse()) {
		add(
			index,
			pins.has(index) ? "Pinned" : "Recent",
			(chat.messages[index]?.text ?? "").slice(0, recentLimit),
		);
	}
	for (const index of indices.filter((index) => pins.has(index)).reverse()) {
		add(
			index,
			"Pinned",
			(chat.messages[index]?.text ?? "").slice(0, recallLimit),
		);
	}

	// Derive the brief from eligible source messages on every turn. Edits and
	// exclusions then invalidate entries without syncing a second transcript.
	const found = new Set<string>();
	for (const index of [...indices].reverse()) {
		const message = chat.messages[index];
		if (message?.role !== "user") continue;
		for (const line of message.text.split("\n").slice(0, 24)) {
			const cleaned = line.trim();
			const explicit = BRIEF.exec(cleaned);
			const natural = NATURAL_BRIEF.exec(cleaned)?.groups;
			const label =
				explicit?.[1]?.toLowerCase() ??
				Object.keys(natural ?? {}).find((key) => natural?.[key]);
			if (!label) continue;
			const kind =
				KIND[
					label === "question" ? "open question" : (label as keyof typeof KIND)
				];
			if (!kind || found.has(kind)) continue;
			found.add(kind);
			// Keep recent context and pins at full fidelity. Older brief entries
			// contribute just the source line.
			if (!selected.has(index)) add(index, kind, explicit?.[2] ?? cleaned);
			break;
		}
	}

	const recent = indices.slice(-12);
	const query = terms(prompt);
	const previousUser = [...recent]
		.reverse()
		.find((index) => chat.messages[index]?.role === "user");
	const followup =
		query.size < 3 && previousUser !== undefined
			? terms(chat.messages[previousUser]?.text ?? "")
			: new Set<string>();
	const originalOptions =
		/\b(first|original|earliest) (?:option|plan|approach|proposal|idea)s?\b/i.test(
			prompt,
		);
	const scored = indices
		.slice(0, -12)
		.filter((index) => !selected.has(index))
		.map((index) => {
			let score = 0;
			for (const term of terms(chat.messages[index]?.text ?? "")) {
				if (query.has(term)) score += 3;
				else if (followup.has(term)) score++;
			}
			const option =
				originalOptions &&
				/\b(?:option|approach|proposal|alternatives)\b/i.test(
					chat.messages[index]?.text ?? "",
				);
			return { index, score: score + (option ? 1_000 - index : 0) };
		});
	for (const { index } of scored
		.filter(({ score }) => score > 0)
		.sort((a, b) => b.score - a.score || b.index - a.index)
		.slice(0, 6)) {
		add(
			index,
			"Recalled",
			(chat.messages[index]?.text ?? "").slice(0, recallLimit),
		);
		// Recover the other half of a matching exchange when it is eligible.
		const partner = index + (chat.messages[index]?.role === "user" ? 1 : -1);
		if (indices.includes(partner))
			add(
				partner,
				"Recalled",
				(chat.messages[partner]?.text ?? "").slice(0, recallLimit),
			);
	}
	for (const index of recent.reverse()) {
		add(
			index,
			"Recent",
			(chat.messages[index]?.text ?? "").slice(0, recentLimit),
		);
	}
	return [...selected.values()].sort((a, b) => a.index - b.index);
}
