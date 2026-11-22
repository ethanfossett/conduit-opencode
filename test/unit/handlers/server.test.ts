// ─── Server info / config reload handlers ────────────────────────────────────

import { describe, expect, it, vi } from "vitest";
import {
	handleGetServerInfo,
	handleReloadConfig,
} from "../../../src/lib/handlers/server.js";
import { createMockHandlerDeps } from "../../helpers/mock-factories.js";

const INFO = {
	version: "2.0.24",
	pid: 1234,
	urls: ["http://localhost:4096"],
	paths: { tmp: "/tmp" },
};

describe("handleGetServerInfo", () => {
	it("replies with server_info", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.getServerInfo).mockResolvedValue(INFO);
		await handleGetServerInfo(deps, "client-1", {});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "server_info",
			info: INFO,
		});
	});

	it("surfaces SERVER_INFO_FAILED on error", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.getServerInfo).mockRejectedValue(new Error("x"));
		await handleGetServerInfo(deps, "client-1", {});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "error", code: "SERVER_INFO_FAILED" }),
		);
	});
});

describe("handleReloadConfig", () => {
	it("reloads and broadcasts config_reloaded", async () => {
		const deps = createMockHandlerDeps();
		await handleReloadConfig(deps, "client-1", {});
		expect(deps.client.reloadConfig).toHaveBeenCalled();
		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith({
			type: "config_reloaded",
			ok: true,
		});
	});

	it("surfaces RELOAD_FAILED on error", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.reloadConfig).mockRejectedValue(new Error("x"));
		await handleReloadConfig(deps, "client-1", {});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "error", code: "RELOAD_FAILED" }),
		);
	});
});
