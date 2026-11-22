// ─── PTY Upstream Connection ──────────────────────────────────────────────────
// Connects a PTY session to the upstream OpenCode v2 persistent-PTY WebSocket
// endpoint (`/api/experimental/persistent-pty/{ptyID}/connect`).
//
// Persistent PTYs live on the OpenCode server, so a relay restart does not kill
// them: the relay re-lists a session's terminals and reconnects with a cursor to
// replay buffered output (see handlers/terminal.ts).
//
// The connect stream mixes two kinds of text frames:
//   - raw terminal output (ANSI bytes) → forwarded to browsers as pty_output
//   - JSON control frames (`attached`, `replay_complete`, `controller_changed`,
//     `resized`, `exited`, …) → consumed by the relay, never forwarded
// Binary frames beginning with 0x00 are legacy cursor metadata and are dropped.

import type { Logger } from "../logger.js";
import type { RelayMessage } from "../types.js";

// ─── Dependencies ────────────────────────────────────────────────────────────

export interface PtyUpstreamDeps {
	ptyManager: {
		registerSession(ptyId: string, upstream: unknown): void;
		setAttachmentID(
			ptyId: string,
			attachmentID: string,
			inputProtocol?: number,
		): void;
		closeSession(ptyId: string): void;
		appendScrollback(ptyId: string, text: string): void;
		markExited(ptyId: string, exitCode: number): void;
		hasSession(ptyId: string): boolean;
	};
	wsHandler: {
		broadcast(msg: RelayMessage): void;
	};
	client: {
		getAuthHeaders(): Record<string, string>;
		getApiBaseUrl(): string;
	};
	opencodeUrl: string;
	log: Logger;
	WebSocketClass: typeof import("ws").WebSocket;
}

// ─── Connect options ─────────────────────────────────────────────────────────

export interface PtyConnectOptions {
	/**
	 * Stream cursor to replay from. `0` replays the full buffered output
	 * (used for new terminals and for reattach after a relay restart); omitted
	 * lets the server pick its default.
	 */
	cursor?: number;
	/** Attach role ("controller" | "observer"). Defaults to controller. */
	role?: string;
	/** Take over the controller role from any existing attachment. */
	takeover?: boolean;
}

// ─── Connect PTY Upstream ────────────────────────────────────────────────────

type RawData = import("ws").RawData;

/**
 * Control frame types emitted by the persistent-PTY connect stream. Any JSON
 * object frame whose `type` is in this set is consumed by the relay rather than
 * forwarded as terminal output.
 */
export const PTY_CONTROL_TYPES: ReadonlySet<string> = new Set([
	"attached",
	"replay_complete",
	"controller_changed",
	"resized",
	"exited",
	"detached",
	"error",
	"ready",
]);

/** A parsed persistent-PTY control frame. */
export interface PtyControlFrame {
	type: string;
	exitCode?: number;
	endOffset?: number;
	[key: string]: unknown;
}

/**
 * Classify an incoming frame from the persistent-PTY connect stream.
 *
 * Returns `{ kind: "control", frame }` for JSON control frames, `null` for
 * frames that should be skipped entirely (empty / 0x00 cursor metadata), or
 * `{ kind: "output", text }` for terminal output.
 *
 * Detection is intentionally conservative: a frame is only treated as a
 * control frame when it parses as a JSON object with a string `type` that is a
 * known control type. Any other frame (including JSON-looking terminal output)
 * is forwarded verbatim.
 */
export function classifyPtyFrame(
	data: RawData,
):
	| { kind: "control"; frame: PtyControlFrame }
	| { kind: "output"; text: string }
	| null {
	let buf: Buffer;
	if (Buffer.isBuffer(data)) {
		buf = data;
	} else if (typeof data === "string") {
		buf = Buffer.from(data);
	} else {
		buf = Buffer.from(data as ArrayBuffer);
	}

	if (buf.length === 0) return null;
	// Legacy cursor metadata: 0x00-prefixed binary frame.
	if (buf[0] === 0x00) return null;

	const text = buf.toString();
	if (!text) return null;

	// Only look at frames that could be JSON objects.
	const first = text.charCodeAt(0);
	if (first === 0x7b /* { */) {
		try {
			const parsed: unknown = JSON.parse(text);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				const type = (parsed as { type?: unknown }).type;
				if (typeof type === "string" && PTY_CONTROL_TYPES.has(type)) {
					return { kind: "control", frame: parsed as PtyControlFrame };
				}
			}
		} catch {
			// Not JSON — treat as terminal output below.
		}
	}

	return { kind: "output", text };
}

/**
 * Fetch a short-lived connection ticket for a PTY (v2 requirement). Returns
 * undefined (never throws) so callers can fall back to an unticketed connect.
 */
async function fetchPtyTicket(
	apiBase: string,
	ptyId: string,
	headers: Record<string, string>,
	log: Logger,
): Promise<string | undefined> {
	try {
		const res = await fetch(
			`${apiBase}/experimental/persistent-pty/${ptyId}/connect-token`,
			{ method: "POST", headers },
		);
		if (!res.ok) return undefined;
		const body: unknown = await res.json();
		if (typeof body === "string") return body;
		if (body && typeof body === "object") {
			const obj = body as Record<string, unknown>;
			const data = obj["data"];
			if (typeof data === "string") return data;
			const container: Record<string, unknown> =
				data && typeof data === "object"
					? (data as Record<string, unknown>)
					: obj;
			for (const key of ["ticket", "token", "value", "id"]) {
				const value = container[key];
				if (typeof value === "string") return value;
			}
		}
		return undefined;
	} catch (err) {
		log.warn(
			`PTY ticket fetch failed for ${ptyId}: ${err instanceof Error ? err.message : err}`,
		);
		return undefined;
	}
}

