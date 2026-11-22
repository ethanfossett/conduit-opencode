// ─── SSE Reconnection & Backoff (Ticket 1.2) ────────────────────────────────
// Pure logic for exponential backoff calculation, connection health tracking,
// session ID filtering, and event parsing. Deliberately IO-free.

import { formatErrorDetail } from "../errors.js";
import type { ConnectionHealth, OpenCodeEvent } from "../types.js";

// ─── Exponential backoff ─────────────────────────────────────────────────────

export interface BackoffConfig {
	baseDelay: number; // Initial delay in ms (default: 1000)
	maxDelay: number; // Maximum delay in ms (default: 30000)
	multiplier: number; // Multiplier per attempt (default: 2)
}

const DEFAULT_BACKOFF_CONFIG: BackoffConfig = {
	baseDelay: 1000,
	maxDelay: 30000,
	multiplier: 2,
};

/**
 * Calculate the next reconnection delay using exponential backoff.
 * delay = min(baseDelay * multiplier^attempt, maxDelay)
 * Always returns a value between baseDelay and maxDelay.
 */
export function calculateBackoffDelay(
	attempt: number,
	config: BackoffConfig = DEFAULT_BACKOFF_CONFIG,
): number {
	if (attempt < 0) return config.baseDelay;
	const delay = config.baseDelay * config.multiplier ** attempt;
	return Math.min(delay, config.maxDelay);
}

/**
 * Calculate the sequence of delays for N reconnection attempts.
 */
export function getBackoffSequence(
	numAttempts: number,
	config: BackoffConfig = DEFAULT_BACKOFF_CONFIG,
): number[] {
	const seq: number[] = [];
	for (let i = 0; i < numAttempts; i++) {
		seq.push(calculateBackoffDelay(i, config));
	}
	return seq;
}

// ─── Connection health tracking ──────────────────────────────────────────────

export interface HealthTracker {
	onConnected(): void;
	onDisconnected(): void;
	onEvent(): void;
	onReconnect(): void;
	getHealth(): ConnectionHealth & { stale: boolean };
	isStale(): boolean;
	getReconnectCount(): number;
}

export interface HealthTrackerConfig {
	staleThreshold: number; // ms — mark as stale if no event within this window
	now?: () => number;
}

const DEFAULT_HEALTH_CONFIG: HealthTrackerConfig = {
	staleThreshold: 60_000,
};

/**
 * Create a health tracker that monitors SSE connection state.
 */
export function createHealthTracker(
	config: HealthTrackerConfig = DEFAULT_HEALTH_CONFIG,
): HealthTracker {
	const now = config.now ?? (() => Date.now());
	let connected = false;
	let lastEventAt: number | null = null;
	let reconnectCount = 0;

	return {
		onConnected() {
			connected = true;
		},

		onDisconnected() {
			connected = false;
		},

		onEvent() {
			lastEventAt = now();
		},

		onReconnect() {
			reconnectCount++;
			connected = true;
		},

		getHealth() {
			return {
				connected,
				lastEventAt,
				reconnectCount,
				stale: this.isStale(),
			};
		},

		isStale() {
			if (!connected) return false;
			if (lastEventAt === null) return false;
			return now() - lastEventAt > config.staleThreshold;
		},

		getReconnectCount() {
			return reconnectCount;
		},
	};
}

// ─── Session ID filtering ────────────────────────────────────────────────────

/**
 * Check if an event belongs to a given session.
 * Events without a sessionID are considered "global" and always pass.
 */
export function eventBelongsToSession(
	event: OpenCodeEvent,
	sessionId: string,
): boolean {
	const props = event.properties as { sessionID?: string };
	// Events without sessionID are global — always pass
	if (props.sessionID === undefined) return true;
	return props.sessionID === sessionId;
}

/**
 * Filter a list of events to only those belonging to a given session.
 */
export function filterEventsBySession(
	events: OpenCodeEvent[],
	sessionId: string,
): OpenCodeEvent[] {
	return events.filter((e) => eventBelongsToSession(e, sessionId));
}

/**
 * Get the set of session IDs present in a list of events.
 */
export function getSessionIds(events: OpenCodeEvent[]): Set<string> {
	const ids = new Set<string>();
	for (const event of events) {
		const props = event.properties as { sessionID?: string };
		if (props.sessionID !== undefined) {
			ids.add(props.sessionID);
		}
	}
	return ids;
}

// ─── Event parsing ───────────────────────────────────────────────────────────

