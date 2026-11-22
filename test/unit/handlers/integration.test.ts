// ─── Integration + plugin handlers ───────────────────────────────────────────

import { describe, expect, it, vi } from "vitest";
import {
	handleCheckPlugins,
	handleIntegrationCancelCommand,
	handleIntegrationCancelOAuth,
	handleIntegrationCommandStatus,
	handleIntegrationConnectCommand,
	handleIntegrationConnectKey,
	handleIntegrationConnectOAuth,
	handleIntegrationOAuthComplete,
	handleIntegrationOAuthStatus,
	handleListIntegrations,
	handleListPlugins,
	handleUpdatePlugins,
} from "../../../src/lib/handlers/integration.js";
import type {
	IntegrationInfo,
	PluginInfo,
} from "../../../src/lib/shared-types.js";
import { createMockHandlerDeps } from "../../helpers/mock-factories.js";

const INTEGRATIONS: IntegrationInfo[] = [
	{
		id: "anthropic",
		name: "Anthropic",
		methods: [{ type: "key" }, { type: "env", names: ["ANTHROPIC_API_KEY"] }],
		connections: [],
	},
];

const PLUGINS: PluginInfo[] = [
	{
		id: "opencode.example",
		source: {
			type: "package",
			target: "some-plugin",
			version: "1.0.0",
			outdated: true,
		},
		state: { status: "active" },
	},
];

describe("handleListIntegrations", () => {
	it("replies with integration_list", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.listIntegrations).mockResolvedValue(INTEGRATIONS);
		await handleListIntegrations(deps, "client-1", {});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "integration_list",
			integrations: INTEGRATIONS,
		});
	});

	it("degrades to an empty list on failure", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.listIntegrations).mockRejectedValue(
			new Error("boom"),
		);
		await handleListIntegrations(deps, "client-1", {});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "integration_list",
			integrations: [],
		});
	});
});

describe("handleIntegrationConnectKey", () => {
	it("connects then broadcasts the refreshed list", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.listIntegrations).mockResolvedValue(INTEGRATIONS);
		await handleIntegrationConnectKey(deps, "client-1", {
			integrationID: "anthropic",
			key: "sk-1",
			label: "work",
		});
		expect(deps.client.integrationConnectKey).toHaveBeenCalledWith(
			"anthropic",
			{
				key: "sk-1",
				label: "work",
			},
		);
		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith({
			type: "integration_list",
			integrations: INTEGRATIONS,
		});
	});

	it("rejects a blank key", async () => {
		const deps = createMockHandlerDeps();
		await handleIntegrationConnectKey(deps, "client-1", {
			integrationID: "anthropic",
			key: "   ",
		});
		expect(deps.client.integrationConnectKey).not.toHaveBeenCalled();
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "error", code: "INVALID_REQUEST" }),
		);
	});

	it("surfaces INTEGRATION_FAILED when connect throws", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.integrationConnectKey).mockRejectedValue(
			new Error("nope"),
		);
		await handleIntegrationConnectKey(deps, "client-1", {
			integrationID: "anthropic",
			key: "sk-1",
		});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "error", code: "INTEGRATION_FAILED" }),
		);
	});
});

describe("OAuth attempts", () => {
	it("starting an OAuth attempt replies with integration_attempt(started)", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.integrationConnectOAuth).mockResolvedValue({
			attemptID: "att-1",
			url: "https://auth.example.com",
			instructions: "Follow the link",
		});
		await handleIntegrationConnectOAuth(deps, "client-1", {
			integrationID: "anthropic",
			methodID: "claude-pro",
		});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "integration_attempt",
			integrationID: "anthropic",
			attemptID: "att-1",
			kind: "oauth",
			phase: "started",
			url: "https://auth.example.com",
			instructions: "Follow the link",
		});
	});

	it("polling pending keeps the attempt alive without refreshing the list", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.integrationOAuthStatus).mockResolvedValue({
			status: "pending",
		});
		await handleIntegrationOAuthStatus(deps, "client-1", {
			integrationID: "anthropic",
			attemptID: "att-1",
		});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "integration_attempt",
			integrationID: "anthropic",
			attemptID: "att-1",
			kind: "oauth",
			phase: "pending",
		});
		expect(deps.wsHandler.broadcast).not.toHaveBeenCalled();
	});

	it("polling complete refreshes the integration list", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.integrationOAuthStatus).mockResolvedValue({
			status: "complete",
		});
		await handleIntegrationOAuthStatus(deps, "client-1", {
			integrationID: "anthropic",
			attemptID: "att-1",
		});
		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({ type: "integration_list" }),
		);
	});

	it("completing with a code posts it and refreshes the list", async () => {
		const deps = createMockHandlerDeps();
		await handleIntegrationOAuthComplete(deps, "client-1", {
			integrationID: "anthropic",
			attemptID: "att-1",
			code: "123456",
		});
		expect(deps.client.integrationOAuthComplete).toHaveBeenCalledWith(
			"anthropic",
			"att-1",
			"123456",
		);
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ phase: "complete" }),
		);
	});

	it("cancelling an OAuth attempt replies with phase cancelled", async () => {
		const deps = createMockHandlerDeps();
		await handleIntegrationCancelOAuth(deps, "client-1", {
			integrationID: "anthropic",
			attemptID: "att-1",
		});
		expect(deps.client.integrationCancelOAuth).toHaveBeenCalledWith(
			"anthropic",
			"att-1",
		);
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ phase: "cancelled", kind: "oauth" }),
		);
	});
});

