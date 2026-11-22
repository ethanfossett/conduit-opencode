// ─── AC7: Version Pinning Validation ──────────────────────────────────────
// Verifies that the pinned OpenCode version (`.opencode-version`) matches the
// running server. v2 exposes reachability via GET /api/location and identity
// (version) via GET /api/info.

import { beforeAll, describe, expect, it } from "vitest";
import {
	checkServerHealth,
	getPinnedVersion,
} from "./helpers/server-connection.js";

describe("AC7 — Version Pinning", () => {
	let serverHealth: { healthy: boolean; version: string } | null = null;
	let pinnedVersion: string;

	beforeAll(async () => {
		pinnedVersion = getPinnedVersion();
		serverHealth = await checkServerHealth();
		if (!serverHealth) {
			console.warn("⚠️  OpenCode server not running — skipping contract tests");
		}
	});

	it("should have a .opencode-version file with a valid semver-like version", () => {
		expect(pinnedVersion).toBeTruthy();
		expect(pinnedVersion).toMatch(/^\d+\.\d+\.\d+/);
	});

	it("should connect to a running OpenCode server", () => {
		if (!serverHealth) {
			console.warn("SKIP: No OpenCode server available");
			return;
		}
		expect(serverHealth.healthy).toBe(true);
		expect(typeof serverHealth.version).toBe("string");
	});

	it("should match the pinned version", () => {
		if (!serverHealth) {
			console.warn("SKIP: No OpenCode server available");
			return;
		}
		if (serverHealth.version !== pinnedVersion) {
			console.warn(
				`⚠️  Version mismatch: server=${serverHealth.version}, pinned=${pinnedVersion}`,
			);
		}
		expect(serverHealth.version).toBe(pinnedVersion);
	});

	it("health probe returns { healthy: boolean, version: string }", () => {
		if (!serverHealth) {
			console.warn("SKIP: No OpenCode server available");
			return;
		}
		expect(serverHealth).toHaveProperty("healthy");
		expect(serverHealth).toHaveProperty("version");
		expect(typeof serverHealth.healthy).toBe("boolean");
		expect(typeof serverHealth.version).toBe("string");
		// Should NOT have the old v1 "ok" field
		expect(serverHealth).not.toHaveProperty("ok");
	});
});
