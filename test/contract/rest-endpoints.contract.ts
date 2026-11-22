// ─── AC2: REST Endpoint Shape Validation (OpenCode v2) ─────────────────────
// Validates that OpenCode v2's REST API responses match our expected shapes.
// v2 mounts every endpoint under /api/* and wraps responses:
//   • single objects in `{ data }`
//   • module-level lists in `{ location, data }`
//   • `/api/config` and `/api/project` return raw arrays
// Tests check shape (typeof, hasProperty), not content.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	apiGet,
	apiPatch,
	apiPost,
	checkServerHealth,
} from "./helpers/server-connection.js";
import {
	createTestSession,
	deleteTestSession,
	type TestSession,
} from "./helpers/session-helpers.js";

let serverAvailable = false;
let testSession: TestSession | null = null;

beforeAll(async () => {
	const health = await checkServerHealth();
	serverAvailable = health?.healthy === true;
	if (!serverAvailable) {
		console.warn("⚠️  OpenCode server not running — skipping contract tests");
		return;
	}
	testSession = await createTestSession("contract-rest-endpoints");
});

afterAll(async () => {
	if (testSession) {
		await deleteTestSession(testSession.id);
	}
});

function skipIfNoServer() {
	if (!serverAvailable) {
		console.warn("SKIP: No OpenCode server available");
		return true;
	}
	return false;
}

