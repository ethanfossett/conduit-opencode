// ─── Server Info Store ───────────────────────────────────────────────────────
// Tracks the OpenCode server identity/version (GET /api/info) and exposes the
// config-reload action (POST /api/location/reload) for the Settings panel.

import type { RelayMessage, ServerInfo } from "../types.js";

// ─── State ──────────────────────────────────────────────────────────────────

export const serverInfoState = $state({
	info: null as ServerInfo | null,
	/** True once at least one server_info has been received. */
	loaded: false,
});

// ─── Message handlers ───────────────────────────────────────────────────────

export function handleServerInfo(
	msg: Extract<RelayMessage, { type: "server_info" }>,
): void {
	serverInfoState.info = msg.info ?? null;
	serverInfoState.loaded = true;
}

// ─── Actions ────────────────────────────────────────────────────────────────

type SendFn = (data: Record<string, unknown>) => void;

/** Request the OpenCode server identity/version. */
export function requestServerInfo(sendFn: SendFn): void {
	sendFn({ type: "get_server_info" });
}

/** Ask the OpenCode server to reload its configuration. */
export function reloadConfig(sendFn: SendFn): void {
	sendFn({ type: "reload_config" });
}

export function clearServerInfoState(): void {
	serverInfoState.info = null;
	serverInfoState.loaded = false;
}
