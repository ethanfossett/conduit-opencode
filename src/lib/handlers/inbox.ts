// ─── Session Inbox Handlers ──────────────────────────────────────────────────
// Queue-vs-steer delivery for durable session work (v2 Session.Inbox):
//   GET    /api/session/{id}/inbox               → list queued items
//   DELETE /api/session/{id}/inbox/{inboxID}     → cancel an item
//   PATCH  /api/session/{id}/inbox/{inboxID}     → change delivery mode
//
// The composer sends an explicit `delivery` ("steer" = send now, "queue" =
// wait) with each prompt; these handlers expose the resulting queue so the UI
// can show and cancel pending items.

import { formatErrorDetail } from "../errors.js";
import type { V2InboxItem } from "../instance/opencode-client.js";
import type { InboxItemInfo } from "../shared-types.js";
import type { PayloadMap } from "./payloads.js";
import { resolveSession } from "./resolve-session.js";
import type { HandlerDeps } from "./types.js";

/** Normalise a v2 inbox entry to the compact frontend shape. */
export function normalizeInboxItem(item: V2InboxItem): InboxItemInfo {
	const rawText = item.payload?.text;
	return {
		id: item.id,
		type: item.type,
		delivery: item.delivery === "queue" ? "queue" : "steer",
		text: typeof rawText === "string" ? rawText : "",
		...(item.time?.created != null && { createdAt: item.time.created }),
	};
}

/**
 * Fetch and broadcast the inbox for a session to every client viewing it.
 * Best-effort: a failure is logged, never surfaced as a hard error.
 */
async function refreshInbox(
	deps: HandlerDeps,
	clientId: string,
	sessionId: string,
): Promise<void> {
	try {
		const raw = await deps.client.listSessionInbox(sessionId);
		const items = raw.map(normalizeInboxItem);
		const message = { type: "inbox_list" as const, sessionId, items };
		// Send to every viewer of the session, plus the requester directly in
		// case its viewer registration hasn't landed yet (post-switch race).
		deps.wsHandler.sendToSession(sessionId, message);
		deps.wsHandler.sendTo(clientId, message);
	} catch (err) {
		deps.log.warn(
			`client=${clientId} session=${sessionId} Failed to list inbox: ${formatErrorDetail(err)}`,
		);
	}
}

export async function handleListInbox(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["list_inbox"],
): Promise<void> {
	const sessionId = payload.sessionId ?? resolveSession(deps, clientId);
	if (!sessionId) return;
	await refreshInbox(deps, clientId, sessionId);
}

export async function handleCancelInbox(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["cancel_inbox"],
): Promise<void> {
	const sessionId = payload.sessionId ?? resolveSession(deps, clientId);
	if (!sessionId || !payload.inboxId) return;
	try {
		await deps.client.cancelInboxItem(sessionId, payload.inboxId);
	} catch (err) {
		deps.log.warn(
			`client=${clientId} session=${sessionId} Failed to cancel inbox item ${payload.inboxId}: ${formatErrorDetail(err)}`,
		);
	}
	await refreshInbox(deps, clientId, sessionId);
}

export async function handleSetInboxDelivery(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["set_inbox_delivery"],
): Promise<void> {
	const sessionId = payload.sessionId ?? resolveSession(deps, clientId);
	if (!sessionId || !payload.inboxId) return;
	try {
		await deps.client.updateInboxItem(
			sessionId,
			payload.inboxId,
			payload.delivery,
		);
	} catch (err) {
		deps.log.warn(
			`client=${clientId} session=${sessionId} Failed to update inbox item ${payload.inboxId}: ${formatErrorDetail(err)}`,
		);
	}
	await refreshInbox(deps, clientId, sessionId);
}
