// ─── AC4: Question/Form Flow Shape Validation (OpenCode v2) ────────────────
// v2 replaces `question` with session-scoped forms:
//   • GET  /api/form                                  → { location, data }
//   • POST /api/session/{sessionID}/form/{formID}/reply  body Form.Reply
//   • DELETE /api/session/{sessionID}/form/{formID}      (cancel)
// `form.created` SSE events carry the full Form.Info.

import { beforeAll, describe, expect, it } from "vitest";
import {
	apiGet,
	checkServerHealth,
	loadOpenApiSnapshot,
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

describe("AC4 — Question/Form Flow Shape Validation (v2)", () => {
	describe("GET /api/form (empty state)", () => {
		it("returns { location, data: [] }", async () => {
			if (skipIfNoServer()) return;
			const res = await apiGet<{ location: unknown; data: unknown[] }>("/form");
			expect(res.location).toBeDefined();
			expect(Array.isArray(res.data)).toBe(true);
		});

		it("data is empty when no forms are pending", async () => {
			if (skipIfNoServer()) return;
			const res = await apiGet<{ data: unknown[] }>("/form");
			expect(res.data.length).toBe(0);
		});
	});

	describe("Form reply endpoint shape (from the v2 snapshot)", () => {
		it("POST /api/session/{sessionID}/form/{formID}/reply exists", () => {
			const spec = loadOpenApiSnapshot();
			const path = "/api/session/{sessionID}/form/{formID}/reply";
			expect(spec.paths).toHaveProperty(path);
			const endpoint = spec.paths[path] as Record<string, unknown>;
			expect(endpoint).toHaveProperty("post");
		});

		it("the reply endpoint has a request body", () => {
			const spec = loadOpenApiSnapshot();
			const post = (
				spec.paths["/api/session/{sessionID}/form/{formID}/reply"] as Record<
					string,
					Record<string, unknown>
				>
			)?.["post"];
			expect(post).toBeDefined();
			expect(post).toHaveProperty("requestBody");
		});
	});

	describe("Form cancel endpoint shape", () => {
		it("DELETE /api/session/{sessionID}/form/{formID} exists", () => {
			const spec = loadOpenApiSnapshot();
			const path = "/api/session/{sessionID}/form/{formID}";
			expect(spec.paths).toHaveProperty(path);
			const endpoint = spec.paths[path] as Record<string, unknown>;
			expect(endpoint).toHaveProperty("delete");
		});
	});

	describe("Form structure from the v2 snapshot", () => {
		it("Form.Info defines id, sessionID, title, fields", () => {
			const spec = loadOpenApiSnapshot();
			const schemas = spec.components?.schemas ?? {};
			expect(schemas).toHaveProperty("Form.Info");
			const info = schemas["Form.Info"] as Record<string, unknown>;
			const props = info["properties"] as Record<string, unknown>;
			for (const key of ["id", "sessionID", "title", "fields"]) {
				expect(props).toHaveProperty(key);
			}
		});

		it("Form.Reply defines an answer payload", () => {
			const spec = loadOpenApiSnapshot();
			const schemas = spec.components?.schemas ?? {};
			expect(schemas).toHaveProperty("Form.Reply");
			const reply = schemas["Form.Reply"] as Record<string, unknown>;
			const props = reply["properties"] as Record<string, unknown>;
			expect(props).toHaveProperty("answer");
		});
	});
});
