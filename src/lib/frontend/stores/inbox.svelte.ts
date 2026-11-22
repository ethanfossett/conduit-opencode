// ─── Session Inbox Store ─────────────────────────────────────────────────────
// Tracks durable enqueued session work (queue-vs-steer). The server's inbox is
// authoritative: the composer shows pending items and can cancel them or flip
// delivery to "steer" (send now). Replaces the old client-side "Queued"
// heuristic that inferred queue state from turn epochs alone.

import type { InboxDelivery, InboxItemInfo, RelayMessage } from "../types.js";
import { sessionState } from "./session.svelte.js";

// ─── State ──────────────────────────────────────────────────────────────────

export const inboxState = $state({
	items: [] as InboxItemInfo[],
	/** Session the current items belong to (null when unknown). */
	sessionId: null as string | null,
});

// ─── Derived getters ────────────────────────────────────────────────────────

/** Queued items only (delivery === "queue"). */
export function getQueuedItems(): InboxItemInfo[] {
	return inboxState.items.filter((i) => i.delivery === "queue");
}

// ─── Message handler ────────────────────────────────────────────────────────

export function handleInboxList(
	msg: Extract<RelayMessage, { type: "inbox_list" }>,
): void {
	// Only track the session currently being viewed; stale sessions' lists are
	// ignored so switching chats never shows another chat's queue.
	if (sessionState.currentId && msg.sessionId !== sessionState.currentId)
		return;
	inboxState.sessionId = msg.sessionId;
	inboxState.items = Array.isArray(msg.items) ? msg.items : [];
}

// ─── Actions ────────────────────────────────────────────────────────────────

type SendFn = (data: Record<string, unknown>) => void;

/** Ask the server for the current session's inbox. */
export function requestInbox(sendFn: SendFn): void {
	if (!sessionState.currentId) return;
	sendFn({ type: "list_inbox", sessionId: sessionState.currentId });
}

/** Cancel a queued item (optimistic removal, then refresh is server-driven). */
export function cancelInboxItem(sendFn: SendFn, inboxId: string): void {
	if (!inboxId) return;
	inboxState.items = inboxState.items.filter((i) => i.id !== inboxId);
	sendFn({
		type: "cancel_inbox",
		inboxId,
		sessionId: sessionState.currentId ?? undefined,
	});
}

/** Change an item's delivery mode (queue → steer = send now). */
export function setInboxDelivery(
	sendFn: SendFn,
	inboxId: string,
	delivery: InboxDelivery,
): void {
	if (!inboxId) return;
	inboxState.items = inboxState.items.map((i) =>
		i.id === inboxId ? { ...i, delivery } : i,
	);
	sendFn({
		type: "set_inbox_delivery",
		inboxId,
		delivery,
		sessionId: sessionState.currentId ?? undefined,
	});
}

/** Clear all inbox state (session switch / disconnect). */
export function clearInboxState(): void {
	inboxState.items = [];
	inboxState.sessionId = null;
}
