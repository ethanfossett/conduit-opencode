// ─── MCP Handlers ────────────────────────────────────────────────────────────
// Read + runtime management for v2 MCP servers:
//   GET    /api/mcp                                   → list servers + status
//   GET    /api/mcp/resource                          → resource catalog
//   PUT    /api/experimental/mcp/{server}             → add/replace
//   DELETE /api/experimental/mcp/{server}             → remove
//   POST   /api/experimental/mcp/{server}/connect     → connect
//   POST   /api/experimental/mcp/{server}/disconnect  → disconnect
// Every mutation re-lists and broadcasts mcp_list so all clients stay in sync.

import { formatErrorDetail, RelayError } from "../errors.js";
import type { McpServerConfig, McpServerInfo } from "../shared-types.js";
import type { PayloadMap } from "./payloads.js";
import type { HandlerDeps } from "./types.js";

// ─── Config normalisation ────────────────────────────────────────────────────

/** Result of validating a browser-supplied MCP config. */
export type McpConfigResult =
	| { ok: true; config: McpServerConfig }
	| { ok: false; error: string };

/**
 * Validate a browser-supplied McpServerConfig before forwarding it to
 * OpenCode. Only the fields required by the v2 Mcp.*ConfigEncoded schemas are
 * enforced: `type`, plus `command` (local) or `url` (remote).
 */
export function normalizeMcpConfig(config: unknown): McpConfigResult {
	if (typeof config !== "object" || config === null) {
		return { ok: false, error: '"config" must be an object' };
	}
	const c = config as Record<string, unknown>;
	const type = c["type"];
	if (type === "local") {
		const command = c["command"];
		if (
			!Array.isArray(command) ||
			command.length === 0 ||
			!command.every((part) => typeof part === "string" && part.length > 0)
		) {
			return {
				ok: false,
				error: 'local MCP config requires a non-empty "command" array',
			};
		}
		return { ok: true, config: c as unknown as McpServerConfig };
	}
	if (type === "remote") {
		const url = c["url"];
		if (typeof url !== "string" || url.trim().length === 0) {
			return {
				ok: false,
				error: 'remote MCP config requires a non-empty "url"',
			};
		}
		return { ok: true, config: c as unknown as McpServerConfig };
	}
	return {
		ok: false,
		error: '"config.type" must be "local" or "remote"',
	};
}

// ─── Handlers ────────────────────────────────────────────────────────────────

export async function handleListMcp(
	deps: HandlerDeps,
	clientId: string,
	_payload: PayloadMap["list_mcp"],
): Promise<void> {
	try {
		const servers = await deps.client.listMcpServers();
		deps.wsHandler.sendTo(clientId, { type: "mcp_list", servers });
	} catch (err) {
		deps.log.warn(
			`client=${clientId} Failed to list MCP servers: ${formatErrorDetail(err)}`,
		);
		deps.wsHandler.sendTo(clientId, { type: "mcp_list", servers: [] });
	}
}

export async function handleListMcpResources(
	deps: HandlerDeps,
	clientId: string,
	_payload: PayloadMap["list_mcp_resources"],
): Promise<void> {
	try {
		const { resources, templates } = await deps.client.listMcpResources();
		deps.wsHandler.sendTo(clientId, {
			type: "mcp_resources",
			resources,
			templates,
		});
	} catch (err) {
		deps.log.warn(
			`client=${clientId} Failed to list MCP resources: ${formatErrorDetail(err)}`,
		);
		deps.wsHandler.sendTo(clientId, {
			type: "mcp_resources",
			resources: [],
			templates: [],
		});
	}
}

/** Re-list servers after a mutation and broadcast to every client. */
async function broadcastMcpList(deps: HandlerDeps, clientId: string) {
	try {
		const servers: McpServerInfo[] = await deps.client.listMcpServers();
		deps.wsHandler.broadcast({ type: "mcp_list", servers });
	} catch (err) {
		deps.log.warn(
			`client=${clientId} Failed to refresh MCP list: ${formatErrorDetail(err)}`,
		);
	}
}

export async function handleMcpAdd(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["mcp_add"],
): Promise<void> {
	const name = payload.server?.trim();
	if (!name) {
		deps.wsHandler.sendTo(
			clientId,
			new RelayError("mcp_add requires a non-empty 'server' field", {
				code: "INVALID_REQUEST",
			}).toMessage(),
		);
		return;
	}
	const normalized = normalizeMcpConfig(payload.config);
	if (!normalized.ok) {
		deps.wsHandler.sendTo(
			clientId,
			new RelayError(`Invalid MCP config: ${normalized.error}`, {
				code: "INVALID_REQUEST",
			}).toMessage(),
		);
		return;
	}
	try {
		await deps.client.addMcpServer(name, normalized.config);
		await broadcastMcpList(deps, clientId);
	} catch (err) {
		deps.wsHandler.sendTo(
			clientId,
			RelayError.fromCaught(
				err,
				"MCP_FAILED",
				`Failed to add MCP server "${name}"`,
			).toMessage(),
		);
	}
}

export async function handleMcpRemove(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["mcp_remove"],
): Promise<void> {
	const name = payload.server?.trim();
	if (!name) {
		deps.wsHandler.sendTo(
			clientId,
			new RelayError("mcp_remove requires a non-empty 'server' field", {
				code: "INVALID_REQUEST",
			}).toMessage(),
		);
		return;
	}
	try {
		await deps.client.removeMcpServer(name);
		await broadcastMcpList(deps, clientId);
	} catch (err) {
		deps.wsHandler.sendTo(
			clientId,
			RelayError.fromCaught(
				err,
				"MCP_FAILED",
				`Failed to remove MCP server "${name}"`,
			).toMessage(),
		);
	}
}

export async function handleMcpConnect(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["mcp_connect"],
): Promise<void> {
	const name = payload.server?.trim();
	if (!name) {
		deps.wsHandler.sendTo(
			clientId,
			new RelayError("mcp_connect requires a non-empty 'server' field", {
				code: "INVALID_REQUEST",
			}).toMessage(),
		);
		return;
	}
	try {
		await deps.client.connectMcpServer(name);
		await broadcastMcpList(deps, clientId);
	} catch (err) {
		deps.wsHandler.sendTo(
			clientId,
			RelayError.fromCaught(
				err,
				"MCP_FAILED",
				`Failed to connect MCP server "${name}"`,
			).toMessage(),
		);
	}
}

export async function handleMcpDisconnect(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["mcp_disconnect"],
): Promise<void> {
	const name = payload.server?.trim();
	if (!name) {
		deps.wsHandler.sendTo(
			clientId,
			new RelayError("mcp_disconnect requires a non-empty 'server' field", {
				code: "INVALID_REQUEST",
			}).toMessage(),
		);
		return;
	}
	try {
		await deps.client.disconnectMcpServer(name);
		await broadcastMcpList(deps, clientId);
	} catch (err) {
		deps.wsHandler.sendTo(
			clientId,
			RelayError.fromCaught(
				err,
				"MCP_FAILED",
				`Failed to disconnect MCP server "${name}"`,
			).toMessage(),
		);
	}
}
