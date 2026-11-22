// ─── AC5: OpenAPI Spec Snapshot Comparison (OpenCode v2) ──────────────────
// Validates the committed OpenAPI v2 snapshot and verifies the endpoints we
// depend on are present. v2 no longer serves the raw spec from HTTP, so the
// snapshot is the source of truth; when a live server exposes the spec
// (best-effort at /api/doc), a removal diff is also attempted.

import { beforeAll, describe, expect, it } from "vitest";
import {
	checkServerHealth,
	loadOpenApiSnapshot,
} from "./helpers/server-connection.js";

interface OpenAPISpec {
	openapi: string;
	info: { title: string; version: string };
	paths: Record<string, Record<string, unknown>>;
	components?: { schemas?: Record<string, unknown> };
}

let serverAvailable = false;
let liveSpec: OpenAPISpec | null = null;
const snapshotSpec: OpenAPISpec = loadOpenApiSnapshot();

beforeAll(async () => {
	const health = await checkServerHealth();
	serverAvailable = health?.healthy === true;
	if (!serverAvailable) {
		console.warn(
			"⚠️  OpenCode server not running — running snapshot-only checks",
		);
		return;
	}

	// v2 has no guaranteed spec endpoint; probe /doc best-effort.
	try {
		const res = await fetch(
			`${process.env["OPENCODE_URL"] ?? "http://localhost:4096"}/api/doc`,
			{ headers: { Accept: "application/json" } },
		);
		if (res.ok) liveSpec = (await res.json()) as OpenAPISpec;
	} catch {
		liveSpec = null;
	}
});

describe("AC5 — OpenAPI Spec Snapshot Comparison (v2)", () => {
	it("snapshot is a valid OpenAPI 3.1 document", () => {
		expect(snapshotSpec.openapi).toBeDefined();
		expect(snapshotSpec.info).toBeDefined();
		expect(snapshotSpec.paths).toBeDefined();
		expect(snapshotSpec.openapi).toMatch(/^3\.\d+\.\d+$/);
		expect(snapshotSpec.openapi.startsWith("3.1")).toBe(true);
	});

	it("core endpoints we depend on exist (with /api prefix)", () => {
		const requiredEndpoints = [
			"/api/location",
			"/api/info",
			"/api/event",
			"/api/session",
			"/api/session/active",
			"/api/agent",
			"/api/model",
			"/api/provider",
			"/api/command",
			"/api/permission/request",
			"/api/form",
			"/api/config",
			"/api/project",
			"/api/pty",
			"/api/vcs",
		];
		const livePaths = new Set(Object.keys(snapshotSpec.paths));
		const missing = requiredEndpoints.filter((e) => !livePaths.has(e));
		if (missing.length > 0) {
			console.error("❌ Missing required endpoints:", missing);
		}
		expect(missing).toEqual([]);
	});

	it("session sub-endpoints we depend on exist", () => {
		const requiredSessionEndpoints = [
			"/api/session/{sessionID}",
			"/api/session/{sessionID}/message",
			"/api/session/{sessionID}/message/{messageID}",
			"/api/session/{sessionID}/prompt",
			"/api/session/{sessionID}/interrupt",
			"/api/session/{sessionID}/compact",
			"/api/session/{sessionID}/fork",
			"/api/session/{sessionID}/diff",
			"/api/session/{sessionID}/permission/{requestID}/reply",
			"/api/session/{sessionID}/form/{formID}/reply",
		];
		const livePaths = new Set(Object.keys(snapshotSpec.paths));
		const missing = requiredSessionEndpoints.filter((e) => !livePaths.has(e));
		if (missing.length > 0) {
			console.error("❌ Missing required session endpoints:", missing);
		}
		expect(missing).toEqual([]);
	});

	it("permission reply endpoint exists with the session-scoped path pattern", () => {
		expect(snapshotSpec.paths).toHaveProperty(
			"/api/session/{sessionID}/permission/{requestID}/reply",
		);
	});

	it("form reply endpoint exists with the session-scoped path pattern", () => {
		expect(snapshotSpec.paths).toHaveProperty(
			"/api/session/{sessionID}/form/{formID}/reply",
		);
	});

	it("the snapshot defines the core v2 schemas", () => {
		const schemas = Object.keys(snapshotSpec.components?.schemas ?? {});
		const requiredSchemas = [
			"Session.Info",
			"Permission.Request",
			"Form.Info",
			"Location.PublicInfo",
			"ServerInfo",
		];
		const missing = requiredSchemas.filter((s) => !schemas.includes(s));
		if (missing.length > 0) {
			console.error("❌ Missing required schemas:", missing);
		}
		expect(missing).toEqual([]);
	});

	it("live spec (if served) removes no endpoints from the snapshot", () => {
		if (!liveSpec) {
			console.warn("SKIP: live OpenAPI spec not served by this server");
			return;
		}
		const snapshotPaths = Object.keys(snapshotSpec.paths);
		const livePaths = new Set(Object.keys(liveSpec.paths));
		const removed = snapshotPaths.filter((p) => !livePaths.has(p));
		expect(removed).toEqual([]);
	});

	it("live spec (if served) removes no HTTP methods", () => {
		if (!liveSpec) {
			console.warn("SKIP: live OpenAPI spec not served by this server");
			return;
		}
		const removedMethods: string[] = [];
		for (const [path, methods] of Object.entries(snapshotSpec.paths)) {
			const liveMethods = liveSpec.paths[path];
			if (!liveMethods) continue;
			for (const method of Object.keys(methods)) {
				if (method === "parameters") continue;
				if (!(method in liveMethods)) {
					removedMethods.push(`${method.toUpperCase()} ${path}`);
				}
			}
		}
		expect(removedMethods).toEqual([]);
	});

	it("live spec (if served) removes no schema definitions", () => {
		if (!liveSpec) {
			console.warn("SKIP: live OpenAPI spec not served by this server");
			return;
		}
		const snapshotSchemas = Object.keys(snapshotSpec.components?.schemas ?? {});
		const liveSchemas = new Set(
			Object.keys(liveSpec.components?.schemas ?? {}),
		);
		const removed = snapshotSchemas.filter((s) => !liveSchemas.has(s));
		expect(removed).toEqual([]);
	});
});
