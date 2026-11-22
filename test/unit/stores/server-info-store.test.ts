// ─── Server info store ───────────────────────────────────────────────────────

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearServerInfoState,
	handleServerInfo,
	reloadConfig,
	requestServerInfo,
	serverInfoState,
} from "../../../src/lib/frontend/stores/server-info.svelte.js";

const INFO = {
	version: "2.0.24",
	pid: 42,
	urls: ["http://localhost:4096"],
	paths: { tmp: "/tmp" },
};

beforeEach(() => {
	clearServerInfoState();
});

describe("handleServerInfo", () => {
	it("stores the info and marks loaded", () => {
		handleServerInfo({ type: "server_info", info: INFO });
		expect(serverInfoState.info?.version).toBe("2.0.24");
		expect(serverInfoState.loaded).toBe(true);
	});

	it("stores null on a malformed message", () => {
		handleServerInfo({ type: "server_info", info: undefined as never });
		expect(serverInfoState.info).toBeNull();
	});
});

describe("actions", () => {
	it("requestServerInfo sends get_server_info", () => {
		const send = vi.fn();
		requestServerInfo(send);
		expect(send).toHaveBeenCalledWith({ type: "get_server_info" });
	});

	it("reloadConfig sends reload_config", () => {
		const send = vi.fn();
		reloadConfig(send);
		expect(send).toHaveBeenCalledWith({ type: "reload_config" });
	});
});
