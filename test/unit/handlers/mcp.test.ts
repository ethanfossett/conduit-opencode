// ─── MCP handlers ────────────────────────────────────────────────────────────

import { describe, expect, it, vi } from "vitest";
import {
	handleListMcp,
	handleListMcpResources,
	handleMcpAdd,
	handleMcpConnect,
	handleMcpDisconnect,
	handleMcpRemove,
	normalizeMcpConfig,
} from "../../../src/lib/handlers/mcp.js";
import type { McpServerInfo } from "../../../src/lib/shared-types.js";
import { createMockHandlerDeps } from "../../helpers/mock-factories.js";

const SERVERS: McpServerInfo[] = [
	{ name: "github", status: { status: "connected" } },
	{ name: "fs", status: { status: "disabled" } },
];

describe("handleListMcp", () => {
	it("replies with mcp_list", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.listMcpServers).mockResolvedValue(SERVERS);
		await handleListMcp(deps, "client-1", {});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "mcp_list",
			servers: SERVERS,
		});
	});

	it("degrades to an empty list on failure", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.listMcpServers).mockRejectedValue(new Error("boom"));
		await handleListMcp(deps, "client-1", {});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "mcp_list",
			servers: [],
		});
	});
});

describe("handleListMcpResources", () => {
	it("replies with mcp_resources", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.listMcpResources).mockResolvedValue({
			resources: [{ server: "fs", name: "a", uri: "file://a" }],
			templates: [{ server: "fs", name: "t", uriTemplate: "file://{p}" }],
		});
		await handleListMcpResources(deps, "client-1", {});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "mcp_resources",
			resources: [{ server: "fs", name: "a", uri: "file://a" }],
			templates: [{ server: "fs", name: "t", uriTemplate: "file://{p}" }],
		});
	});

	it("degrades to an empty catalog on failure", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.listMcpResources).mockRejectedValue(
			new Error("boom"),
		);
		await handleListMcpResources(deps, "client-1", {});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "mcp_resources",
			resources: [],
			templates: [],
		});
	});
});

describe("handleMcpConnect / handleMcpDisconnect", () => {
	it("connects then broadcasts the refreshed list", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.listMcpServers).mockResolvedValue(SERVERS);
		await handleMcpConnect(deps, "client-1", { server: "github" });
		expect(deps.client.connectMcpServer).toHaveBeenCalledWith("github");
		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith({
			type: "mcp_list",
			servers: SERVERS,
		});
	});

	it("disconnects then broadcasts the refreshed list", async () => {
		const deps = createMockHandlerDeps();
		await handleMcpDisconnect(deps, "client-1", { server: "github" });
		expect(deps.client.disconnectMcpServer).toHaveBeenCalledWith("github");
		expect(deps.wsHandler.broadcast).toHaveBeenCalled();
	});

	it("surfaces an MCP_FAILED error when connect throws", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.connectMcpServer).mockRejectedValue(
			new Error("nope"),
		);
		await handleMcpConnect(deps, "client-1", { server: "github" });
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "error", code: "MCP_FAILED" }),
		);
	});

	it("rejects a blank server name", async () => {
		const deps = createMockHandlerDeps();
		await handleMcpConnect(deps, "client-1", { server: "  " });
		expect(deps.client.connectMcpServer).not.toHaveBeenCalled();
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "error", code: "INVALID_REQUEST" }),
		);
	});
});

describe("handleMcpAdd / handleMcpRemove", () => {
	it("adds a server with its config then broadcasts", async () => {
		const deps = createMockHandlerDeps();
		const config = { type: "remote" as const, url: "https://example.com/mcp" };
		await handleMcpAdd(deps, "client-1", { server: "remote", config });
		expect(deps.client.addMcpServer).toHaveBeenCalledWith("remote", config);
		expect(deps.wsHandler.broadcast).toHaveBeenCalled();
	});

	it("removes a server then broadcasts", async () => {
		const deps = createMockHandlerDeps();
		await handleMcpRemove(deps, "client-1", { server: "remote" });
		expect(deps.client.removeMcpServer).toHaveBeenCalledWith("remote");
		expect(deps.wsHandler.broadcast).toHaveBeenCalled();
	});

	it("surfaces MCP_FAILED when add throws", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.addMcpServer).mockRejectedValue(new Error("nope"));
		await handleMcpAdd(deps, "client-1", {
			server: "remote",
			config: { type: "remote", url: "https://example.com/mcp" },
		});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "error", code: "MCP_FAILED" }),
		);
	});

	it("rejects an invalid config before calling the API", async () => {
		const deps = createMockHandlerDeps();
		await handleMcpAdd(deps, "client-1", {
			server: "bad",
			config: { type: "local", command: [] } as never,
		});
		expect(deps.client.addMcpServer).not.toHaveBeenCalled();
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "error", code: "INVALID_REQUEST" }),
		);
	});
});

describe("normalizeMcpConfig", () => {
	it("accepts a local config with a non-empty command", () => {
		const result = normalizeMcpConfig({
			type: "local",
			command: ["npx", "-y", "server"],
			environment: { A: "1" },
		});
		expect(result.ok).toBe(true);
	});

	it("accepts a remote config with a url", () => {
		const result = normalizeMcpConfig({
			type: "remote",
			url: "https://example.com/mcp",
		});
		expect(result.ok).toBe(true);
	});

	it("rejects non-objects and unknown types", () => {
		expect(normalizeMcpConfig(null).ok).toBe(false);
		expect(normalizeMcpConfig("nope").ok).toBe(false);
		expect(normalizeMcpConfig({ type: "other" }).ok).toBe(false);
	});

	it("rejects empty local commands", () => {
		expect(normalizeMcpConfig({ type: "local", command: [] }).ok).toBe(false);
		expect(normalizeMcpConfig({ type: "local", command: [""] }).ok).toBe(false);
		expect(normalizeMcpConfig({ type: "local" }).ok).toBe(false);
	});

	it("rejects empty remote urls", () => {
		expect(normalizeMcpConfig({ type: "remote", url: "  " }).ok).toBe(false);
		expect(normalizeMcpConfig({ type: "remote" }).ok).toBe(false);
	});
});
