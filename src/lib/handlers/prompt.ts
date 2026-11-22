// ─── Prompt Handlers ─────────────────────────────────────────────────────────

import { formatErrorDetail, RelayError } from "../errors.js";
import type { PayloadMap } from "./payloads.js";
import { resolveSession } from "./resolve-session.js";
import { withSubmissionReceipt } from "./submission.js";
import type { HandlerDeps, PromptOptions } from "./types.js";

// ─── Per-session input draft store ──────────────────────────────────────────
// Stores the last input_sync text per session so that newly connecting clients
// (e.g. opening on a different device) receive the current draft.

const sessionInputDrafts = new Map<string, string>();

/** Get the stored input draft for a session (empty string if none). */
export function getSessionInputDraft(sessionId: string): string {
	return sessionInputDrafts.get(sessionId) ?? "";
}

/** Clear the stored input draft for a session (e.g. after sending a message). */
export function clearSessionInputDraft(sessionId: string): void {
	sessionInputDrafts.delete(sessionId);
}

async function sendPrompt(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["message"],
): Promise<boolean> {
	const { text, images, files, delivery } = payload;
	const activeId = resolveSession(deps, clientId);
	if (!text && !images?.length && !files?.length) return false;
	if (payload.sessionId && payload.sessionId !== activeId) {
		deps.wsHandler.sendTo(
			clientId,
			new RelayError("The active chat changed. Your message was not sent.", {
				code: "SEND_FAILED",
			}).toMessage(),
		);
		return false;
	}
	if (!activeId) {
		deps.wsHandler.sendTo(
			clientId,
			new RelayError(
				"No active session. Create or switch to a session first.",
				{
					code: "NO_SESSION",
				},
			).toMessage(),
		);
		return false;
	}
	deps.log.info(
		`client=${clientId} session=${activeId} → ${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`,
	);

	// Record user message to cache (identical to claude-relay pattern)
	deps.messageCache.recordEvent(activeId, { type: "user_message", text });

	// Clear the input draft — the user's draft is now a sent message.
	// Without this, the stale draft would be re-applied on reconnect or
	// session switch (session_switched includes inputText from the draft store).
	clearSessionInputDraft(activeId);

	// Record pending user message so SSE echo can be suppressed
	deps.pendingUserMessages.record(activeId, text);

	// Send user_message to OTHER clients viewing this session.
	// The sending client already added the message locally in the frontend,
	// and the SSE echo from OpenCode is suppressed (sse-wiring.ts) to avoid
	// duplicates. But other clients need to see the message immediately.
	const targets = deps.wsHandler.getClientsForSession(activeId);
	for (const targetId of targets) {
		if (targetId !== clientId) {
			deps.wsHandler.sendTo(targetId, { type: "user_message", text });
		}
	}

	// Track message activity for session ordering
	deps.sessionMgr.recordMessageActivity(activeId);

	const prompt: PromptOptions = {
		text,
		...(images && images.length > 0 && { images }),
		...(files && files.length > 0 && { files }),
		...(delivery && { delivery }),
	};
	const sessionAgent = deps.overrides.getAgent(activeId);
	if (sessionAgent) prompt.agent = sessionAgent;
	const sessionModel = deps.overrides.getModel(activeId);
	if (sessionModel && deps.overrides.isModelUserSelected(activeId))
		prompt.model = sessionModel;
	const variant = deps.overrides.getVariant(activeId);
	if (variant) prompt.variant = variant;
	const systemPrompt = deps.overrides.getSystemPrompt(activeId);
	if (systemPrompt) prompt.system = systemPrompt;

	deps.wsHandler.sendToSession(activeId, {
		type: "status",
		status: "processing",
	});
	deps.overrides.startProcessingTimeout(activeId, () => {
		deps.log.warn(
			`client=${clientId} session=${activeId} Processing timeout (120s) — broadcasting done`,
		);
		deps.wsHandler.sendToSession(
			activeId,
			new RelayError(
				"No response received — the model may be unavailable or your usage quota may be exhausted. Try a different model.",
				{ code: "PROCESSING_TIMEOUT" },
			).toMessage(),
		);
		deps.wsHandler.sendToSession(activeId, { type: "done", code: 1 });
	});
	try {
		await deps.client.sendMessageAsync(activeId, prompt);
		return true;
	} catch (sendErr) {
		deps.log.warn(
			`client=${clientId} session=${activeId} Failed to send message:`,
			formatErrorDetail(sendErr),
		);
		// A failed submission must never become durable-looking cached history.
		// Invalidate the derived cache and recover from OpenCode on next load.
		deps.messageCache.remove(activeId);
		deps.pendingUserMessages.consume(activeId, text);
		deps.overrides.clearProcessingTimeout(activeId);
		deps.wsHandler.sendToSession(activeId, { type: "done", code: 1 });
		deps.wsHandler.sendTo(
			clientId,
			RelayError.fromCaught(
				sendErr,
				"SEND_FAILED",
				"Failed to send message",
			).toMessage(),
		);
		return false;
	}
}

