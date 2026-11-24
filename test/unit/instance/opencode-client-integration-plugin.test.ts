// ─── OpenCodeClient: integration / plugin / reference / prompt files ─────────
// Locks in the v2 endpoints and request shapes used by the new handlers.

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

describe("integration client methods", () => {
	it("listIntegrations GETs /api/integration", async () => {
		const calls = stubFetch(() => ({
			location: { directory: "/x" },
			data: [
				{ id: "anthropic", name: "Anthropic", methods: [], connections: [] },
			],
		}));
		const integrations = await client().listIntegrations();
		expect(calls[0]?.url).toBe(`${BASE}/integration`);
		expect(calls[0]?.method).toBe("GET");
		expect(integrations[0]?.id).toBe("anthropic");
	});

	it("scopes integration discovery and key connection to the project location", async () => {
		const calls = stubFetch(() => ({ data: [] }));
		const scoped = new OpenCodeClient({
			baseUrl: "http://127.0.0.1:4096",
			directory: "/work/My Project",
		});
		await scoped.listIntegrations();
		await scoped.integrationConnectKey("nodecode", { key: "test-key" });
		expect(calls.map(({ url }) => url)).toEqual([
			`${BASE}/integration?location[directory]=%2Fwork%2FMy%20Project`,
			`${BASE}/integration/nodecode/connect/key?location[directory]=%2Fwork%2FMy%20Project`,
		]);
	});

	it("getIntegration GETs one integration", async () => {
		const calls = stubFetch(() => ({
			data: {
				id: "anthropic",
				name: "Anthropic",
				methods: [],
				connections: [],
			},
		}));
		const info = await client().getIntegration("anthropic");
		expect(calls[0]?.url).toBe(`${BASE}/integration/anthropic`);
		expect(info?.name).toBe("Anthropic");
	});

	it("integrationConnectKey POSTs the key body", async () => {
		const calls = stubFetch(() => undefined);
		await client().integrationConnectKey("anthropic", {
			key: "sk-1",
			label: "work",
		});
		expect(calls[0]?.url).toBe(`${BASE}/integration/anthropic/connect/key`);
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.body).toEqual({ key: "sk-1", label: "work" });
	});

	it("integrationConnectOAuth POSTs and returns the attempt", async () => {
		const calls = stubFetch(() => ({
			data: { attemptID: "att-1", url: "https://auth", mode: "auto" },
		}));
		const attempt = await client().integrationConnectOAuth("anthropic", {
			methodID: "claude-pro",
		});
		expect(calls[0]?.url).toBe(`${BASE}/integration/anthropic/connect/oauth`);
		expect(calls[0]?.body).toEqual({ methodID: "claude-pro" });
		expect(attempt.attemptID).toBe("att-1");
	});

	it("integrationOAuthStatus GETs the attempt", async () => {
		const calls = stubFetch(() => ({ data: { status: "pending" } }));
		const status = await client().integrationOAuthStatus("anthropic", "att-1");
		expect(calls[0]?.url).toBe(
			`${BASE}/integration/anthropic/connect/oauth/att-1`,
		);
		expect(status.status).toBe("pending");
	});

	it("integrationOAuthComplete POSTs the code", async () => {
		const calls = stubFetch(() => undefined);
		await client().integrationOAuthComplete("anthropic", "att-1", "123456");
		expect(calls[0]?.url).toBe(
			`${BASE}/integration/anthropic/connect/oauth/att-1/complete`,
		);
		expect(calls[0]?.body).toEqual({ code: "123456" });
	});

	it("integrationCancelOAuth DELETEs the attempt", async () => {
		const calls = stubFetch(() => undefined);
		await client().integrationCancelOAuth("anthropic", "att-1");
		expect(calls[0]?.url).toBe(
			`${BASE}/integration/anthropic/connect/oauth/att-1`,
		);
		expect(calls[0]?.method).toBe("DELETE");
	});

	it("integrationConnectCommand POSTs and returns the attempt", async () => {
		const calls = stubFetch(() => ({ data: { attemptID: "cmd-1" } }));
		const attempt = await client().integrationConnectCommand("github", {
			methodID: "gh-cli",
		});
		expect(calls[0]?.url).toBe(`${BASE}/integration/github/connect/command`);
		expect(calls[0]?.body).toEqual({ methodID: "gh-cli" });
		expect(attempt.attemptID).toBe("cmd-1");
	});

	it("integrationCommandStatus GETs the attempt status", async () => {
		const calls = stubFetch(() => ({ data: { status: "complete" } }));
		const status = await client().integrationCommandStatus("github", "cmd-1");
		expect(calls[0]?.url).toBe(
			`${BASE}/integration/github/connect/command/cmd-1`,
		);
		expect(status.status).toBe("complete");
	});

	it("integrationCancelCommand DELETEs the attempt", async () => {
		const calls = stubFetch(() => undefined);
		await client().integrationCancelCommand("github", "cmd-1");
		expect(calls[0]?.url).toBe(
			`${BASE}/integration/github/connect/command/cmd-1`,
		);
		expect(calls[0]?.method).toBe("DELETE");
	});
});