export interface ParseResult {
	ok: boolean;
	event?: OpenCodeEvent;
	error?: string;
}

/**
 * Parse a raw SSE data string into an OpenCodeEvent.
 * Never throws — returns { ok: false, error } for malformed data.
 */
export function parseSSEData(raw: string): ParseResult {
	if (!raw || raw.trim() === "") {
		return { ok: false, error: "empty data" };
	}

	try {
		const parsed = JSON.parse(raw);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			return { ok: false, error: "not an object" };
		}
		if (typeof parsed.type !== "string") {
			return { ok: false, error: "missing or invalid type field" };
		}
		if (typeof parsed.properties !== "object" || parsed.properties === null) {
			// Some events might not have properties — normalize
			return {
				ok: true,
				event: { type: parsed.type, properties: parsed.properties ?? {} },
			};
		}
		return { ok: true, event: parsed as OpenCodeEvent };
	} catch (e) {
		return { ok: false, error: `JSON parse error: ${formatErrorDetail(e)}` };
	}
}

/**
 * Parse a raw SSE data string from OpenCode v2's `/api/event` endpoint.
 *
 * The v2 envelope is:
 *   { "id": "evt_…", "created": <ms>, "type": "<event>",
 *     "location": { "directory": "/abs/path" }, "data": { … } }
 *
 * This function unwraps it into conduit's internal `{ type, properties }`
 * shape where `properties` is the envelope's `data` object. Never throws.
 */
export function parseSSEDataAuto(raw: string): ParseResult {
	if (!raw || raw.trim() === "") {
		return { ok: false, error: "empty data" };
	}

	try {
		const parsed = JSON.parse(raw);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			return { ok: false, error: "not an object" };
		}

		if (typeof parsed.type !== "string") {
			return { ok: false, error: "unrecognized event format" };
		}

		const data: unknown = parsed.data;
		const properties =
			typeof data === "object" && data !== null && !Array.isArray(data)
				? (data as Record<string, unknown>)
				: {};

		return {
			ok: true,
			event: { type: parsed.type, properties },
		};
	} catch (e) {
		return { ok: false, error: `JSON parse error: ${formatErrorDetail(e)}` };
	}
}

// ─── Known event types ───────────────────────────────────────────────────────

const KNOWN_EVENT_TYPES = new Set([
	"server.connected",
	"session.execution.started",
	"session.execution.succeeded",
	"session.execution.failed",
	"session.execution.interrupted",
	"session.step.started",
	"session.step.ended",
	"session.step.failed",
	"session.text.started",
	"session.text.delta",
	"session.text.ended",
	"session.reasoning.started",
	"session.reasoning.delta",
	"session.reasoning.ended",
	"session.tool.input.started",
	"session.tool.input.delta",
	"session.tool.input.ended",
	"session.tool.called",
	"session.tool.progress",
	"session.tool.success",
	"session.tool.failed",
	"session.skill.activated",
	"session.compaction.started",
	"session.compaction.delta",
	"session.compaction.ended",
	"session.compaction.failed",
	"session.shell.started",
	"session.shell.ended",
	"session.idle",
	"session.error",
	"session.created",
	"session.updated",
	"session.renamed",
	"session.deleted",
	"session.moved",
	"session.active",
	"permission.asked",
	"permission.replied",
	"form.created",
	"form.replied",
	"form.cancelled",
	"pty.created",
	"pty.updated",
	"pty.exited",
	"pty.deleted",
	"shell.created",
	"shell.started",
	"shell.exited",
	"shell.deleted",
	"installation.update-available",
	"installation.updated",
	"filesystem.changed",
	"todo.updated",
]);

/**
 * Check if an event type is known/handled by the relay.
 */
export function isKnownEventType(type: string): boolean {
	return KNOWN_EVENT_TYPES.has(type);
}

/**
 * Classify an event type into its category.
 */
export function classifyEventType(
	type: string,
):
	| "session"
	| "permission"
	| "form"
	| "pty"
	| "shell"
	| "file"
	| "installation"
	| "server"
	| "todo"
	| "unknown" {
	if (type.startsWith("session.")) return "session";
	if (type.startsWith("permission.")) return "permission";
	if (type.startsWith("form.")) return "form";
	if (type.startsWith("pty.")) return "pty";
	if (type.startsWith("shell.")) return "shell";
	if (type.startsWith("filesystem.")) return "file";
	if (type.startsWith("installation.")) return "installation";
	if (type.startsWith("server.")) return "server";
	if (type.startsWith("todo.")) return "todo";
	return "unknown";
}
