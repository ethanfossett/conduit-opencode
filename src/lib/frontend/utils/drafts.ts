/** Text drafts survive reloads, service restarts and project changes. Storage
 * failures fall back to memory so unavailable browser storage never blocks chat. */
const memory = new Map<string, string>();

export function draftKey(project: string, sessionId: string): string {
	return `conduit.draft.v1:${encodeURIComponent(project)}:${encodeURIComponent(sessionId)}`;
}

export function loadDraft(key: string): string {
	if (memory.has(key)) return memory.get(key) ?? "";
	try {
		return localStorage.getItem(key) ?? "";
	} catch {
		return "";
	}
}

/** Returns false when this draft could only be retained in memory. */
export function saveDraft(key: string, text: string): boolean {
	memory.set(key, text);
	try {
		if (text) localStorage.setItem(key, text);
		else localStorage.removeItem(key);
		return true;
	} catch {
		return false;
	}
}

/** Acceptance can arrive after navigation. Clear the accepted snapshot without
 * erasing newer text authored while the request was in flight. */
export function clearAcceptedDraft(key: string, submittedText: string): void {
	if (loadDraft(key) === submittedText) saveDraft(key, "");
}
