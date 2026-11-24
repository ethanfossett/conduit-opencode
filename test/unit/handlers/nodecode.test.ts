import { describe, expect, it, vi } from "vitest";
import { handleNodecode } from "../../../src/lib/handlers/nodecode.js";
import { nodecodeModel } from "../../../src/lib/nodecode.js";
import { createMockHandlerDeps } from "../../helpers/mock-factories.js";

function setup() {
	const deps = createMockHandlerDeps();
	deps.client.listIntegrations = vi.fn().mockResolvedValue([
		{
			id: "nodecode",
			methods: [{ type: "key" }],
			connections: [],
		},
	]);
	deps.client.hasConfiguredProvider = vi.fn().mockResolvedValue(true);
	deps.client.generateText = vi.fn().mockResolvedValue("OK");
	vi.mocked(deps.client.listProviders).mockResolvedValue({
		providers: [],
		defaults: {},
		connected: [],
	});
	return deps;
}

function offerModel(deps: ReturnType<typeof setup>) {
	vi.mocked(deps.client.listProviders).mockResolvedValue({
		providers: [
			{
				id: "nodecode",
				name: "NodeCode",
				models: [{ id: nodecodeModel.modelID, name: "Cyber v1" }],
			},
		],
		defaults: {},
		connected: ["nodecode"],
	});
}

describe("NodeCode setup", () => {
	it("reports an unsupported configured server without attempting to save a key", async () => {
		const deps = setup();
		vi.mocked(deps.client.listIntegrations).mockResolvedValue([]);
		await handleNodecode(deps, "client", {
			action: "connect",
			requestId: "check",
			key: "sk-nc-mock",
		});
		expect(deps.client.integrationConnectKey).not.toHaveBeenCalled();
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client",
			expect.objectContaining({
				type: "nodecode_status",
				requestId: "check",
				status: "unsupported",
			}),
		);
	});

	it("checks for a model after storing a key and never automatically sends a paid test", async () => {
		const deps = setup();
		await handleNodecode(deps, "client", {
			action: "connect",
			requestId: "save",
			key: " sk-nc-mock ",
		});
		expect(deps.client.integrationConnectKey).toHaveBeenCalledWith("nodecode", {
			key: "sk-nc-mock",
		});
		expect(deps.client.generateText).not.toHaveBeenCalled();
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client", {
			type: "nodecode_status",
			requestId: "save",
			status: "key_saved",
		});
	});

	it("does not treat a catalog entry as a connected account", async () => {
		const deps = setup();
		offerModel(deps);
		await handleNodecode(deps, "client", {
			action: "status",
			requestId: "status",
		});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client", {
			type: "nodecode_status",
			requestId: "status",
			serverVersion: "2.0.24",
			status: "needs_key",
		});
	});

	it("tests the specific model and reports a reply through OpenCode", async () => {
		const deps = setup();
		offerModel(deps);
		vi.mocked(deps.client.listIntegrations).mockResolvedValue([
			{
				id: "nodecode",
				name: "NodeCode",
				methods: [{ type: "key" }],
				connections: [{ active: true }],
			},
		]);
		await handleNodecode(deps, "client", { action: "test", requestId: "test" });
		expect(deps.client.generateText).toHaveBeenCalledExactlyOnceWith(
			nodecodeModel,
			"Reply with OK.",
		);
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client", {
			type: "nodecode_status",
			requestId: "test",
			status: "test_passed",
		});
	});

	it("keeps provider error bodies and submitted keys out of the browser response", async () => {
		const deps = setup();
		vi.mocked(deps.client.integrationConnectKey).mockRejectedValue(
			new Error("server echoed sk-nc-mock"),
		);
		await handleNodecode(deps, "client", {
			action: "connect",
			requestId: "save",
			key: "sk-nc-mock",
		});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client",
			expect.objectContaining({ status: "error" }),
		);
		expect(
			JSON.stringify(vi.mocked(deps.wsHandler.sendTo).mock.calls),
		).not.toContain("sk-nc-mock");
	});
});
