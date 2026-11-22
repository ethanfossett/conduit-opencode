// ─── Custom System Prompt Handler ────────────────────────────────────────────
// Per-chat system prompt chosen by the user. Stored per session (in memory +
// persisted to relay settings) and appended to OpenCode's own system prompt on
// every message sent to that chat.

import { saveRelaySettings } from "../relay/relay-settings.js";
import type { PayloadMap } from "./payloads.js";
import { resolveSessionForLog } from "./resolve-session.js";
import type { HandlerDeps } from "./types.js";

export async function handleSetSystemPrompt(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["set_system_prompt"],
): Promise<void> {
	const clientSession =
		payload.sessionId ?? deps.wsHandler.getClientSession(clientId);
	if (!clientSession) {
		deps.log.warn(
			`client=${clientId} set_system_prompt with no session — ignoring`,
		);
		return;
	}

	const text = typeof payload.text === "string" ? payload.text : "";
	deps.overrides.setSystemPrompt(clientSession, text);
	const stored = deps.overrides.getSystemPrompt(clientSession) ?? "";

	// Persist per-session so the prompt survives daemon restarts and only
	// applies to this chat. An empty value removes the entry.
	saveRelaySettings(
		{ sessionSystemPrompts: { [clientSession]: stored } },
		deps.config.configDir,
	);

	// Ack the requesting client directly (the registry association can lag a
	// just-completed session switch), then fan out to other tabs.
	deps.wsHandler.sendTo(clientId, {
		type: "system_prompt_info",
		text: stored,
		sessionId: clientSession,
	});
	deps.wsHandler.sendToSession(clientSession, {
		type: "system_prompt_info",
		text: stored,
	});

	deps.log.info(
		`client=${clientId} session=${resolveSessionForLog(deps, clientId)} System prompt ${stored ? `set (${stored.length} chars)` : "cleared"}`,
	);
}
