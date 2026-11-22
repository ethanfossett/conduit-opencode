import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OpenCodeRecording } from "../../e2e/fixtures/recorded/types.js";
import { MockOpenCodeServer } from "../../helpers/mock-opencode-server.js";

// A v2-shaped recording: REST paths carry the `/api` prefix and the recorded
// bodies are the legacy (v1) shapes the mock itself adapts to v2. SSE entries
// are still v1 events; the mock translates them to the v2 envelope + names.
const FIXTURE: OpenCodeRecording = {
	name: "test-fixture",
	recordedAt: new Date().toISOString(),
	opencodeVersion: "2.0.24",
	interactions: [
		{
			kind: "rest",
			method: "GET",
			path: "/api/location",
			status: 200,
			responseBody: { worktree: "/tmp", directory: "/tmp" },
		},
		{
			kind: "rest",
			method: "GET",
			path: "/api/session",
			status: 200,
			responseBody: [
				{
					id: "ses_1",
					title: "One",
					projectID: "p",
					directory: "/tmp",
					time: { created: 1, updated: 1 },
				},
			],
		},
		{
			kind: "rest",
			method: "GET",
			path: "/api/agent",
			status: 200,
			responseBody: [{ name: "build", description: "Main" }],
		},
		{
			kind: "rest",
			method: "POST",
			path: "/api/session",
			status: 200,
			responseBody: {
				id: "ses_2",
				title: "New",
				projectID: "p",
				directory: "/tmp",
				time: { created: 2, updated: 2 },
			},
		},
		{
			kind: "rest",
			method: "GET",
			path: "/api/session",
			status: 200,
			responseBody: [
				{
					id: "ses_1",
					title: "One",
					projectID: "p",
					directory: "/tmp",
					time: { created: 1, updated: 1 },
				},
				{
					id: "ses_2",
					title: "New",
					projectID: "p",
					directory: "/tmp",
					time: { created: 2, updated: 2 },
				},
			],
		},
		{
			kind: "rest",
			method: "DELETE",
			path: "/api/session/ses_2",
			status: 204,
			responseBody: null,
		},
		{
			kind: "rest",
			method: "GET",
			path: "/api/session",
			status: 200,
			responseBody: [
				{
					id: "ses_1",
					title: "One",
					projectID: "p",
					directory: "/tmp",
					time: { created: 1, updated: 1 },
				},
			],
		},
		// prompt fires the SSE batch
		{
			kind: "rest",
			method: "POST",
			path: "/api/session/ses_1/prompt",
			status: 200,
			responseBody: {},
		},
		{
			kind: "sse",
			type: "session.status",
			properties: { sessionID: "ses_1", status: { type: "busy" } },
			delayMs: 0,
		},
		{
			kind: "sse",
			type: "message.part.delta",
			properties: {
				sessionID: "ses_1",
				messageID: "msg_1",
				partID: "prt_1",
				field: "text",
				delta: "hello",
			},
			delayMs: 0,
		},
		{
			kind: "sse",
			type: "session.idle",
			properties: { sessionID: "ses_1" },
			delayMs: 0,
		},
		// A permission reply is *not* a prompt boundary — its SSE events
		// belong to the same segment.
		{
			kind: "rest",
			method: "POST",
			path: "/api/session/ses_1/permission/per_1/reply",
			status: 200,
			responseBody: {},
		},
		{
			kind: "sse",
			type: "message.part.delta",
			properties: {
				sessionID: "ses_1",
				messageID: "msg_1",
				partID: "prt_2",
				field: "text",
				delta: "world",
			},
			delayMs: 0,
		},
		{
			kind: "sse",
			type: "session.idle",
			properties: { sessionID: "ses_1" },
			delayMs: 0,
		},
	],
};

/** Collect SSE envelopes from a streaming fetch response. */
function collectSseEvents(
	reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
	events: Array<{ type: string; data?: Record<string, unknown> }>,
): Promise<void> {
	if (!reader) return Promise.resolve();
	const decoder = new TextDecoder();
	let buffer = "";

	return (async () => {
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					if (line.startsWith("data: ")) {
						events.push(JSON.parse(line.slice(6)));
					}
				}
			}
		} catch {
			// AbortError is expected when controller.abort() is called
		}
	})();
}

