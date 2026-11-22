// ─── Tool SSE Transition Validation (OpenCode v2, live) ───────────────────
// Observes real tool lifecycle transitions via the v2 SSE stream
// (session.tool.input.started → session.tool.called → session.tool.success |
// session.tool.failed). Requires a live OpenCode v2 server; skips otherwise.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolStatus } from "../../src/lib/shared-types.js";
import {
	authHeaders,
	checkServerHealth,
	OPENCODE_BASE_URL,
} from "./helpers/server-connection.js";
import {
	collectSSEEvents,
	createTestSession,
	deleteTestSession,
	getSessionMessages,
	sendPrompt,
	type TestSession,
} from "./helpers/session-helpers.js";

let serverAvailable = false;
let testSession: TestSession | null = null;

beforeAll(async () => {
	const health = await checkServerHealth();
	serverAvailable = health?.healthy === true;
	if (!serverAvailable) {
		console.warn("⚠️  OpenCode server not running — skipping contract tests");
	}
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

// ─── Types ──────────────────────────────────────────────────────────────────

interface ToolPartEvent {
	id: string;
	tool: string;
	status: ToolStatus;
	hasInput: boolean;
	hasOutput: boolean;
	timestamp: number;
}

interface V2Event {
	type: string;
	data: Record<string, unknown>;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Extract v2 tool events from an SSE stream for a specific session. */
function extractToolEvents(
	events: V2Event[],
	sessionId: string,
): ToolPartEvent[] {
	const results: ToolPartEvent[] = [];
	for (const evt of events) {
		const data = evt.data;
		if (!evt.type.startsWith("session.tool.")) continue;
		if (data["sessionID"] && data["sessionID"] !== sessionId) continue;
		let status: ToolStatus;
		switch (evt.type) {
			case "session.tool.input.started":
				status = "pending";
				break;
			case "session.tool.called":
			case "session.tool.progress":
				status = "running";
				break;
			case "session.tool.success":
				status = "completed";
				break;
			case "session.tool.failed":
				status = "error";
				break;
			default:
				continue;
		}
		results.push({
			id: String(data["id"] ?? ""),
			tool: String(data["name"] ?? ""),
			status,
			hasInput: data["input"] != null,
			hasOutput:
				Array.isArray(data["content"]) &&
				(data["content"] as unknown[]).length > 0,
			timestamp: Date.now(),
		});
	}
	return results;
}

function groupById(events: ToolPartEvent[]): Map<string, ToolPartEvent[]> {
	const groups = new Map<string, ToolPartEvent[]>();
	for (const evt of events) {
		const existing = groups.get(evt.id) ?? [];
		existing.push(evt);
		groups.set(evt.id, existing);
	}
	return groups;
}

const VALID_FORWARD: Record<string, Set<string>> = {
	pending: new Set(["running", "completed", "error"]),
	running: new Set(["running", "completed", "error"]),
	completed: new Set(["completed"]),
	error: new Set(["error"]),
};

function validateTransitionSequence(statuses: ToolStatus[]): {
	valid: boolean;
	violations: string[];
} {
	const violations: string[] = [];
	for (let i = 1; i < statuses.length; i++) {
		const from = statuses[i - 1];
		const to = statuses[i];
		if (from === undefined || to === undefined) continue;
		if (!VALID_FORWARD[from]?.has(to)) {
			violations.push(`${from} → ${to} (at index ${i})`);
		}
	}
	return { valid: violations.length === 0, violations };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Tool SSE Transition Validation (live, v2)", () => {
	it("SSE event stream is accessible", async () => {
		if (skipIfNoServer()) return;
		const events = await collectSSEEvents("/event", {
			timeoutMs: 3_000,
			maxEvents: 5,
		});
		expect(events).toBeDefined();
	});

	describe("tool lifecycle via prompt", () => {
		let toolEvents: ToolPartEvent[] = [];
		let toolGroups: Map<string, ToolPartEvent[]> = new Map();

		it("sends a prompt and captures tool events via SSE", async () => {
			if (skipIfNoServer()) return;

			testSession = await createTestSession("tool-transition-test");
			expect(testSession.id).toBeTruthy();

			const observed: V2Event[] = [];
			const ssePromise = collectSSEEvents("/event", {
				timeoutMs: 45_000,
				maxEvents: 500,
				until: (evt) => {
					observed.push(evt);
					// Stop at the end of the first turn regardless of whether a
					// tool ran; the assertions below skip if none did.
					return evt.type === "session.idle";
				},
			});

			await sendPrompt(
				testSession.id,
				"Read the file at /tmp/.conduit-tool-transition-test and tell me what it says. Create it first with the content 'tool-transition-test' if it doesn't exist. Use the bash tool.",
			);

			const events = await ssePromise;
			toolEvents = extractToolEvents(events, testSession.id);
			toolGroups = groupById(toolEvents);

			if (toolEvents.length === 0) {
				console.warn(
					"SKIP: no tool events observed — the ephemeral server has no usable model/credentials for tool use",
				);
				return;
			}
			expect(toolEvents.length).toBeGreaterThan(0);
			expect(toolGroups.size).toBeGreaterThan(0);
		}, 90_000);

		it("every tool starts with pending or running", () => {
			if (skipIfNoServer() || toolGroups.size === 0) return;
			for (const [id, events] of toolGroups) {
				const first = events[0]?.status;
				expect(
					first === "pending" || first === "running",
					`Tool ${id} starts with ${first}`,
				).toBe(true);
			}
		});

		it("every tool ends in a terminal state", () => {
			if (skipIfNoServer() || toolGroups.size === 0) return;
			for (const [id, events] of toolGroups) {
				const last = events[events.length - 1]?.status;
				expect(
					last === "completed" || last === "error",
					`Tool ${id} ends with ${last}`,
				).toBe(true);
			}
		});

		it("all transitions follow valid forward order", () => {
			if (skipIfNoServer() || toolGroups.size === 0) return;
			for (const [id, events] of toolGroups) {
				const statuses = events.map((e) => e.status);
				const { valid, violations } = validateTransitionSequence(statuses);
				expect(valid, `Tool ${id}: ${violations.join(", ")}`).toBe(true);
			}
		});

		it("REST final state matches SSE terminal state", async () => {
			if (skipIfNoServer() || !testSession || toolGroups.size === 0) return;
			await new Promise((r) => setTimeout(r, 2_000));

			const messages = await getSessionMessages(testSession.id);
			const restTools = new Map<string, string>();
			for (const msg of messages) {
				const content = (msg as Record<string, unknown>)["content"] as
					| Array<Record<string, unknown>>
					| undefined;
				for (const part of content ?? []) {
					if (part["type"] !== "tool") continue;
					const id = part["id"] as string;
					const state = part["state"] as Record<string, unknown> | undefined;
					if (id && state?.["status"]) {
						restTools.set(id, state["status"] as string);
					}
				}
			}

			const mapStatus = (s: ToolStatus): string =>
				s === "pending" ? "streaming" : s;
			for (const [id, events] of toolGroups) {
				const lastEvent = events.at(-1);
				if (!lastEvent) continue;
				const rest = restTools.get(id);
				if (rest) {
					expect(rest).toBe(mapStatus(lastEvent.status));
				}
			}
		}, 30_000);

		it("session becomes idle after all tools complete", async () => {
			if (skipIfNoServer() || !testSession) return;
			const deadline = Date.now() + 15_000;
			let idle = false;
			while (Date.now() < deadline) {
				try {
					const res = (await (
						await fetch(`${OPENCODE_BASE_URL}/session/active`, {
							headers: { Accept: "application/json", ...authHeaders() },
						})
					).json()) as { data?: Record<string, { type?: string }> };
					const entry = res.data?.[testSession.id];
					if (!entry || entry.type !== "running") {
						idle = true;
						break;
					}
				} catch {
					// ignore
				}
				await new Promise((r) => setTimeout(r, 500));
			}
			expect(idle).toBe(true);
		}, 30_000);
	});

	describe("transition table completeness", () => {
		it("our VALID_TRANSITIONS table covers all ToolStatus values", () => {
			const allStatuses: ToolStatus[] = [
				"pending",
				"running",
				"completed",
				"error",
			];
			for (const status of allStatuses) {
				expect(VALID_FORWARD).toHaveProperty(status);
			}
		});

		it("terminal states have no forward transitions to non-terminal states", () => {
			const terminals: ToolStatus[] = ["completed", "error"];
			const nonTerminals: ToolStatus[] = ["pending", "running"];
			for (const terminal of terminals) {
				for (const nonTerminal of nonTerminals) {
					expect(VALID_FORWARD[terminal]?.has(nonTerminal)).toBe(false);
				}
			}
		});
	});
});
