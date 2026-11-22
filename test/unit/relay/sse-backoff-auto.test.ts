// ─── Unit Tests: parseSSEDataAuto (v2 envelope) ──────────────────────────────
// The OpenCode v2 `/api/event` endpoint wraps each event in an envelope:
//   { id, created, type, location?, data }
// parseSSEDataAuto unwraps `data` into conduit's `{ type, properties }` shape.

import { describe, expect, it } from "vitest";
import { parseSSEDataAuto } from "../../../src/lib/relay/sse-backoff.js";

// ─── v2 envelope ────────────────────────────────────────────────────────────

describe("parseSSEDataAuto — v2 envelope", () => {
	it("unwraps type + data into { type, properties }", () => {
		const raw = JSON.stringify({
			id: "evt_1",
			created: 123,
			type: "session.text.delta",
			location: { directory: "/home/user/project" },
			data: { sessionID: "s1", assistantMessageID: "m1", delta: "Hello" },
		});
		const result = parseSSEDataAuto(raw);
		expect(result.ok).toBe(true);
		expect(result.event).toEqual({
			type: "session.text.delta",
			properties: { sessionID: "s1", assistantMessageID: "m1", delta: "Hello" },
		});
	});

	it("parses server.connected with empty data", () => {
		const raw = JSON.stringify({
			id: "evt_2",
			type: "server.connected",
			data: {},
		});
		const result = parseSSEDataAuto(raw);
		expect(result.ok).toBe(true);
		expect(result.event).toEqual({
			type: "server.connected",
			properties: {},
		});
	});

	it("normalizes missing data to an empty object", () => {
		const raw = JSON.stringify({ id: "evt_3", type: "server.connected" });
		const result = parseSSEDataAuto(raw);
		expect(result.ok).toBe(true);
		// biome-ignore lint/style/noNonNullAssertion: guarded by ok
		expect(result.event!.properties).toEqual({});
	});

	it("normalizes non-object data to an empty object", () => {
		const raw = JSON.stringify({ type: "session.idle", data: "nope" });
		const result = parseSSEDataAuto(raw);
		expect(result.ok).toBe(true);
		// biome-ignore lint/style/noNonNullAssertion: guarded by ok
		expect(result.event!.properties).toEqual({});
	});

	it("unwraps a permission.asked envelope", () => {
		const raw = JSON.stringify({
			type: "permission.asked",
			data: { id: "per_1", sessionID: "s1", action: "bash", resources: ["*"] },
		});
		const result = parseSSEDataAuto(raw);
		expect(result.ok).toBe(true);
		// biome-ignore lint/style/noNonNullAssertion: guarded by ok
		expect(result.event!.type).toBe("permission.asked");
		// biome-ignore lint/style/noNonNullAssertion: guarded by ok
		expect(result.event!.properties).toEqual({
			id: "per_1",
			sessionID: "s1",
			action: "bash",
			resources: ["*"],
		});
	});
});

// ─── Error cases ────────────────────────────────────────────────────────────

describe("parseSSEDataAuto — error cases", () => {
	it("returns error for empty string", () => {
		expect(parseSSEDataAuto("").ok).toBe(false);
	});
	it("returns error for whitespace-only string", () => {
		expect(parseSSEDataAuto("   ").ok).toBe(false);
	});
	it("returns error for invalid JSON", () => {
		const result = parseSSEDataAuto("{not json}");
		expect(result.ok).toBe(false);
		expect(result.error).toContain("JSON parse error");
	});
	it("returns error for array", () => {
		expect(parseSSEDataAuto("[1, 2]").ok).toBe(false);
	});
	it("returns error for null", () => {
		expect(parseSSEDataAuto("null").ok).toBe(false);
	});
	it("returns error for primitive", () => {
		expect(parseSSEDataAuto('"hello"').ok).toBe(false);
	});
	it("returns error when type is missing", () => {
		const result = parseSSEDataAuto(JSON.stringify({ id: "evt_1", data: {} }));
		expect(result.ok).toBe(false);
		expect(result.error).toContain("unrecognized");
	});
	it("returns error when type is not a string", () => {
		expect(parseSSEDataAuto(JSON.stringify({ type: 42 })).ok).toBe(false);
	});
	it("never throws on arbitrary input", () => {
		const inputs = [
			undefined as unknown as string,
			"",
			"{}",
			'{"type": 123}',
			"true",
			"42",
			"💥",
			'{"data": null}',
			'{"type": null}',
		];
		for (const input of inputs) {
			expect(() => parseSSEDataAuto(input)).not.toThrow();
		}
	});
});