export async function handleCancel(
	deps: HandlerDeps,
	clientId: string,
	_payload: PayloadMap["cancel"],
): Promise<void> {
	const activeId = resolveSession(deps, clientId);
	if (activeId) {
		deps.log.info(`client=${clientId} session=${activeId} Aborting`);
		try {
			await deps.client.abortSession(activeId);
		} catch (abortErr) {
			deps.log.warn(
				`client=${clientId} session=${activeId} Abort failed:`,
				formatErrorDetail(abortErr),
			);
			deps.wsHandler.sendTo(
				clientId,
				RelayError.fromCaught(
					abortErr,
					"HANDLER_ERROR",
					"Could not stop this session. Check its status and try again.",
				).toMessage(),
			);
			return;
		}
		deps.overrides.clearProcessingTimeout(activeId);
		deps.wsHandler.sendToSession(activeId, { type: "done", code: 1 });
	}
}

export async function handleRewind(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["rewind"],
): Promise<void> {
	const messageId = payload.messageId ?? payload.uuid ?? "";
	const activeId = resolveSession(deps, clientId);
	if (!messageId || !activeId) return;

	// Map conduit's three rewind modes onto v2's `files` flag:
	//   conversation → files:false (message boundary only)
	//   files / both → files:true  (also revert file changes on disk)
	// Both "files" and "both" apply the file changes; v2 has no separate
	// "files-only" boundary, so they collapse.
	const mode = payload.mode;
	const files =
		payload.files ?? (mode === undefined ? undefined : mode !== "conversation");

	try {
		// v2 revert is a two-step flow: stage the boundary, then commit it.
		if (files === undefined) {
			await deps.client.revertSession(activeId, messageId);
		} else {
			await deps.client.revertSession(activeId, messageId, { files });
		}
		await deps.client.commitRevert?.(activeId);
	} catch (rewindErr) {
		deps.log.warn(
			`client=${clientId} session=${activeId} Rewind failed:`,
			formatErrorDetail(rewindErr),
		);
		deps.wsHandler.sendTo(
			clientId,
			RelayError.fromCaught(
				rewindErr,
				"HANDLER_ERROR",
				"Could not rewind this session. Check its history before retrying.",
			).toMessage(),
		);
		return;
	}

	// Invalidate cache and pagination cursor — revert deletes messages,
	// so the old cursor would point to a non-existent message ID.
	deps.messageCache.remove(activeId);
	deps.sessionMgr.clearPaginationCursor(activeId);
	deps.log.info(
		`client=${clientId} session=${activeId} Reverted to message: ${messageId}`,
	);
}

