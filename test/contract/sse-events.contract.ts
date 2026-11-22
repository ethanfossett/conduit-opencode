// ─── AC1: SSE Event Shape Validation (OpenCode v2) ────────────────────────
// v2 exposes a single SSE stream at GET /api/event. Each frame is:
//   data: { id, created, type, location: { directory }, data: {...} }
// Idle keepalives are SSE comment frames (`: ...`). The first event is
// `server.connected`.

import { beforeAll, describe, expect, it } from "vitest";
import { parseSSEDataAuto } from "../../src/lib/relay/sse-backoff.js";
import {
	authHeaders,
	checkServerHealth,
	connectSSE,
	OPENCODE_BASE_URL,
} from "./helpers/server-connection.js";

let serverAvailable = false;

beforeAll(async () => {
	const health = await checkServerHealth();
	serverAvailable = health?.healthy === true;
	if (!serverAvailable) {
		console.warn("⚠️  OpenCode server not running — skipping contract tests");
	}
});

function skipIfNoServer() {
	if (!serverAvailable) {
		console.warn("SKIP: No OpenCode server available");
		return true;
	}
	return false;
}

describe("AC1 — SSE Event Shape Validation (v2)", () => {
	// Pure parsing checks (no server required).
	describe("v2 envelope parsing (offline)", () => {
		it("unwraps { type, data } into { type, properties }", () => {
			const envelope = JSON.stringify({
				id: "evt_1",
				created: 1,
				type: "session.text.delta",
				location: { directory: "/tmp" },
				data: { sessionID: "ses_1", delta: "hi" },
			});
			const parsed = parseSSEDataAuto(envelope);
			expect(parsed.ok).toBe(true);
			expect(parsed.event?.type).toBe("session.text.delta");
			expect(parsed.event?.properties).toEqual({
				sessionID: "ses_1",
				delta: "hi",
			});
		});
	});

	describe("Project event stream (/api/event)", () => {
		it("emits a v2 server.connected event on connection", async () => {
			if (skipIfNoServer()) return;

			const events: Array<{ type: string; data: string }> = [];
			const { controller, ready } = connectSSE("/event", (evt) => {
				events.push(evt);
			});

			await ready;
			await new Promise((r) => setTimeout(r, 1000));
			controller.abort();

			expect(events.length).toBeGreaterThanOrEqual(1);
			// biome-ignore lint/style/noNonNullAssertion: guarded by prior assertion
			const first = JSON.parse(events[0]!.data);
			expect(typeof first.type).toBe("string");
			expect(first.type).toBe("server.connected");
			expect(typeof first.data).toBe("object");
			expect(typeof first.id).toBe("string");
			// `created` and `location` are present on session-scoped events; the
			// connection event may omit them. Validate when present.
			if (first.created !== undefined) {
				expect(typeof first.created).toBe("number");
			}
			if (first.location !== undefined) {
				expect(typeof first.location).toBe("object");
			}
		});

		it("events have { type, data } (plus optional id/created/location)", async () => {
			if (skipIfNoServer()) return;

			const events: Array<{ type: string; data: string }> = [];
			const { controller, ready } = connectSSE("/event", (evt) => {
				events.push(evt);
			});

			await ready;
			await new Promise((r) => setTimeout(r, 1000));
			controller.abort();

			for (const evt of events) {
				const parsed = JSON.parse(evt.data);
				expect(typeof parsed.type).toBe("string");
				expect(typeof parsed.data).toBe("object");
			}
		});
	});

	describe("Event type enumeration", () => {
		it("server.connected has an empty data object", async () => {
			if (skipIfNoServer()) return;

			const events: Array<{ type: string; data: string }> = [];
			const { controller, ready } = connectSSE("/event", (evt) => {
				events.push(evt);
			});

			await ready;
			await new Promise((r) => setTimeout(r, 500));
			controller.abort();

			const connected = events
				.map((e) => JSON.parse(e.data))
				.find((e: { type: string }) => e.type === "server.connected");
			expect(connected).toBeDefined();
			expect(connected.data).toEqual({});
		});
	});

	describe("SSE wire format", () => {
		it("events are delivered as 'data:' lines with valid JSON", async () => {
			if (skipIfNoServer()) return;

			const controller = new AbortController();
			const res = await fetch(`${OPENCODE_BASE_URL}/event`, {
				signal: controller.signal,
				headers: { Accept: "text/event-stream", ...authHeaders() },
			});

			expect(res.ok).toBe(true);
			const contentType = res.headers.get("content-type") ?? "";
			expect(contentType).toContain("text/event-stream");

			// biome-ignore lint/style/noNonNullAssertion: guarded by res.ok
			const reader = res.body!.getReader();
			const { value } = await reader.read();
			controller.abort();

			const text = new TextDecoder().decode(value);
			const dataLines = text.split("\n").filter((l) => l.startsWith("data: "));
			expect(dataLines.length).toBeGreaterThanOrEqual(1);

			for (const line of dataLines) {
				const json = line.slice(6);
				expect(() => JSON.parse(json)).not.toThrow();
			}
		});
	});
});