describe("plugin client methods", () => {
	it("listPlugins GETs /api/plugin", async () => {
		const calls = stubFetch(() => ({
			data: [{ source: { type: "builtin" }, state: { status: "active" } }],
		}));
		const plugins = await client().listPlugins();
		expect(calls[0]?.url).toBe(`${BASE}/plugin`);
		expect(plugins).toHaveLength(1);
	});

	it("checkPlugins POSTs the optional target", async () => {
		const calls = stubFetch(() => ({ data: [] }));
		await client().checkPlugins("example-plugin");
		expect(calls[0]?.url).toBe(`${BASE}/plugin/check`);
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.body).toEqual({ target: "example-plugin" });
	});

	it("checkPlugins omits the target when checking everything", async () => {
		const calls = stubFetch(() => ({ data: [] }));
		await client().checkPlugins();
		expect(calls[0]?.body).toEqual({});
	});

	it("updatePlugins POSTs the target list", async () => {
		const calls = stubFetch(() => undefined);
		await client().updatePlugins(["a", "b"]);
		expect(calls[0]?.url).toBe(`${BASE}/plugin/update`);
		expect(calls[0]?.body).toEqual({ targets: ["a", "b"] });
	});
});

describe("reference client methods", () => {
	it("listReferences GETs /api/reference", async () => {
		const calls = stubFetch(() => ({
			data: [
				{
					name: "opencode",
					path: "/repos/opencode",
					source: { type: "git", repository: "sst/opencode" },
				},
			],
		}));
		const references = await client().listReferences();
		expect(calls[0]?.url).toBe(`${BASE}/reference`);
		expect(references[0]?.name).toBe("opencode");
	});
});

describe("sendMessageAsync file attachments", () => {
	it("sends PromptInput.FileAttachment entries with uri + name", async () => {
		const calls = stubFetch(() => ({}));
		await client().sendMessageAsync("ses_1", {
			text: "see attached",
			files: [
				{ uri: "data:text/plain;base64,aGk=", name: "notes.txt" },
				{ uri: "file:///home/me/docs", name: "docs" },
			],
		});
		const prompt = calls.find((c) => c.url.endsWith("/session/ses_1/prompt"));
		expect(prompt?.body).toEqual({
			text: "see attached",
			files: [
				{ uri: "data:text/plain;base64,aGk=", name: "notes.txt" },
				{ uri: "file:///home/me/docs", name: "docs" },
			],
		});
	});

	it("normalises legacy images into data: URI attachments", async () => {
		const calls = stubFetch(() => ({}));
		await client().sendMessageAsync("ses_1", {
			text: "pic",
			images: ["data:image/jpeg;base64,aGk="],
		});
		const prompt = calls.find((c) => c.url.endsWith("/session/ses_1/prompt"));
		expect(prompt?.body).toEqual({
			text: "pic",
			files: [{ uri: "data:image/jpeg;base64,aGk=", name: "image.jpg" }],
		});
	});

	it("drops malformed file entries without a uri", async () => {
		const calls = stubFetch(() => ({}));
		await client().sendMessageAsync("ses_1", {
			text: "x",
			files: [{ uri: "" }, { uri: "file:///ok" }],
		});
		const prompt = calls.find((c) => c.url.endsWith("/session/ses_1/prompt"));
		expect(prompt?.body).toEqual({
			text: "x",
			files: [{ uri: "file:///ok" }],
		});
	});

	it("deduplicates an image present in both images and files", async () => {
		const calls = stubFetch(() => ({}));
		const uri = "data:image/png;base64,aGk=";
		await client().sendMessageAsync("ses_1", {
			text: "x",
			images: [uri],
			files: [{ uri, name: "screen.png" }],
		});
		const prompt = calls.find((c) => c.url.endsWith("/session/ses_1/prompt"));
		expect(prompt?.body).toEqual({
			text: "x",
			files: [{ uri, name: "image.png" }],
		});
	});

	it("keeps mention metadata on file attachments", async () => {
		const calls = stubFetch(() => ({}));
		await client().sendMessageAsync("ses_1", {
			text: "see @docs",
			files: [
				{
					uri: "file:///docs",
					name: "docs",
					mention: { start: 4, end: 9, text: "@docs" },
				},
			],
		});
		const prompt = calls.find((c) => c.url.endsWith("/session/ses_1/prompt"));
		expect(prompt?.body).toEqual({
			text: "see @docs",
			files: [
				{
					uri: "file:///docs",
					name: "docs",
					mention: { start: 4, end: 9, text: "@docs" },
				},
			],
		});
	});
});