async function runCommand(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["run_command"],
): Promise<boolean> {
	const name = (payload.name ?? "").trim().replace(/^\//, "");
	const text = payload.text ?? "";
	const activeId = resolveSession(deps, clientId);
	if (payload.sessionId && payload.sessionId !== activeId) {
		deps.wsHandler.sendTo(
			clientId,
			new RelayError("The active chat changed. Your command was not sent.", {
				code: "SEND_FAILED",
			}).toMessage(),
		);
		return false;
	}
	if (!name) return false;
	if (!activeId) {
		deps.wsHandler.sendTo(
			clientId,
			new RelayError(
				"No active session. Create or switch to a session first.",
				{ code: "NO_SESSION" },
			).toMessage(),
		);
		return false;
	}

	const display = `/${name}${text ? ` ${text}` : ""}`;
	deps.log.info(`client=${clientId} session=${activeId} → command ${display}`);

	// Mirror handleMessage's bookkeeping so other tabs see the command and the
	// SSE echo of the resulting user message is suppressed.
	deps.messageCache.recordEvent(activeId, {
		type: "user_message",
		text: display,
	});
	clearSessionInputDraft(activeId);
	deps.pendingUserMessages.record(activeId, display);

	for (const targetId of deps.wsHandler.getClientsForSession(activeId)) {
		if (targetId !== clientId) {
			deps.wsHandler.sendTo(targetId, { type: "user_message", text: display });
		}
	}
	deps.sessionMgr.recordMessageActivity(activeId);

	deps.wsHandler.sendToSession(activeId, {
		type: "status",
		status: "processing",
	});
	deps.overrides.startProcessingTimeout(activeId, () => {
		deps.log.warn(
			`client=${clientId} session=${activeId} Processing timeout (120s) — broadcasting done`,
		);
		deps.wsHandler.sendToSession(
			activeId,
			new RelayError(
				"No response received — the model may be unavailable or your usage quota may be exhausted. Try a different model.",
				{ code: "PROCESSING_TIMEOUT" },
			).toMessage(),
		);
		deps.wsHandler.sendToSession(activeId, { type: "done", code: 1 });
	});

	try {
		await deps.client.runCommand(activeId, {
			name,
			...(text ? { text } : {}),
			...(payload.delivery ? { delivery: payload.delivery } : {}),
		});
		return true;
	} catch (runErr) {
		deps.log.warn(
			`client=${clientId} session=${activeId} Failed to run command:`,
			formatErrorDetail(runErr),
		);
		deps.messageCache.remove(activeId);
		deps.pendingUserMessages.consume(activeId, display);
		deps.overrides.clearProcessingTimeout(activeId);
		deps.wsHandler.sendToSession(activeId, { type: "done", code: 1 });
		deps.wsHandler.sendTo(
			clientId,
			RelayError.fromCaught(
				runErr,
				"SEND_FAILED",
				"Failed to run command",
			).toMessage(),
		);
		return false;
	}
}

export async function handleInputSync(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["input_sync"],
): Promise<void> {
	const senderSession =
		payload.sessionId ?? deps.wsHandler.getClientSession(clientId);
	if (!senderSession) return;

	// Store the draft so newly connecting clients receive it
	if (payload.text) {
		sessionInputDrafts.set(senderSession, payload.text);
	} else {
		sessionInputDrafts.delete(senderSession);
	}

	const targets = deps.wsHandler.getClientsForSession(senderSession);
	for (const targetId of targets) {
		if (targetId !== clientId) {
			deps.wsHandler.sendTo(targetId, {
				type: "input_sync",
				text: payload.text,
				from: clientId,
				sessionId: senderSession,
			});
		}
	}
}

/** Acknowledge upstream acceptance, independently of browser connection lifetime. */
export async function handleMessage(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["message"],
): Promise<void> {
	await withSubmissionReceipt(deps, clientId, payload, "message", () =>
		sendPrompt(deps, clientId, payload),
	);
}

export async function handleRunCommand(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["run_command"],
): Promise<void> {
	await withSubmissionReceipt(deps, clientId, payload, "run_command", () =>
		runCommand(deps, clientId, payload),
	);
}
