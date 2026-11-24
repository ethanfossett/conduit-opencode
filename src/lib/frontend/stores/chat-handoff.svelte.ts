import { draftKey, loadDraft, saveDraft } from "../utils/drafts.js";

interface ChatHandoff {
	project: string;
	text: string;
	requestId?: string;
}

export const chatHandoff = $state<{ pending: ChatHandoff | null }>({
	pending: null,
});

let expiration: ReturnType<typeof setTimeout> | undefined;

export function clearChatHandoff(): void {
	clearTimeout(expiration);
	expiration = undefined;
	chatHandoff.pending = null;
}

export function stageChatHandoff(project: string, text: string): void {
	clearChatHandoff();
	chatHandoff.pending = { project, text };
	expiration = setTimeout(clearChatHandoff, 10 * 60_000);
}

export function recordChatHandoffRequest(
	project: string,
	requestId: string,
): void {
	if (chatHandoff.pending?.project === project) {
		chatHandoff.pending.requestId = requestId;
	}
}

/** Called before the Code composer switches to the new session and loads its draft. */
export function completeChatHandoff(
	project: string | null,
	requestId: string | undefined,
	sessionId: string,
): void {
	const pending = chatHandoff.pending;
	if (
		!project ||
		!requestId ||
		pending?.project !== project ||
		pending.requestId !== requestId
	)
		return;
	const key = draftKey(project, sessionId);
	if (loadDraft(key)) return;
	saveDraft(key, pending.text);
	clearChatHandoff();
}
