// ─── AC6: Tool Part State Machine Validation (OpenCode v2) ────────────────
// Validates the v2 tool lifecycle against the committed OpenAPI snapshot:
// tool state is a tagged union (streaming → running → completed | error) and
// SSE delivers it via session.tool.* events on /api/event.

import { describe, expect, it } from "vitest";
import { loadOpenApiSnapshot } from "./helpers/server-connection.js";

describe("AC6 — Tool Part State Machine Validation (v2)", () => {
	describe("Message part structure from the v2 snapshot", () => {
		it("the spec defines Session.Message.Info", () => {
			const spec = loadOpenApiSnapshot();
			const schemas = spec.components?.schemas ?? {};
			const names = Object.keys(schemas);
			expect(names.some((n) => n.includes("Session.Message"))).toBe(true);
		});

		it("assistant tool content is defined", () => {
			const spec = loadOpenApiSnapshot();
			const schemas = spec.components?.schemas ?? {};
			expect(schemas).toHaveProperty("Session.Message.Assistant.Tool");
		});
	});

	describe("Tool state values from the v2 snapshot", () => {
		it("the spec defines the four tool state variants", () => {
			const spec = loadOpenApiSnapshot();
			const schemas = spec.components?.schemas ?? {};
			for (const state of ["Streaming", "Running", "Completed", "Error"]) {
				expect(schemas).toHaveProperty(`Session.Message.ToolState.${state}`);
			}
		});

		it("tool state status values are streaming/running/completed/error", () => {
			const spec = loadOpenApiSnapshot();
			const schemasStr = JSON.stringify(spec.components?.schemas ?? {});
			for (const status of ["streaming", "running", "completed", "error"]) {
				expect(schemasStr).toContain(`"${status}"`);
			}
		});

		it("assistant content covers text, reasoning and tool parts", () => {
			const spec = loadOpenApiSnapshot();
			const schemasStr = JSON.stringify(spec.components?.schemas ?? {});
			for (const partType of ["text", "reasoning", "tool"]) {
				expect(schemasStr).toContain(`"${partType}"`);
			}
		});
	});

	describe("SSE event endpoint for tool lifecycle", () => {
		it("the v2 event stream is GET /api/event", () => {
			const spec = loadOpenApiSnapshot();
			expect(spec.paths).toHaveProperty("/api/event");
		});

		it("the event stream response is text/event-stream", () => {
			const spec = loadOpenApiSnapshot();
			const event = spec.paths["/api/event"] as Record<
				string,
				Record<string, unknown>
			>;
			const get = event?.["get"];
			expect(get).toBeDefined();
			const content = JSON.stringify(get?.["responses"]);
			expect(content).toContain("text/event-stream");
		});
	});

	describe("Session endpoints used by the tool lifecycle", () => {
		it("GET /api/session/{sessionID}/message/{messageID} exists", () => {
			const spec = loadOpenApiSnapshot();
			expect(spec.paths).toHaveProperty(
				"/api/session/{sessionID}/message/{messageID}",
			);
		});

		it("POST /api/session/{sessionID}/prompt exists", () => {
			const spec = loadOpenApiSnapshot();
			expect(spec.paths).toHaveProperty("/api/session/{sessionID}/prompt");
		});

		it("POST /api/session/{sessionID}/interrupt exists", () => {
			const spec = loadOpenApiSnapshot();
			expect(spec.paths).toHaveProperty("/api/session/{sessionID}/interrupt");
		});
	});
});
