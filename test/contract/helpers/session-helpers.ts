// ─── Session Helpers ───────────────────────────────────────────────────────
// Create and clean up test sessions for contract tests.

import {
	apiDelete,
	apiGet,
	apiPost,
	authHeaders,
	OPENCODE_BASE_URL,
} from "./server-connection.js";

export interface TestSession {
	id: string;
	slug?: string;
	title?: string;
	projectID?: string;
	directory?: string;
	version?: string;
	time?: { created?: number; updated?: number };
	location?: { directory?: string };
	[key: string]: unknown;
}

/** Unwrap a v2 single-object envelope (`{ data }`). */
function unwrapData<T>(res: unknown): T {
	if (res && typeof res === "object" && "data" in (res as object)) {
		return (res as { data: T }).data;
	}
	return res as T;
}

/**
 * Create a test session with a recognizable title for cleanup.
 */
export async function createTestSession(
	title = `contract-test-${Date.now()}`,
): Promise<TestSession> {
	const res = await apiPost<{ data: TestSession }>("/session", { title });
	return unwrapData<TestSession>(res);
}

/**
 * Delete a test session, ignoring errors (best-effort cleanup).
 */
export async function deleteTestSession(sessionId: string): Promise<void> {
	try {
		await apiDelete(`/session/${sessionId}`);
	} catch {
		// Ignore — cleanup is best effort
	}
}

/**
 * Get messages for a session.
 */
export async function getSessionMessages(
	sessionId: string,
): Promise<unknown[]> {
	const res = await apiGet<unknown>(`/session/${sessionId}/message`);
	// v2 returns { data: Session.Message.Info[], cursor }
	if (res && typeof res === "object" && "data" in (res as object)) {
		const data = (res as { data: unknown }).data;
		return Array.isArray(data) ? data : [];
	}
	if (Array.isArray(res)) return res;
	if (typeof res === "object" && res !== null) {
		return Object.values(res as Record<string, unknown>);
	}
	return [];
}

/**
 * Send a prompt to a session asynchronously.
 * v2: POST /api/session/{id}/prompt with { text }.
 */
export async function sendPrompt(
	sessionId: string,
	text: string,
): Promise<void> {
	await apiPost(`/session/${sessionId}/prompt`, { text });
}

/**
 * Wait for a session to become idle (polling GET /api/session/active).
 * v2 only reports *running* sessions; absence means idle.
 * Returns true if idle within timeout, false otherwise.
 */
export async function waitForIdle(
	sessionId: string,
	timeoutMs = 60_000,
	pollMs = 500,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await apiGet<{ data?: Record<string, { type?: string }> }>(
				"/session/active",
			);
			const active = res?.data ?? {};
			const entry = active[sessionId];
			if (!entry || entry.type !== "running") return true;
		} catch {
			// Ignore — server might be busy
		}
		await new Promise((r) => setTimeout(r, pollMs));
	}
	return false;
}

/**
 * Collect SSE events for a given duration or until a predicate is met.
 * v2 envelopes are flattened to `{ type, data }` where `data` is the
 * envelope's `data` object.
 */
export async function collectSSEEvents(
	path: string,
	opts: {
		maxEvents?: number;
		timeoutMs?: number;
		until?: (event: { type: string; data: Record<string, unknown> }) => boolean;
	} = {},
): Promise<Array<{ type: string; data: Record<string, unknown> }>> {
	const { maxEvents = 100, timeoutMs = 30_000, until } = opts;
	const events: Array<{ type: string; data: Record<string, unknown> }> = [];

	const controller = new AbortController();
	const deadline = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const res = await fetch(`${OPENCODE_BASE_URL}${path}`, {
			signal: controller.signal,
			headers: { Accept: "text/event-stream", ...authHeaders() },
		});

		if (!res.ok || !res.body) return events;

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		while (events.length < maxEvents) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				if (line.startsWith("data: ")) {
					try {
						const parsed = JSON.parse(line.slice(6)) as {
							type: string;
							data?: Record<string, unknown>;
						};
						const event = { type: parsed.type, data: parsed.data ?? {} };
						events.push(event);
						if (until?.(event)) {
							controller.abort();
							return events;
						}
					} catch {
						// Skip malformed data
					}
				}
			}
		}
	} catch {
		// AbortError expected
	} finally {
		clearTimeout(deadline);
		controller.abort();
	}

	return events;
}