describe("AC2 — REST Endpoint Shape Validation (v2)", () => {
	// ─── Location (health probe) ────────────────────────────────────────────

	describe("GET /api/location", () => {
		it("returns { directory, project }", async () => {
			if (skipIfNoServer()) return;
			const loc = await apiGet<Record<string, unknown>>("/location");
			expect(typeof loc["directory"]).toBe("string");
			const project = loc["project"] as Record<string, unknown>;
			expect(typeof project["id"]).toBe("string");
			expect(typeof project["directory"]).toBe("string");
			expect(typeof project["canonical"]).toBe("string");
		});
	});

	describe("GET /api/info", () => {
		it("returns ServerInfo with version, pid, urls, paths", async () => {
			if (skipIfNoServer()) return;
			const info = await apiGet<Record<string, unknown>>("/info");
			expect(typeof info["version"]).toBe("string");
			expect(typeof info["pid"]).toBe("number");
			expect(Array.isArray(info["urls"])).toBe(true);
			expect(typeof info["paths"]).toBe("object");
		});
	});

	// ─── Sessions ───────────────────────────────────────────────────────────

	describe("GET /api/session", () => {
		it("returns { data: Session.Info[], cursor }", async () => {
			if (skipIfNoServer()) return;
			const res = await apiGet<Record<string, unknown>>("/session");
			expect(Array.isArray(res["data"])).toBe(true);
			expect(res["cursor"]).toBeDefined();
		});

		it("each session has { id, projectID, cost, tokens, time, location }", async () => {
			if (skipIfNoServer()) return;
			const res = await apiGet<{ data: Array<Record<string, unknown>> }>(
				"/session",
			);
			expect(res.data.length).toBeGreaterThanOrEqual(1);
			for (const session of res.data) {
				expect(typeof session["id"]).toBe("string");
				expect(typeof session["projectID"]).toBe("string");
				expect(typeof session["cost"]).toBe("number");
				expect(session["tokens"]).toBeDefined();
				const time = session["time"] as Record<string, unknown>;
				expect(typeof time["created"]).toBe("number");
				expect(typeof time["updated"]).toBe("number");
				const location = session["location"] as Record<string, unknown>;
				expect(typeof location["directory"]).toBe("string");
			}
		});
	});

	describe("POST /api/session", () => {
		let createdId: string | null = null;

		afterAll(async () => {
			if (createdId) await deleteTestSession(createdId);
		});

		it("creates a session and returns { data: Session.Info }", async () => {
			if (skipIfNoServer()) return;
			const res = await apiPost<{ data: Record<string, unknown> }>("/session", {
				title: "contract-test-create",
			});
			const session = res.data;
			expect(typeof session["id"]).toBe("string");
			expect(session["id"]).toBeTruthy();
			createdId = session["id"] as string;
			expect(typeof session["projectID"]).toBe("string");
			expect(session["time"]).toBeDefined();
		});
	});

	describe("GET /api/session/:id", () => {
		it("returns { data: Session.Info }", async () => {
			if (skipIfNoServer() || !testSession) return;
			const res = await apiGet<{ data: Record<string, unknown> }>(
				`/session/${testSession.id}`,
			);
			const session = res.data;
			expect(session["id"]).toBe(testSession.id);
			expect(typeof session["projectID"]).toBe("string");
			expect(session["time"]).toBeDefined();
		});
	});

	describe("PATCH /api/session/:id", () => {
		it("updates session title", async () => {
			if (skipIfNoServer() || !testSession) return;
			await apiPatch(`/session/${testSession.id}`, {
				title: "contract-rest-endpoints-updated",
			});
			const res = await apiGet<{ data: Record<string, unknown> }>(
				`/session/${testSession.id}`,
			);
			expect(res.data["id"]).toBe(testSession.id);
			expect(res.data["title"]).toBe("contract-rest-endpoints-updated");
		});
	});

	describe("GET /api/session/:id/message", () => {
		it("returns { data: Message[], cursor }", async () => {
			if (skipIfNoServer() || !testSession) return;
			const res = await apiGet<Record<string, unknown>>(
				`/session/${testSession.id}/message`,
			);
			expect(Array.isArray(res["data"])).toBe(true);
			expect(res["cursor"]).toBeDefined();
		});
	});

	// ─── Discovery Endpoints ────────────────────────────────────────────────

	describe("GET /api/agent", () => {
		it("returns { location, data: Agent.Info[] }", async () => {
			if (skipIfNoServer()) return;
			const res = await apiGet<{ location: unknown; data: unknown[] }>(
				"/agent",
			);
			expect(res.location).toBeDefined();
			expect(Array.isArray(res.data)).toBe(true);
			expect(res.data.length).toBeGreaterThanOrEqual(1);
			for (const agent of res.data as Array<Record<string, unknown>>) {
				expect(typeof agent["id"]).toBe("string");
				expect(typeof agent["name"]).toBe("string");
				expect(typeof agent["mode"]).toBe("string");
			}
		});
	});

	describe("GET /api/provider", () => {
		it("returns { location, data: Provider.Info[] }", async () => {
			if (skipIfNoServer()) return;
			const res = await apiGet<{ location: unknown; data: unknown[] }>(
				"/provider",
			);
			expect(res.location).toBeDefined();
			expect(Array.isArray(res.data)).toBe(true);
			for (const provider of res.data as Array<Record<string, unknown>>) {
				expect(typeof provider["id"]).toBe("string");
				expect(typeof provider["name"]).toBe("string");
				expect(typeof provider["activation"]).toBe("string");
			}
		});
	});

	describe("GET /api/model", () => {
		it("returns { location, data: Model.Info[] }", async () => {
			if (skipIfNoServer()) return;
			const res = await apiGet<{ location: unknown; data: unknown[] }>(
				"/model",
			);
			expect(res.location).toBeDefined();
			expect(Array.isArray(res.data)).toBe(true);
			for (const model of res.data as Array<Record<string, unknown>>) {
				expect(typeof model["id"]).toBe("string");
				expect(typeof model["providerID"]).toBe("string");
			}
		});
	});

	describe("GET /api/command", () => {
		it("returns { location, data: Command.Info[] }", async () => {
			if (skipIfNoServer()) return;
			const res = await apiGet<{ location: unknown; data: unknown[] }>(
				"/command",
			);
			expect(res.location).toBeDefined();
			expect(Array.isArray(res.data)).toBe(true);
		});
	});

	// ─── Permission & Form (empty state) ────────────────────────────────────

	describe("GET /api/permission/request", () => {
		it("returns { location, data } (empty when none pending)", async () => {
			if (skipIfNoServer()) return;
			const res = await apiGet<{ location: unknown; data: unknown[] }>(
				"/permission/request",
			);
			expect(res.location).toBeDefined();
			expect(Array.isArray(res.data)).toBe(true);
		});
	});

	describe("GET /api/form", () => {
		it("returns { location, data } (empty when none pending)", async () => {
			if (skipIfNoServer()) return;
			const res = await apiGet<{ location: unknown; data: unknown[] }>("/form");
			expect(res.location).toBeDefined();
			expect(Array.isArray(res.data)).toBe(true);
		});
	});

	// ─── Config & Project (raw arrays) ──────────────────────────────────────

	describe("GET /api/config", () => {
		it("returns a raw array of Config.Entry", async () => {
			if (skipIfNoServer()) return;
			const config = await apiGet<unknown>("/config");
			expect(Array.isArray(config)).toBe(true);
		});
	});

	describe("GET /api/project", () => {
		it("returns a raw array of projects", async () => {
			if (skipIfNoServer()) return;
			const projects = await apiGet<unknown>("/project");
			expect(Array.isArray(projects)).toBe(true);
			expect((projects as unknown[]).length).toBeGreaterThanOrEqual(1);
			for (const project of projects as Array<Record<string, unknown>>) {
				expect(typeof project["id"]).toBe("string");
				expect(typeof project["canonical"]).toBe("string");
				expect(project["time"]).toBeDefined();
			}
		});
	});

	// ─── PTY ────────────────────────────────────────────────────────────────

	describe("GET /api/pty", () => {
		it("returns { location, data }", async () => {
			if (skipIfNoServer()) return;
			const res = await apiGet<{ location: unknown; data: unknown[] }>("/pty");
			expect(res.location).toBeDefined();
			expect(Array.isArray(res.data)).toBe(true);
		});
	});

	// ─── VCS ────────────────────────────────────────────────────────────────

	describe("GET /api/vcs", () => {
		it("returns { location, data }", async () => {
			if (skipIfNoServer()) return;
			const res = await apiGet<Record<string, unknown>>("/vcs");
			expect(res["location"]).toBeDefined();
			expect(res["data"]).toBeDefined();
		});
	});

	// ─── Session active (v2 replacement for /session/status) ────────────────

	describe("GET /api/session/active", () => {
		it("returns { data: { <sessionID>: { type: 'running' } } }", async () => {
			if (skipIfNoServer()) return;
			const res = await apiGet<Record<string, unknown>>("/session/active");
			expect(typeof res["data"]).toBe("object");
			expect(res["data"]).not.toBeNull();
			for (const value of Object.values(
				res["data"] as Record<string, { type?: string }>,
			)) {
				expect(value.type).toBe("running");
			}
		});
	});
});
