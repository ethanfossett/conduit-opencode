// ─── Server Connection Helper ──────────────────────────────────────────────
// Connects to a running OpenCode instance for contract testing.
// Skips tests gracefully if the server is not available.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const OPENCODE_BASE_URL = withApi(
	process.env["OPENCODE_URL"] ?? "http://localhost:4096",
);

/**
 * Ensure a base URL carries the v2 `/api` prefix (without duplicating it).
 */
export function withApi(base: string): string {
	const trimmed = base.replace(/\/+$/, "");
	if (trimmed.endsWith("/api")) return trimmed;
	return `${trimmed}/api`;
}

/** Build auth headers if OPENCODE_SERVER_PASSWORD is set. */
export function authHeaders(): Record<string, string> {
	const pw = process.env["OPENCODE_SERVER_PASSWORD"];
	if (!pw) return {};
	const encoded = Buffer.from(`opencode:${pw}`).toString("base64");
	return { Authorization: `Basic ${encoded}` };
}

/**
 * Read the pinned version from .opencode-version file.
 */
export function getPinnedVersion(): string {
	const versionFile = resolve(
		import.meta.dirname ?? __dirname,
		"../../../.opencode-version",
	);
	return readFileSync(versionFile, "utf-8").trim();
}

/**
 * Load the committed OpenCode v2 OpenAPI snapshot.
 *
 * v2 no longer serves the spec from an HTTP endpoint, so contract checks that
 * need path/schema definitions read this fixture instead.
 */
export function loadOpenApiSnapshot(): {
	openapi: string;
	info: { title: string; version: string };
	paths: Record<string, Record<string, unknown>>;
	components?: { schemas?: Record<string, unknown> };
} {
	const snapshotPath = resolve(
		import.meta.dirname ?? __dirname,
		"../../fixtures/opencode-api-snapshot.json",
	);
	return JSON.parse(readFileSync(snapshotPath, "utf-8"));
}

/**
 * Check if the OpenCode server is reachable and return its health info.
 * Returns null if the server is not available.
 *
 * v2 has no `/global/health`; `/api/location` is a cheap authenticated probe.
 * The running version is read from `/api/info` (ServerInfo.version) and falls
 * back to the pinned `.opencode-version` when the server omits it.
 */
export async function checkServerHealth(): Promise<{
	healthy: boolean;
	version: string;
} | null> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 5_000);
		const res = await fetch(`${OPENCODE_BASE_URL}/location`, {
			signal: controller.signal,
			headers: { ...authHeaders() },
		});
		clearTimeout(timer);
		if (!res.ok) return null;
		let version = getPinnedVersion();
		try {
			const info = await apiGet<{ version?: string }>("/info");
			if (typeof info?.version === "string" && info.version.length > 0) {
				version = info.version;
			}
		} catch {
			// Older/partial servers may not expose /info — use the pinned version.
		}
		return { healthy: true, version };
	} catch {
		return null;
	}
}

/**
 * Fetch JSON from an OpenCode API endpoint (without trailing slash).
 */
export async function apiGet<T = unknown>(path: string): Promise<T> {
	const res = await fetch(`${OPENCODE_BASE_URL}${path}`, {
		headers: { Accept: "application/json", ...authHeaders() },
	});
	if (!res.ok) {
		throw new Error(`API GET ${path} failed: ${res.status} ${res.statusText}`);
	}
	return res.json() as Promise<T>;
}

/**
 * POST JSON to an OpenCode API endpoint.
 */
export async function apiPost<T = unknown>(
	path: string,
	body: unknown,
): Promise<T> {
	const res = await fetch(`${OPENCODE_BASE_URL}${path}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
			...authHeaders(),
		},
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(
			`API POST ${path} failed: ${res.status} ${res.statusText} — ${text}`,
		);
	}
	const contentType = res.headers.get("content-type") ?? "";
	if (contentType.includes("application/json")) {
		const text = await res.text();
		if (text.length === 0) return undefined as T;
		return JSON.parse(text) as T;
	}
	return undefined as T;
}

/**
 * PATCH JSON to an OpenCode API endpoint.
 */
export async function apiPatch<T = unknown>(
	path: string,
	body: unknown,
): Promise<T> {
	const res = await fetch(`${OPENCODE_BASE_URL}${path}`, {
		method: "PATCH",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
			...authHeaders(),
		},
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		throw new Error(
			`API PATCH ${path} failed: ${res.status} ${res.statusText}`,
		);
	}
	// v2 PATCH session returns 204 No Content.
	if (res.status === 204) return undefined as T;
	const contentType = res.headers.get("content-type") ?? "";
	if (contentType.includes("application/json")) {
		const text = await res.text();
		if (text.length === 0) return undefined as T;
		return JSON.parse(text) as T;
	}
	return undefined as T;
}

/**
 * DELETE an OpenCode API endpoint.
 */
export async function apiDelete(path: string): Promise<void> {
	const res = await fetch(`${OPENCODE_BASE_URL}${path}`, {
		method: "DELETE",
		headers: { Accept: "application/json", ...authHeaders() },
	});
	if (!res.ok) {
		throw new Error(
			`API DELETE ${path} failed: ${res.status} ${res.statusText}`,
		);
	}
}

/**
 * Connect to SSE event stream. Returns an AbortController to close and a
 * promise that resolves events as they arrive via callback.
 */
export function connectSSE(
	path: string,
	onEvent: (event: { type: string; data: string }) => void,
): { controller: AbortController; ready: Promise<void> } {
	const controller = new AbortController();
	const ready = new Promise<void>((resolve, reject) => {
		fetch(`${OPENCODE_BASE_URL}${path}`, {
			signal: controller.signal,
			headers: { Accept: "text/event-stream", ...authHeaders() },
		})
			.then(async (res) => {
				if (!res.ok || !res.body) {
					reject(new Error(`SSE ${path} failed: ${res.status}`));
					return;
				}
				resolve(); // Stream is open

				const reader = res.body.getReader();
				const decoder = new TextDecoder();
				let buffer = "";

				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;

						buffer += decoder.decode(value, { stream: true });
						const lines = buffer.split("\n");
						buffer = lines.pop() ?? "";

						let currentType = "";
						for (const line of lines) {
							if (line.startsWith("event: ")) {
								currentType = line.slice(7).trim();
							} else if (line.startsWith("data: ")) {
								onEvent({
									type: currentType || "message",
									data: line.slice(6),
								});
								currentType = "";
							} else if (line === "") {
								currentType = "";
							}
						}
					}
				} catch (err) {
					// AbortError is expected when we close the stream
					if (
						!(err instanceof DOMException && err.name === "AbortError") &&
						!(err instanceof Error && err.name === "AbortError")
					) {
						throw err;
					}
				}
			})
			.catch((err) => {
				if (err instanceof DOMException && err.name === "AbortError") {
					return;
				}
				reject(err);
			});
	});

	return { controller, ready };
}