describe("MockOpenCodeServer (v2)", () => {
	let mock: MockOpenCodeServer;

	beforeAll(async () => {
		mock = new MockOpenCodeServer(FIXTURE);
		await mock.start();
	});

	afterAll(async () => {
		await mock.stop();
	});

	beforeEach(() => {
		mock.reset();
	});

	it("serves v2 REST envelopes under /api", async () => {
		const r1 = await fetch(`${mock.url}/api/location`);
		expect(r1.status).toBe(200);
		expect(r1.headers.get("content-type")).toContain("application/json");
		const loc = (await r1.json()) as Record<string, unknown>;
		expect(loc["directory"]).toBe("/tmp");
		expect(loc["project"]).toBeDefined();

		const r2 = await fetch(`${mock.url}/api/session`);
		expect(r2.status).toBe(200);
		const list = (await r2.json()) as {
			data: Array<{ id: string }>;
			cursor: unknown;
		};
		expect(Array.isArray(list.data)).toBe(true);
		expect(list.data[0]?.id).toBe("ses_1");
		expect(list.cursor).toBeDefined();
	});

	it("dequeues successive responses for same endpoint", async () => {
		// Drain first GET /api/session
		await fetch(`${mock.url}/api/session`);

		// GET /agent → { location, data }
		const r1 = await fetch(`${mock.url}/api/agent`);
		const agents = (await r1.json()) as {
			location: unknown;
			data: Array<{ id: string; name: string }>;
		};
		expect(agents.location).toBeDefined();
		expect(agents.data[0]).toEqual({
			id: "build",
			name: "build",
			mode: "primary",
			hidden: false,
			request: {},
			permissions: {},
			description: "Main",
		});

		// POST /session → { data }
		const r2 = await fetch(`${mock.url}/api/session`, {
			method: "POST",
			body: "{}",
		});
		const created = (await r2.json()) as {
			data: { id: string; title: string };
		};
		expect(created.data.id).toBe("ses_2");
		expect(created.data.title).toBe("New");

		// Second GET /session (different response than first)
		const r3 = await fetch(`${mock.url}/api/session`);
		const second = (await r3.json()) as { data: Array<{ id: string }> };
		expect(second.data.map((s) => s.id)).toEqual(["ses_1", "ses_2"]);

		// DELETE /session/ses_2
		const r4 = await fetch(`${mock.url}/api/session/ses_2`, {
			method: "DELETE",
		});
		expect(r4.status).toBe(204);
		expect(r4.headers.get("content-type")).toBeNull();

		// Third GET /session (back to just ses_1)
		const r5 = await fetch(`${mock.url}/api/session`);
		const third = (await r5.json()) as { data: Array<{ id: string }> };
		expect(third.data.map((s) => s.id)).toEqual(["ses_1"]);
	});

	it("returns last queued response when queue is exhausted", async () => {
		await fetch(`${mock.url}/api/location`);
		const res = await fetch(`${mock.url}/api/location`);
		expect(res.status).toBe(200);
		const loc = (await res.json()) as Record<string, unknown>;
		expect(loc["directory"]).toBe("/tmp");
	});

	it("matches path parameters (e.g. /session/:id)", async () => {
		await fetch(`${mock.url}/api/session`);
		await fetch(`${mock.url}/api/agent`);
		await fetch(`${mock.url}/api/session`, { method: "POST", body: "{}" });
		await fetch(`${mock.url}/api/session`);

		const res = await fetch(`${mock.url}/api/session/ses_xyz`, {
			method: "DELETE",
		});
		expect(res.status).toBe(204);
	});

	it("streams v2 SSE events after prompt", async () => {
		const controller = new AbortController();
		const sseRes = await fetch(`${mock.url}/api/event`, {
			signal: controller.signal,
			headers: { Accept: "text/event-stream" },
		});
		expect(sseRes.status).toBe(200);

		const events: Array<{ type: string }> = [];
		const collecting = collectSseEvents(sseRes.body?.getReader(), events);

		await fetch(`${mock.url}/api/session/ses_1/prompt`, {
			method: "POST",
			body: "{}",
		});

		await new Promise((r) => setTimeout(r, 200));
		controller.abort();
		await collecting;

		expect(events.map((e) => e.type)).toEqual([
			"session.active",
			"session.text.delta",
			"session.idle",
			"session.text.delta",
			"session.idle",
		]);
	});

	it("wraps SSE events in the v2 envelope", async () => {
		const controller = new AbortController();
		const sseRes = await fetch(`${mock.url}/api/event`, {
			signal: controller.signal,
			headers: { Accept: "text/event-stream" },
		});

		const events: Array<{
			type: string;
			data?: Record<string, unknown>;
			location?: { directory?: string };
		}> = [];
		const collecting = collectSseEvents(sseRes.body?.getReader(), events);

		await fetch(`${mock.url}/api/session/ses_1/prompt`, {
			method: "POST",
			body: "{}",
		});
		await new Promise((r) => setTimeout(r, 200));
		controller.abort();
		await collecting;

		const delta = events.find((e) => e.type === "session.text.delta");
		expect(delta?.data?.["delta"]).toBe("hello");
		expect(delta?.data?.["sessionID"]).toBe("ses_1");
		expect(delta?.location?.directory).toBe(process.cwd());
	});

	it("segments SSE events by prompt boundary for multi-turn", async () => {
		const multiFixture: OpenCodeRecording = {
			name: "multi-turn",
			recordedAt: new Date().toISOString(),
			opencodeVersion: "2.0.24",
			interactions: [
				{
					kind: "rest",
					method: "GET",
					path: "/api/location",
					status: 200,
					responseBody: { directory: "/tmp" },
				},
				{
					kind: "rest",
					method: "GET",
					path: "/api/session",
					status: 200,
					responseBody: [{ id: "ses_1", title: "One", projectID: "p" }],
				},
				{
					kind: "sse",
					type: "session.created",
					properties: { info: { id: "ses_1" } },
					delayMs: 0,
				},
				{
					kind: "rest",
					method: "POST",
					path: "/api/session/ses_1/prompt",
					status: 200,
					responseBody: {},
				},
				{
					kind: "sse",
					type: "message.part.delta",
					properties: { delta: "turn1" },
					delayMs: 0,
				},
				{ kind: "sse", type: "session.idle", properties: {}, delayMs: 0 },
				{
					kind: "rest",
					method: "POST",
					path: "/api/session/ses_1/prompt",
					status: 200,
					responseBody: {},
				},
				{
					kind: "sse",
					type: "message.part.delta",
					properties: { delta: "turn2" },
					delayMs: 0,
				},
				{ kind: "sse", type: "session.idle", properties: {}, delayMs: 0 },
			],
		};

		const multiMock = new MockOpenCodeServer(multiFixture);
		await multiMock.start();

		try {
			const controller = new AbortController();
			const sseRes = await fetch(`${multiMock.url}/api/event`, {
				signal: controller.signal,
				headers: { Accept: "text/event-stream" },
			});
			const events: Array<{ type: string }> = [];
			const collecting = collectSseEvents(sseRes.body?.getReader(), events);

			await fetch(`${multiMock.url}/api/session/ses_1/prompt`, {
				method: "POST",
				body: "{}",
			});
			await new Promise((r) => setTimeout(r, 100));

			expect(events.map((e) => e.type)).toEqual([
				"session.created",
				"session.text.delta",
				"session.idle",
			]);

			await fetch(`${multiMock.url}/api/session/ses_1/prompt`, {
				method: "POST",
				body: "{}",
			});
			await new Promise((r) => setTimeout(r, 100));
			controller.abort();
			await collecting;

			expect(events.map((e) => e.type)).toEqual([
				"session.created",
				"session.text.delta",
				"session.idle",
				"session.text.delta",
				"session.idle",
			]);
		} finally {
			await multiMock.stop();
		}
	});

	it("flushPendingSse emits all segments without requiring a prompt", async () => {
		const controller = new AbortController();
		const sseRes = await fetch(`${mock.url}/api/event`, {
			signal: controller.signal,
			headers: { Accept: "text/event-stream" },
		});
		const events: Array<{ type: string }> = [];
		const collecting = collectSseEvents(sseRes.body?.getReader(), events);

		mock.flushPendingSse();
		await new Promise((r) => setTimeout(r, 200));
		controller.abort();
		await collecting;

		expect(events.length).toBe(5);
	});

	it("reset() re-initializes all queues", async () => {
		await fetch(`${mock.url}/api/location`);
		await fetch(`${mock.url}/api/session`);

		mock.reset();

		const res = await fetch(`${mock.url}/api/location`);
		const loc = (await res.json()) as Record<string, unknown>;
		expect(loc["directory"]).toBe("/tmp");

		const res2 = await fetch(`${mock.url}/api/session`);
		const list = (await res2.json()) as { data: Array<{ id: string }> };
		expect(list.data[0]?.id).toBe("ses_1");
	});
});

it("keeps active-session REST state consistent with replayed completion", async () => {
	const server = new MockOpenCodeServer({
		...FIXTURE,
		interactions: [
			...FIXTURE.interactions,
			{
				kind: "rest",
				method: "GET",
				path: "/api/session/status",
				status: 200,
				responseBody: { ses_lifecycle: { type: "busy" } },
			},
		],
	});
	await server.start();
	try {
		server.injectSSEEvents([
			{ type: "session.active", properties: { sessionID: "ses_lifecycle" } },
		]);
		const active = await fetch(`${server.url}/api/session/active`).then((r) =>
			r.json(),
		);
		expect(active.data.ses_lifecycle).toEqual({ type: "running" });
		server.injectSSEEvents([
			{ type: "session.idle", properties: { sessionID: "ses_lifecycle" } },
		]);
		const idle = await fetch(`${server.url}/api/session/active`).then((r) =>
			r.json(),
		);
		expect(idle.data.ses_lifecycle).toBeUndefined();
	} finally {
		await server.stop();
	}
});
