// ─── handleMessage → admin store wiring ──────────────────────────────────────
// Verifies that handleMessage() routes the MCP / credential / server-info /
// config-reload messages to their stores. Catches wiring bugs where a case is
// dropped from the switch in ws-dispatch.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Hoisted mocks ──────────────────────────────────────────────────────────

const { showToastMock } = vi.hoisted(() => {
	// WebSocket mock needed by ws.svelte.ts
	class MockWebSocket {
		static readonly OPEN = 1;
		static readonly CLOSED = 3;
		readyState = MockWebSocket.OPEN;
		send(_data: string): void {}
		addEventListener(): void {}
		close(): void {
			this.readyState = MockWebSocket.CLOSED;
		}
	}
	Object.defineProperty(globalThis, "WebSocket", {
		value: MockWebSocket,
		writable: true,
		configurable: true,
	});

	let store: Record<string, string> = {};
	Object.defineProperty(globalThis, "localStorage", {
		value: {
			getItem: (k: string) => store[k] ?? null,
			setItem: (k: string, v: string) => {
				store[k] = v;
			},
			removeItem: (k: string) => {
				delete store[k];
			},
			clear: () => {
				store = {};
			},
			length: 0,
			key: () => null,
		},
		writable: true,
		configurable: true,
	});

	if (typeof globalThis.window === "undefined") {
		Object.defineProperty(globalThis, "window", {
			value: {
				location: { protocol: "http:", host: "localhost:3000", pathname: "/" },
				history: { pushState: () => {}, replaceState: () => {} },
				addEventListener: () => {},
			},
			writable: true,
			configurable: true,
		});
	}

	return { showToastMock: vi.fn() };
});

vi.mock("dompurify", () => ({
	default: { sanitize: (html: string) => html },
}));

vi.mock("../../../src/lib/frontend/stores/ui.svelte.js", () => ({
	showToast: showToastMock,
	showBanner: vi.fn(),
	removeBanner: vi.fn(),
	setClientCount: vi.fn(),
}));

import { credentialState } from "../../../src/lib/frontend/stores/credentials.svelte.js";
import { mcpState } from "../../../src/lib/frontend/stores/mcp.svelte.js";
import { serverInfoState } from "../../../src/lib/frontend/stores/server-info.svelte.js";
import { handleMessage } from "../../../src/lib/frontend/stores/ws.svelte.js";

beforeEach(() => {
	showToastMock.mockClear();
	mcpState.servers = [];
	mcpState.loaded = false;
	credentialState.credentials = [];
	credentialState.loaded = false;
	serverInfoState.info = null;
	serverInfoState.loaded = false;
});

describe("handleMessage admin routing", () => {
	it("routes mcp_list into the MCP store", () => {
		handleMessage({
			type: "mcp_list",
			servers: [{ name: "github", status: { status: "connected" } }],
		});
		expect(mcpState.servers).toHaveLength(1);
		expect(mcpState.loaded).toBe(true);
	});

	it("routes mcp_resources into the MCP store", () => {
		handleMessage({
			type: "mcp_resources",
			resources: [{ server: "fs", name: "a", uri: "file://a" }],
			templates: [],
		});
		expect(mcpState.resources).toHaveLength(1);
	});

	it("routes credential_list into the credential store", () => {
		handleMessage({ type: "credential_list", credentials: [] });
		expect(credentialState.loaded).toBe(true);
	});

	it("routes server_info into the server-info store", () => {
		handleMessage({
			type: "server_info",
			info: { version: "2.0.24", pid: 1, urls: [], paths: { tmp: "/tmp" } },
		});
		expect(serverInfoState.info?.version).toBe("2.0.24");
	});

	it("shows a toast on config_reloaded", () => {
		handleMessage({ type: "config_reloaded", ok: true });
		expect(showToastMock).toHaveBeenCalledWith(
			"Configuration reloaded",
			expect.objectContaining({ variant: "default" }),
		);
	});

	it("routes admin error codes to a toast, not the chat timeline", () => {
		for (const code of [
			"MCP_FAILED",
			"CREDENTIAL_FAILED",
			"SERVER_INFO_FAILED",
			"RELOAD_FAILED",
		]) {
			showToastMock.mockClear();
			handleMessage({ type: "error", code, message: `${code} boom` });
			expect(showToastMock).toHaveBeenCalledWith(`${code} boom`, {
				variant: "warn",
			});
		}
	});
});