describe("command attempts", () => {
	it("starting replies with integration_attempt(started)", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.integrationConnectCommand).mockResolvedValue({
			attemptID: "cmd-1",
			url: "https://example.com",
		});
		await handleIntegrationConnectCommand(deps, "client-1", {
			integrationID: "github",
			methodID: "gh-cli",
		});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "integration_attempt",
			integrationID: "github",
			attemptID: "cmd-1",
			kind: "command",
			phase: "started",
			url: "https://example.com",
		});
	});

	it("polling a failed attempt surfaces the message and refreshes", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.integrationCommandStatus).mockResolvedValue({
			status: "failed",
			message: "command exited 1",
		});
		await handleIntegrationCommandStatus(deps, "client-1", {
			integrationID: "github",
			attemptID: "cmd-1",
		});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "integration_attempt",
			integrationID: "github",
			attemptID: "cmd-1",
			kind: "command",
			phase: "failed",
			message: "command exited 1",
		});
		expect(deps.wsHandler.broadcast).toHaveBeenCalled();
	});

	it("cancelling replies with phase cancelled", async () => {
		const deps = createMockHandlerDeps();
		await handleIntegrationCancelCommand(deps, "client-1", {
			integrationID: "github",
			attemptID: "cmd-1",
		});
		expect(deps.client.integrationCancelCommand).toHaveBeenCalledWith(
			"github",
			"cmd-1",
		);
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ phase: "cancelled", kind: "command" }),
		);
	});
});

describe("plugins", () => {
	it("handleListPlugins replies with plugin_list", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.listPlugins).mockResolvedValue(PLUGINS);
		await handleListPlugins(deps, "client-1", {});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "plugin_list",
			plugins: PLUGINS,
		});
	});

	it("handleCheckPlugins forwards the target and replies with a refreshed list", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.checkPlugins).mockResolvedValue(PLUGINS);
		await handleCheckPlugins(deps, "client-1", { target: "some-plugin" });
		expect(deps.client.checkPlugins).toHaveBeenCalledWith("some-plugin");
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "plugin_list",
			plugins: PLUGINS,
		});
	});

	it("handleCheckPlugins surfaces PLUGIN_FAILED", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.checkPlugins).mockRejectedValue(new Error("boom"));
		await handleCheckPlugins(deps, "client-1", {});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "error", code: "PLUGIN_FAILED" }),
		);
	});

	it("handleUpdatePlugins updates, broadcasts, and acks", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.listPlugins).mockResolvedValue(PLUGINS);
		await handleUpdatePlugins(deps, "client-1", { targets: ["some-plugin"] });
		expect(deps.client.updatePlugins).toHaveBeenCalledWith(["some-plugin"]);
		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith({
			type: "plugin_list",
			plugins: PLUGINS,
		});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "plugin_updated",
			targets: ["some-plugin"],
			ok: true,
		});
	});

	it("handleUpdatePlugins reports failure via plugin_updated(ok:false)", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.updatePlugins).mockRejectedValue(new Error("nope"));
		await handleUpdatePlugins(deps, "client-1", { targets: ["some-plugin"] });
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({
				type: "plugin_updated",
				ok: false,
				targets: ["some-plugin"],
			}),
		);
	});

	it("handleUpdatePlugins rejects an empty target list", async () => {
		const deps = createMockHandlerDeps();
		await handleUpdatePlugins(deps, "client-1", { targets: [] });
		expect(deps.client.updatePlugins).not.toHaveBeenCalled();
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "error", code: "INVALID_REQUEST" }),
		);
	});
});
