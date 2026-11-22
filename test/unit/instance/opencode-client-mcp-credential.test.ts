// ─── OpenCodeClient: MCP / credential / server-info routes ───────────────────
// Locks in the v2 endpoints and request shapes so a refactor cannot silently
// change the paths or bodies used by the relay handlers.

import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeClient } from "../../../src/lib/instance/opencode-client.js";

interface Call {
	url: string;
	method: string;
	body?: unknown;
}

function stubFetch(
	responder: (url: string, method: string) => unknown,
): Call[] {
	const calls: Call[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			calls.push({
				url,
				method,
				...(init?.body != null && { body: JSON.parse(init.body as string) }),
			});
			const data = responder(url, method);
			return {
				ok: true,
				status: 200,
				headers: { get: () => "application/json" },
				json: async () => data,
				text: async () => JSON.stringify(data),
			};
		}),
	);
	return calls;
}

function client() {
	return new OpenCodeClient({
		baseUrl: "http://127.0.0.1:4096",
		auth: { username: "u", password: "p" },
		retries: 0,
	});
}

const BASE = "http://127.0.0.1:4096/api";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("MCP client methods", () => {
	it("listMcpServers GETs /api/mcp", async () => {
		const calls = stubFetch(() => ({
			data: [{ name: "github", status: { status: "connected" } }],
		}));
		const servers = await client().listMcpServers();
		expect(calls[0]?.url).toBe(`${BASE}/mcp`);
		expect(calls[0]?.method).toBe("GET");
		expect(servers[0]?.name).toBe("github");
	});

	it("listMcpResources GETs /api/mcp/resource", async () => {
		const calls = stubFetch(() => ({
			data: { resources: [], templates: [] },
		}));
		const catalog = await client().listMcpResources();
		expect(calls[0]?.url).toBe(`${BASE}/mcp/resource`);
		expect(catalog).toEqual({ resources: [], templates: [] });
	});

	it("addMcpServer PUTs the config to /api/experimental/mcp/{server}", async () => {
		const calls = stubFetch(() => undefined);
		const config = {
			type: "remote" as const,
			url: "https://example.com/mcp",
		};
		await client().addMcpServer("my server", config);
		expect(calls[0]?.url).toBe(`${BASE}/experimental/mcp/my%20server`);
		expect(calls[0]?.method).toBe("PUT");
		expect(calls[0]?.body).toEqual({ config });
	});

	it("removeMcpServer DELETEs the server route", async () => {
		const calls = stubFetch(() => undefined);
		await client().removeMcpServer("github");
		expect(calls[0]?.url).toBe(`${BASE}/experimental/mcp/github`);
		expect(calls[0]?.method).toBe("DELETE");
	});

	it("connect / disconnect POST the runtime routes", async () => {
		const calls = stubFetch(() => undefined);
		await client().connectMcpServer("github");
		await client().disconnectMcpServer("github");
		expect(calls[0]?.url).toBe(`${BASE}/experimental/mcp/github/connect`);
		expect(calls[0]?.method).toBe("POST");
		expect(calls[1]?.url).toBe(`${BASE}/experimental/mcp/github/disconnect`);
		expect(calls[1]?.method).toBe("POST");
	});
});

describe("credential client methods", () => {
	it("listCredentials GETs /api/credential", async () => {
		const calls = stubFetch(() => ({ data: [] }));
		await client().listCredentials();
		expect(calls[0]?.url).toBe(`${BASE}/credential`);
		expect(calls[0]?.method).toBe("GET");
	});

	it("createCredential POSTs the create input", async () => {
		const calls = stubFetch(() => ({
			data: { id: "cred-1", integrationID: "anthropic" },
		}));
		const input = {
			integrationID: "anthropic",
			value: { type: "key" as const, key: "sk-1" },
			activate: true,
		};
		await client().createCredential(input);
		expect(calls[0]?.url).toBe(`${BASE}/credential`);
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.body).toEqual(input);
	});

	it("updateCredential PATCHes the label", async () => {
		const calls = stubFetch(() => undefined);
		await client().updateCredential("cred-1", "Work");
		expect(calls[0]?.url).toBe(`${BASE}/credential/cred-1`);
		expect(calls[0]?.method).toBe("PATCH");
		expect(calls[0]?.body).toEqual({ label: "Work" });
	});

	it("deleteCredential DELETEs the credential", async () => {
		const calls = stubFetch(() => undefined);
		await client().deleteCredential("cred-1");
		expect(calls[0]?.url).toBe(`${BASE}/credential/cred-1`);
		expect(calls[0]?.method).toBe("DELETE");
	});

	it("activateCredential POSTs the activate route", async () => {
		const calls = stubFetch(() => undefined);
		await client().activateCredential("cred-1");
		expect(calls[0]?.url).toBe(`${BASE}/credential/cred-1/activate`);
		expect(calls[0]?.method).toBe("POST");
	});
});

describe("server info / config client methods", () => {
	it("getServerInfo GETs /api/info", async () => {
		const calls = stubFetch(() => ({ version: "2.0.24", pid: 1, urls: [] }));
		const info = await client().getServerInfo();
		expect(calls[0]?.url).toBe(`${BASE}/info`);
		expect(calls[0]?.method).toBe("GET");
		expect(info.version).toBe("2.0.24");
	});

	it("reloadConfig POSTs /api/location/reload", async () => {
		const calls = stubFetch(() => undefined);
		await client().reloadConfig();
		expect(calls[0]?.url).toBe(`${BASE}/location/reload`);
		expect(calls[0]?.method).toBe("POST");
	});

	it("getHealth prefers /api/info and surfaces the version", async () => {
		const calls = stubFetch(() => ({ version: "2.0.24", pid: 1, urls: [] }));
		const health = await client().getHealth();
		expect(calls[0]?.url).toBe(`${BASE}/info`);
		expect(health.ok).toBe(true);
		expect(health.version).toBe("2.0.24");
	});

	it("getHealth falls back to /api/location when /info fails", async () => {
		const calls: Call[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				const method = init?.method ?? "GET";
				calls.push({ url, method });
				if (url.includes("/api/info")) {
					return {
						ok: false,
						status: 503,
						headers: { get: () => "application/json" },
						json: async () => ({}),
						text: async () => "",
					};
				}
				return {
					ok: true,
					status: 200,
					headers: { get: () => "application/json" },
					json: async () => ({ directory: "/x" }),
					text: async () => "{}",
				};
			}),
		);
		const health = await client().getHealth();
		expect(health.ok).toBe(true);
		expect(health.version).toBeUndefined();
		expect(calls.map((c) => c.url)).toEqual([
			`${BASE}/info`,
			`${BASE}/location`,
		]);
	});
});
