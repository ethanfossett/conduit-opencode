// ─── OpenCodeClient: persistent PTY / inbox / skill routes ────────────────────
// Locks in the v2 endpoints used by the relay so a refactor cannot silently
// point at the deprecated ephemeral /pty routes.

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
				...(init?.body != null && {
					body: JSON.parse(init.body as string),
				}),
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

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("persistent PTY client methods", () => {
	it("listSessionTerminals GETs the session-scoped terminal route", async () => {
		const calls = stubFetch(() => ({
			data: [{ id: "pty_1", status: "running" }],
		}));
		const result = await client().listSessionTerminals("ses_1");
		expect(calls[0]?.url).toBe(
			"http://127.0.0.1:4096/api/experimental/session/ses_1/terminal",
		);
		expect(calls[0]?.method).toBe("GET");
		expect(result[0]?.id).toBe("pty_1");
	});

	it("createSessionTerminal POSTs the create input", async () => {
		const calls = stubFetch(() => ({ data: { id: "pty_2" } }));
		await client().createSessionTerminal("ses_1", {
			args: [],
			title: "Terminal",
			env: {},
		});
		expect(calls[0]?.url).toBe(
			"http://127.0.0.1:4096/api/experimental/session/ses_1/terminal",
		);
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.body).toEqual({ args: [], title: "Terminal", env: {} });
	});

	it("includes the controller attachment when resizing", async () => {
		const calls = stubFetch(() => ({ data: { id: "pty_2" } }));
		await client().updatePersistentPty(
			"pty_2",
			{ cols: 100, rows: 30 },
			"attachment-1",
		);
		expect(calls[0]?.body).toEqual({
			size: { cols: 100, rows: 30 },
			attachmentID: "attachment-1",
		});
	});

	it("updatePersistentPty PUTs a size", async () => {
		const calls = stubFetch(() => ({ data: { id: "pty_2" } }));
		await client().updatePersistentPty("pty_2", { cols: 120, rows: 40 });
		expect(calls[0]?.url).toBe(
			"http://127.0.0.1:4096/api/experimental/persistent-pty/pty_2",
		);
		expect(calls[0]?.method).toBe("PUT");
		expect(calls[0]?.body).toEqual({ size: { cols: 120, rows: 40 } });
	});

	it("deletePersistentPty DELETEs the PTY", async () => {
		const calls = stubFetch(() => undefined);
		await client().deletePersistentPty("pty_2");
		expect(calls[0]?.url).toBe(
			"http://127.0.0.1:4096/api/experimental/persistent-pty/pty_2",
		);
		expect(calls[0]?.method).toBe("DELETE");
	});

	it("getPersistentPtySnapshot GETs the snapshot route", async () => {
		const calls = stubFetch(() => ({
			data: {
				info: { id: "pty_2" },
				text: "hi",
				checkpoint: "",
				cursor: { x: 0, y: 0 },
			},
		}));
		const snap = await client().getPersistentPtySnapshot("pty_2");
		expect(calls[0]?.url).toBe(
			"http://127.0.0.1:4096/api/experimental/persistent-pty/pty_2/snapshot",
		);
		expect(snap.text).toBe("hi");
	});

	it("readSessionTerminal GETs the read route with lines", async () => {
		const calls = stubFetch(() => ({ data: null }));
		await client().readSessionTerminal("ses_1", 5);
		expect(calls[0]?.url).toBe(
			"http://127.0.0.1:4096/api/experimental/session/ses_1/terminal/read?lines=5",
		);
	});
});

describe("inbox client methods", () => {
	it("listSessionInbox GETs the inbox route", async () => {
		const calls = stubFetch(() => ({ data: [] }));
		await client().listSessionInbox("ses_1");
		expect(calls[0]?.url).toBe("http://127.0.0.1:4096/api/session/ses_1/inbox");
	});

	it("cancelInboxItem DELETEs the inbox item", async () => {
		const calls = stubFetch(() => undefined);
		await client().cancelInboxItem("ses_1", "msg_1");
		expect(calls[0]?.url).toBe(
			"http://127.0.0.1:4096/api/session/ses_1/inbox/msg_1",
		);
		expect(calls[0]?.method).toBe("DELETE");
	});

	it("updateInboxItem PATCHes the delivery", async () => {
		const calls = stubFetch(() => undefined);
		await client().updateInboxItem("ses_1", "msg_1", "steer");
		expect(calls[0]?.url).toBe(
			"http://127.0.0.1:4096/api/session/ses_1/inbox/msg_1",
		);
		expect(calls[0]?.method).toBe("PATCH");
		expect(calls[0]?.body).toEqual({ delivery: "steer" });
	});
});

describe("skill client methods", () => {
	it("listSkills GETs /skill and normalises Skill.Info", async () => {
		const calls = stubFetch(() => ({
			data: [{ id: "opencode", name: "OpenCode", description: "docs" }],
		}));
		const skills = await client().listSkills("/proj");
		expect(calls[0]?.url).toContain("/api/skill?location[directory]=%2Fproj");
		expect(skills).toEqual([
			{ id: "opencode", name: "OpenCode", description: "docs" },
		]);
	});

	it("activateSkill POSTs to the experimental session-skill route", async () => {
		const calls = stubFetch(() => undefined);
		await client().activateSkill("ses_1", "opencode", { resume: false });
		expect(calls[0]?.url).toBe(
			"http://127.0.0.1:4096/api/experimental/session/ses_1/skill",
		);
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.body).toEqual({ id: "opencode", resume: false });
	});
});

describe("sendMessageAsync delivery", () => {
	it("includes delivery and resume in the prompt body when provided", async () => {
		// First call resolves switchModel/switchAgent; only assert the prompt POST.
		const calls = stubFetch(() => ({ data: {} }));
		await client().sendMessageAsync("ses_1", {
			text: "hi",
			delivery: "queue",
		});
		const prompt = calls.find((c) => c.url.endsWith("/session/ses_1/prompt"));
		expect(prompt?.body).toEqual({ text: "hi", delivery: "queue" });
	});
});