/**
 * Open an upstream WebSocket to OpenCode's persistent-PTY `/connect` endpoint
 * and wire it to the relay's PTY manager + browser broadcast.
 *
 * @param deps    - Explicit dependencies (ptyManager, wsHandler, client, etc.)
 * @param ptyId   - The persistent PTY identifier (`pty_…`)
 * @param options - Connection options (cursor, role, takeover)
 */
export async function connectPtyUpstream(
	deps: PtyUpstreamDeps,
	ptyId: string,
	options: PtyConnectOptions = {},
): Promise<void> {
	const { ptyManager, wsHandler, client, opencodeUrl, log, WebSocketClass } =
		deps;

	const headers = client.getAuthHeaders();
	const apiBase = client.getApiBaseUrl();

	// v2 may require a short-lived ticket for the PTY WebSocket. Fetch one first
	// (best-effort — fall back to connecting without a ticket on failure).
	const ticket = await fetchPtyTicket(apiBase, ptyId, headers, log);

	const httpUrl = new URL(
		`${apiBase}/experimental/persistent-pty/${ptyId}/connect`,
	);
	if (options.cursor !== undefined) {
		httpUrl.searchParams.set("cursor", String(options.cursor));
	}
	httpUrl.searchParams.set("role", options.role ?? "controller");
	httpUrl.searchParams.set("input_protocol", "1");
	if (options.takeover) httpUrl.searchParams.set("takeover", "true");
	if (ticket) httpUrl.searchParams.set("ticket", ticket);
	const directory = headers["x-opencode-directory"];
	if (directory) httpUrl.searchParams.set("location[directory]", directory);
	// opencodeUrl is retained as a fallback origin if apiBase is relative.
	if (!httpUrl.host) {
		const fallback = new URL(
			`/api/experimental/persistent-pty/${ptyId}/connect`,
			opencodeUrl,
		);
		httpUrl.protocol = fallback.protocol;
		httpUrl.host = fallback.host;
	}
	const wsUrl = httpUrl.toString().replace(/^http/, "ws");

	return new Promise<void>((resolve, reject) => {
		const upstream = new WebSocketClass(wsUrl, {
			headers,
			// Disable per-message compression for PTY connections.
			// Bun's WS may negotiate permessage-deflate with Node's ws, and
			// decompression bugs or flush mismatches can corrupt binary PTY data.
			perMessageDeflate: false,
			// Skip UTF-8 validation for TEXT frames. Terminal data can contain
			// 8-bit characters (C1 control codes) that are valid in terminal
			// protocols but technically invalid in strict UTF-8. Without this,
			// the ws library would close the connection on such frames.
			skipUTF8Validation: true,
		});

		// Register session BEFORE any events can fire. This mirrors the
		// original pattern where the PtySession object was created before
		// the WebSocket — prevents the race condition where OpenCode sends
		// replay data in the same TCP segment as the upgrade response
		// (Node.js ws processes both synchronously).
		ptyManager.registerSession(ptyId, upstream);
		let connected = false;
		let exitBroadcast = false;

		const broadcastExit = (exitCode: number) => {
			if (exitBroadcast) return;
			exitBroadcast = true;
			ptyManager.markExited(ptyId, exitCode);
			if (ptyManager.hasSession(ptyId)) {
				wsHandler.broadcast({ type: "pty_exited", ptyId, exitCode });
			}
		};

		const connectTimeout = setTimeout(() => {
			// Remove the session on timeout — it was never successfully opened
			ptyManager.closeSession(ptyId);
			reject(new Error(`Timed out connecting to PTY ${ptyId}`));
		}, 10_000);

		// Install message handler BEFORE "open" fires.
		upstream.on("message", (data: RawData) => {
			const classified = classifyPtyFrame(data);
			if (classified === null) return;

			if (classified.kind === "control") {
				if (classified.frame.type === "attached") {
					const attachmentID = classified.frame["attachmentID"];
					if (typeof attachmentID === "string") {
						ptyManager.setAttachmentID(
							ptyId,
							attachmentID,
							classified.frame["inputProtocol"] === 1 ? 1 : 0,
						);
					}
					connected = true;
					clearTimeout(connectTimeout);
					resolve();
				}
				if (classified.frame.type === "exited") {
					const code =
						typeof classified.frame.exitCode === "number"
							? classified.frame.exitCode
							: 0;
					broadcastExit(code);
				}
				return;
			}

			const text = classified.text;
			// Buffer scrollback via PtyManager (FIFO, 50 KB cap)
			ptyManager.appendScrollback(ptyId, text);

			// Broadcast to all browser clients
			wsHandler.broadcast({ type: "pty_output", ptyId, data: text });
		});

		upstream.on("close", () => {
			// Only broadcast pty_exited if the session is still tracked.
			// closeSession deletes + broadcasts pty_deleted, so we must
			// not also broadcast pty_exited for the same PTY.  Similarly,
			// if connectPtyUpstream failed the session was never stored.
			if (ptyManager.hasSession(ptyId)) {
				broadcastExit(0);
			} else {
				ptyManager.markExited(ptyId, 0);
			}
			log.info(`Upstream closed: ${ptyId}`);
		});

		upstream.on("error", (err: Error) => {
			if (!connected) {
				clearTimeout(connectTimeout);
				// Remove the failed session
				ptyManager.closeSession(ptyId);
				reject(err);
			}
			log.warn(`Upstream error ${ptyId}: ${err.message}`);
		});

		// The upgrade alone is not readiness: wait for `attached` so queued
		// resizes have the controller's attachment ID and input can be accepted.
	});
}
