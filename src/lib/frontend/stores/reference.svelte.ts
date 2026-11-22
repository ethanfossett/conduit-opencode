// ─── Reference Store ─────────────────────────────────────────────────────────
// Server-provided @-mention references (Reference.Info). The server is
// authoritative: the store mirrors `reference_list` sends/broadcasts and
// exposes pure filtering helpers used by the composer's @ menu.

import type {
	PromptFileAttachment,
	ReferenceInfo,
	RelayMessage,
} from "../types.js";

// ─── State ──────────────────────────────────────────────────────────────────

export const referenceState = $state({
	references: [] as ReferenceInfo[],
	/** True once at least one reference_list has been received. */
	loaded: false,
});

// ─── Pure helpers ───────────────────────────────────────────────────────────

/**
 * Filter server references by query string (case-insensitive match on name,
 * path, or description). Limited to 20 results, name matches first.
 */
export function filterReferences(
	references: ReferenceInfo[],
	query: string,
): ReferenceInfo[] {
	if (!query) return references.slice(0, 20);
	const lower = query.toLowerCase();
	const scored: Array<{ ref: ReferenceInfo; nameMatch: boolean }> = [];
	for (const ref of references) {
		const nameMatch = (ref.name ?? "").toLowerCase().includes(lower);
		const pathMatch = (ref.path ?? "").toLowerCase().includes(lower);
		const descMatch = (ref.description ?? "").toLowerCase().includes(lower);
		if (!nameMatch && !pathMatch && !descMatch) continue;
		scored.push({ ref, nameMatch });
	}
	scored.sort((a, b) => {
		if (a.nameMatch !== b.nameMatch) return a.nameMatch ? -1 : 1;
		return (a.ref.name ?? "").localeCompare(b.ref.name ?? "");
	});
	return scored.slice(0, 20).map((s) => s.ref);
}

/**
 * Find the reference a message's `@token` mention refers to. Matches on the
 * reference name first, then on its path (both exact).
 */
export function findReferenceByMention(
	references: ReferenceInfo[],
	token: string,
): ReferenceInfo | undefined {
	if (!token) return undefined;
	return (
		references.find((r) => r.name === token) ??
		references.find((r) => r.path === token)
	);
}

/**
 * Build a `file:` URI for a reference path, suitable for the v2 prompt
 * `files` attachment list (PromptInput.FileAttachment.uri).
 */
export function referenceFileUri(reference: ReferenceInfo): string {
	const path = (reference.path ?? "").replace(/\\/g, "/");
	if (path.startsWith("/")) {
		return `file://${encodeFilePath(path)}`;
	}
	// Relative path — anchor at the file: scheme root (also handles Windows
	// drive letters like C:/…).
	return `file:///${encodeFilePath(path)}`;
}

/** Percent-encode a filesystem path for use inside a file: URI. */
function encodeFilePath(path: string): string {
	return encodeURI(path).replaceAll("#", "%23").replaceAll("?", "%3F");
}

/** Build a prompt file attachment for a reference (uri + display name). */
export function referenceAttachment(reference: ReferenceInfo): {
	uri: string;
	name: string;
} {
	return { uri: referenceFileUri(reference), name: reference.name };
}

/**
 * Locate an `@token` occurrence in `text` at or after `fromIndex`.
 * Returns the mention range plus the index to continue scanning from.
 */
export function findMentionRange(
	text: string,
	token: string,
	fromIndex = 0,
): { start: number; end: number; text: string; nextIndex: number } | undefined {
	const needle = `@${token}`;
	const start = text.indexOf(needle, Math.max(0, fromIndex));
	if (start < 0) return undefined;
	return {
		start,
		end: start + needle.length,
		text: needle,
		nextIndex: start + needle.length,
	};
}

/**
 * Build the prompt attachment for a reference mention: the file URI, display
 * name, and (when the token is present) the mention range for the prompt text.
 */
export function referenceMentionAttachment(
	reference: ReferenceInfo,
	text: string,
	fromIndex = 0,
): { attachment: PromptFileAttachment; nextIndex: number } {
	const base = referenceAttachment(reference);
	const range = findMentionRange(text, reference.name, fromIndex);
	if (!range) {
		return {
			attachment: { uri: base.uri, name: base.name },
			nextIndex: fromIndex,
		};
	}
	return {
		attachment: {
			uri: base.uri,
			name: base.name,
			mention: { start: range.start, end: range.end, text: range.text },
		},
		nextIndex: range.nextIndex,
	};
}

// ─── Message handlers ───────────────────────────────────────────────────────

export function handleReferenceList(
	msg: Extract<RelayMessage, { type: "reference_list" }>,
): void {
	referenceState.references = Array.isArray(msg.references)
		? msg.references.filter((r) => r && typeof r.name === "string")
		: [];
	referenceState.loaded = true;
}

// ─── Actions ────────────────────────────────────────────────────────────────

type SendFn = (data: Record<string, unknown>) => void;

/** Request the current reference catalog. */
export function requestReferences(sendFn: SendFn): void {
	sendFn({ type: "get_references" });
}

export function clearReferenceState(): void {
	referenceState.references = [];
	referenceState.loaded = false;
}
