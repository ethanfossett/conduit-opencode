// ─── MCP Store ───────────────────────────────────────────────────────────────
// Tracks configured MCP servers and their status for the Settings panel.
// The server is authoritative: the store mirrors mcp_list / mcp_resources
// broadcasts and exposes connect/disconnect actions over the WebSocket.

import type {
	McpResource,
	McpResourceTemplate,
	McpServerConfig,
	McpServerInfo,
	RelayMessage,
} from "../types.js";

// ─── State ──────────────────────────────────────────────────────────────────

export const mcpState = $state({
	servers: [] as McpServerInfo[],
	resources: [] as McpResource[],
	templates: [] as McpResourceTemplate[],
	/** True once at least one mcp_list has been received. */
	loaded: false,
});

// ─── Derived helpers ────────────────────────────────────────────────────────

/** Human-readable status label for an MCP server. */
export function mcpStatusLabel(server: McpServerInfo): string {
	const s = server.status?.status;
	switch (s) {
		case "connected":
			return "Connected";
		case "pending":
			return "Connecting…";
		case "disabled":
			return "Disabled";
		case "failed":
			return "Failed";
		case "needs_auth":
			return "Needs auth";
		default:
			return "Unknown";
	}
}

/** Tailwind-ish color token class suffix for the status dot. */
export function mcpStatusColor(server: McpServerInfo): string {
	switch (server.status?.status) {
		case "connected":
			return "bg-success";
		case "pending":
			return "bg-amber-400";
		case "failed":
		case "needs_auth":
			return "bg-error";
		default:
			return "bg-text-muted";
	}
}

/** True when the server can be connected at runtime. */
export function mcpCanConnect(server: McpServerInfo): boolean {
	const s = server.status?.status;
	return s === "disabled" || s === "failed" || s === "needs_auth";
}

/** True when the server is currently connected and can be disconnected. */
export function mcpCanDisconnect(server: McpServerInfo): boolean {
	return server.status?.status === "connected";
}

// ─── Message handlers ───────────────────────────────────────────────────────

export function handleMcpList(
	msg: Extract<RelayMessage, { type: "mcp_list" }>,
): void {
	mcpState.servers = Array.isArray(msg.servers) ? msg.servers : [];
	mcpState.loaded = true;
}

export function handleMcpResources(
	msg: Extract<RelayMessage, { type: "mcp_resources" }>,
): void {
	mcpState.resources = Array.isArray(msg.resources) ? msg.resources : [];
	mcpState.templates = Array.isArray(msg.templates) ? msg.templates : [];
}

// ─── Actions ────────────────────────────────────────────────────────────────

type SendFn = (data: Record<string, unknown>) => void;

/** Request the current MCP server list. */
export function requestMcp(sendFn: SendFn): void {
	sendFn({ type: "list_mcp" });
}

/** Request the MCP resource catalog. */
export function requestMcpResources(sendFn: SendFn): void {
	sendFn({ type: "list_mcp_resources" });
}

export function connectMcp(sendFn: SendFn, server: string): void {
	if (!server) return;
	sendFn({ type: "mcp_connect", server });
}

export function disconnectMcp(sendFn: SendFn, server: string): void {
	if (!server) return;
	sendFn({ type: "mcp_disconnect", server });
}

export function removeMcp(sendFn: SendFn, server: string): void {
	if (!server) return;
	sendFn({ type: "mcp_remove", server });
}

/**
 * Add or replace an MCP server (v2 PUT /api/experimental/mcp/{server}).
 * OpenCode connects it immediately; every client gets a refreshed list.
 */
export function addMcp(
	sendFn: SendFn,
	server: string,
	config: McpServerConfig,
): void {
	const name = server?.trim();
	if (!name || !config) return;
	sendFn({ type: "mcp_add", server: name, config });
}

export function clearMcpState(): void {
	mcpState.servers = [];
	mcpState.resources = [];
	mcpState.templates = [];
	mcpState.loaded = false;
}
