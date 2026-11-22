// ─── MCP store ───────────────────────────────────────────────────────────────

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearMcpState,
	connectMcp,
	disconnectMcp,
	handleMcpList,
	handleMcpResources,
	mcpCanConnect,
	mcpCanDisconnect,
	mcpState,
	mcpStatusColor,
	mcpStatusLabel,
	removeMcp,
	requestMcp,
	requestMcpResources,
} from "../../../src/lib/frontend/stores/mcp.svelte.js";
import type {
	McpServerInfo,
	McpServerStatus,
} from "../../../src/lib/shared-types.js";

function server(name: string, status: McpServerStatus): McpServerInfo {
	return { name, status };
}

beforeEach(() => {
	clearMcpState();
});

describe("handleMcpList / handleMcpResources", () => {
	it("stores the server list and marks it loaded", () => {
		handleMcpList({
			type: "mcp_list",
			servers: [server("github", { status: "connected" })],
		});
		expect(mcpState.servers).toHaveLength(1);
		expect(mcpState.loaded).toBe(true);
	});

	it("tolerates a malformed list", () => {
		handleMcpList({ type: "mcp_list", servers: undefined as never });
		expect(mcpState.servers).toEqual([]);
	});

	it("stores the resource catalog", () => {
		handleMcpResources({
			type: "mcp_resources",
			resources: [{ server: "fs", name: "a", uri: "file://a" }],
			templates: [{ server: "fs", name: "t", uriTemplate: "file://{p}" }],
		});
		expect(mcpState.resources).toHaveLength(1);
		expect(mcpState.templates).toHaveLength(1);
	});
});

describe("status helpers", () => {
	it("maps statuses to labels", () => {
		expect(mcpStatusLabel(server("a", { status: "connected" }))).toBe(
			"Connected",
		);
		expect(mcpStatusLabel(server("a", { status: "pending" }))).toBe(
			"Connecting…",
		);
		expect(mcpStatusLabel(server("a", { status: "disabled" }))).toBe(
			"Disabled",
		);
		expect(mcpStatusLabel(server("a", { status: "failed", error: "x" }))).toBe(
			"Failed",
		);
		expect(
			mcpStatusLabel(server("a", { status: "needs_auth", error: "x" })),
		).toBe("Needs auth");
	});

	it("maps statuses to colors", () => {
		expect(mcpStatusColor(server("a", { status: "connected" }))).toBe(
			"bg-success",
		);
		expect(mcpStatusColor(server("a", { status: "failed", error: "x" }))).toBe(
			"bg-error",
		);
	});

	it("gates connect/disconnect affordances", () => {
		expect(mcpCanConnect(server("a", { status: "disabled" }))).toBe(true);
		expect(mcpCanConnect(server("a", { status: "connected" }))).toBe(false);
		expect(mcpCanDisconnect(server("a", { status: "connected" }))).toBe(true);
		expect(mcpCanDisconnect(server("a", { status: "disabled" }))).toBe(false);
	});
});

describe("actions", () => {
	it("requestMcp sends list_mcp", () => {
		const send = vi.fn();
		requestMcp(send);
		expect(send).toHaveBeenCalledWith({ type: "list_mcp" });
	});

	it("requestMcpResources sends list_mcp_resources", () => {
		const send = vi.fn();
		requestMcpResources(send);
		expect(send).toHaveBeenCalledWith({ type: "list_mcp_resources" });
	});

	it("connect/disconnect/remove send the right messages", () => {
		const send = vi.fn();
		connectMcp(send, "github");
		disconnectMcp(send, "github");
		removeMcp(send, "github");
		expect(send).toHaveBeenNthCalledWith(1, {
			type: "mcp_connect",
			server: "github",
		});
		expect(send).toHaveBeenNthCalledWith(2, {
			type: "mcp_disconnect",
			server: "github",
		});
		expect(send).toHaveBeenNthCalledWith(3, {
			type: "mcp_remove",
			server: "github",
		});
	});

	it("ignores blank server names", () => {
		const send = vi.fn();
		connectMcp(send, "");
		disconnectMcp(send, "");
		removeMcp(send, "");
		expect(send).not.toHaveBeenCalled();
	});
});
