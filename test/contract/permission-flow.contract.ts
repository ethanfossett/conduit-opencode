// ─── AC3: Permission Flow Shape Validation (OpenCode v2) ──────────────────
// v2 permissions are session-scoped:
//   • GET  /api/permission/request                       → { location, data }
//   • POST /api/session/{sessionID}/permission/{requestID}/reply
//                                                     body { decision }
// But `permission.asked` SSE events carry the full Permission.Request.

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

describe("AC3 — Permission Flow Shape Validation (v2)", () => {
	describe("GET /api/permission/request (empty state)", () => {
		it("returns { location, data: [] }", async () => {
			if (skipIfNoServer()) return;
			const res = await apiGet<{ location: unknown; data: unknown[] }>(
				"/permission/request",
			);
			expect(res.location).toBeDefined();
			expect(Array.isArray(res.data)).toBe(true);
		});

		it("data is empty when no permissions are pending", async () => {
			if (skipIfNoServer()) return;
			const res = await apiGet<{ data: unknown[] }>("/permission/request");
			expect(res.data.length).toBe(0);
		});
	});

	describe("Permission reply endpoint shape (from the v2 snapshot)", () => {
		it("POST /api/session/{sessionID}/permission/{requestID}/reply exists", () => {
			const spec = loadOpenApiSnapshot();
			const path = "/api/session/{sessionID}/permission/{requestID}/reply";
			expect(spec.paths).toHaveProperty(path);
			const endpoint = spec.paths[path] as Record<string, unknown>;
			expect(endpoint).toHaveProperty("post");
		});

		it("reply endpoint expects a { decision } body", () => {
			const spec = loadOpenApiSnapshot();
			const post = (
				spec.paths[
					"/api/session/{sessionID}/permission/{requestID}/reply"
				] as Record<string, Record<string, unknown>>
			)?.["post"];
			expect(post).toBeDefined();
			expect(post).toHaveProperty("requestBody");
			const body = JSON.stringify(post?.["requestBody"]);
			expect(body).toContain("decision");
		});

		it("Permission.Request schema defines id, sessionID, action, resources", () => {
			const spec = loadOpenApiSnapshot();
			const schemas = spec.components?.schemas ?? {};
			expect(schemas).toHaveProperty("Permission.Request");
			const request = schemas["Permission.Request"] as Record<string, unknown>;
			const props = request["properties"] as Record<string, unknown>;
			for (const key of ["id", "sessionID", "action", "resources"]) {
				expect(props).toHaveProperty(key);
			}
		});

		it("Permission.Reply decision values are once/always/reject", () => {
			const spec = loadOpenApiSnapshot();
			const schemas = spec.components?.schemas ?? {};
			expect(schemas).toHaveProperty("Permission.Reply");
			const reply = schemas["Permission.Reply"] as Record<string, unknown>;
			expect(reply["enum"]).toEqual(["once", "always", "reject"]);
		});
	});

	describe("Permission SSE event shape", () => {
		it("the v2 spec/event catalog covers permission events", () => {
			const spec = loadOpenApiSnapshot();
			const schemas = spec.components?.schemas ?? {};
			const names = Object.keys(schemas);
			const hasPermission = names.some((n) =>
				n.toLowerCase().includes("permission"),
			);
			expect(hasPermission).toBe(true);
		});
	});
});
