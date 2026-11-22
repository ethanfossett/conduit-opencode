// ─── Terminal / PTY Handlers ─────────────────────────────────────────────────
// Wires browser PTY commands onto OpenCode v2's *persistent* PTY API:
//   GET/POST /api/experimental/session/{sessionID}/terminal  (list/create)
//   GET      /api/experimental/persistent-pty/{ptyID}        (info)
//   PUT      /api/experimental/persistent-pty/{ptyID}        (resize)
//   DELETE   /api/experimental/persistent-pty/{ptyID}        (delete)
//   GET      /api/experimental/persistent-pty/{ptyID}/connect (WebSocket)
//
// Persistent PTYs live on the OpenCode server, so they survive a relay restart.
// Discovery/reattach happens lazily via `terminal_command list`: list a
// session's terminals, seed the browser, and reconnect still-running PTYs with
// `cursor: 0` so buffered output replays into the relay's scrollback.

import { formatErrorDetail, RelayError } from "../errors.js";
import type { PersistentPtyInfo } from "../instance/opencode-client.js";
import type { PtyInfo, PtyStatus } from "../shared-types.js";
import type { PayloadMap } from "./payloads.js";
import { resolveSession, resolveSessionForLog } from "./resolve-session.js";
import type { HandlerDeps } from "./types.js";

/** Map a v2 PersistentPty.Info onto conduit's wire-facing PtyInfo. */
export function toPtyInfo(pty: PersistentPtyInfo): PtyInfo {
	return {
		id: pty.id,
		title: pty.title || "Terminal",
		command: pty.command || "bash",
		cwd: pty.cwd || "",
		status: (pty.status === "exited"
			? "exited"
			: "running") satisfies PtyStatus,
		pid: pty.pid ?? 0,
	};
}

/**
 * Create a persistent PTY for the client's session, broadcast pty_created, and
 * connect the upstream WebSocket. Shared between pty_create and
 * terminal_command:create.
 */
async function createAndConnectPty(
	deps: HandlerDeps,
	clientId: string,
): Promise<void> {
	const session = resolveSession(deps, clientId);
	if (!session) {
		deps.log.warn(`client=${clientId} Failed to create PTY: no active session`);
		deps.wsHandler.sendTo(
			clientId,
			new RelayError(
				"No active session. Create or switch to a session first.",
				{ code: "NO_SESSION" },
			).toMessage(),
		);
		return;
	}

	let createResult: PersistentPtyInfo;
	try {
		createResult = await deps.client.createSessionTerminal(session, {
			args: [],
			title: "Terminal",
			env: {},
		});
	} catch (createErr) {
		deps.log.warn(
			`client=${clientId} session=${session} Failed to create PTY: ${formatErrorDetail(createErr)}`,
		);
		deps.wsHandler.sendTo(
			clientId,
			RelayError.fromCaught(
				createErr,
				"PTY_CREATE_FAILED",
				"Failed to create terminal",
			).toMessage(),
		);
		return;
	}

	const ptyId = String(createResult?.id ?? "");
	if (!ptyId) {
		deps.log.warn(
			`client=${clientId} session=${session} Create returned no id: ${JSON.stringify(createResult)}`,
		);
		deps.wsHandler.sendTo(
			clientId,
			new RelayError("Terminal creation returned no ID", {
				code: "PTY_CREATE_FAILED",
			}).toMessage(),
		);
		return;
	}

	const pty = toPtyInfo(createResult);

	deps.log.info(
		`client=${clientId} session=${session} Created: ${ptyId} (pid=${pty.pid})`,
	);
	// Notify browser FIRST (like claude-relay: term_created before data)
	deps.wsHandler.broadcast({ type: "pty_created", pty });

	// THEN connect upstream (handler installed before "open", no data loss).
	// cursor: 0 replays the full buffer so scrollback is populated.
	try {
		await deps.connectPtyUpstream(ptyId, { cursor: 0 });
		deps.log.info(
			`client=${clientId} session=${session} Connected upstream WS: ${ptyId}`,
		);
	} catch (connectErr) {
		deps.log.warn(
			`client=${clientId} session=${session} Failed to connect upstream WS: ${ptyId}: ${formatErrorDetail(connectErr)}`,
		);
		// Clean up the ghost tab — we already broadcast pty_created
		deps.wsHandler.broadcast({ type: "pty_deleted", ptyId });
		deps.wsHandler.sendTo(
			clientId,
			RelayError.fromCaught(
				connectErr,
				"PTY_CONNECT_FAILED",
				"Failed to connect to terminal",
			).toMessage(),
		);
	}
}

/**
 * List a session's persistent terminals and reattach any still-running PTYs the
 * relay does not already track. Returns the normalised PtyInfo list.
 */
async function listAndReattach(
	deps: HandlerDeps,
	clientId: string,
	session: string | undefined,
): Promise<PtyInfo[]> {
	const byId = new Map<string, PtyInfo>();

	if (session) {
		try {
			const persistent = await deps.client.listSessionTerminals(session);
			for (const pty of persistent) {
				const info = toPtyInfo(pty);
				if (info.id) byId.set(info.id, info);
			}
		} catch (err) {
			deps.log.warn(
				`client=${clientId} session=${session} Failed to list persistent terminals: ${formatErrorDetail(err)}`,
			);
		}
	}

	// Preserve PTYs tracked from other sessions so switching sessions (or a
	// re-list) never drops an existing tab.
	for (const tracked of deps.ptyManager.listSessions()) {
		if (!byId.has(tracked.id)) {
			byId.set(tracked.id, {
				id: tracked.id,
				title: "Terminal",
				command: "bash",
				cwd: "",
				status: tracked.status,
				pid: 0,
			});
		}
	}

	const ptys = [...byId.values()];

	// Ensure upstream WS connections exist for running PTYs.
	for (const pty of ptys) {
		const pid = pty.id;
		if (pid && pty.status === "running" && !deps.ptyManager.hasSession(pid)) {
			try {
				// cursor: 0 replays buffered output (recovers scrollback after a
				// relay restart).
				await deps.connectPtyUpstream(pid, { cursor: 0 });
				deps.log.info(
					`client=${clientId} session=${session} Reattached upstream WS: ${pid}`,
				);
			} catch (err) {
				deps.log.warn(
					`client=${clientId} session=${session} Failed to reattach upstream: ${pid}: ${formatErrorDetail(err)}`,
				);
			}
		}
	}

	return ptys;
}

export async function handleTerminalCommand(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["terminal_command"],
): Promise<void> {
	const { action } = payload;
	const session = resolveSessionForLog(deps, clientId);
	if (action === "create") {
		deps.log.info(
			`client=${clientId} session=${session} terminal_command create → delegating to pty_create`,
		);
		await createAndConnectPty(deps, clientId);
	} else if (action === "close" || action === "delete") {
		const ptyId = payload.ptyId ?? "";
		if (ptyId) {
			deps.ptyManager.closeSession(ptyId);
			try {
				await deps.client.deletePersistentPty(ptyId);
			} catch (err) {
				deps.log.warn(
					`client=${clientId} session=${session} Failed to delete terminal ${ptyId}: ${formatErrorDetail(err)}`,
				);
			}
			deps.wsHandler.broadcast({ type: "pty_deleted", ptyId });
		}
	} else if (action === "list") {
		const ptys = await listAndReattach(
			deps,
			clientId,
			resolveSession(deps, clientId),
		);
		deps.wsHandler.sendTo(clientId, { type: "pty_list", ptys });
	}
}

export async function handlePtyCreate(
	deps: HandlerDeps,
	clientId: string,
	_payload: PayloadMap["pty_create"],
): Promise<void> {
	deps.log.info(
		`client=${clientId} session=${resolveSessionForLog(deps, clientId)} Creating PTY session...`,
	);
	await createAndConnectPty(deps, clientId);
}

export async function handlePtyInput(
	deps: HandlerDeps,
	_clientId: string,
	payload: PayloadMap["pty_input"],
): Promise<void> {
	const { ptyId, data } = payload;
	if (ptyId && data) {
		deps.ptyManager.sendInput(ptyId, data);
	}
}

export async function handlePtyResize(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["pty_resize"],
): Promise<void> {
	const { ptyId } = payload;
	const cols = payload.cols ?? 80;
	const rows = payload.rows ?? 24;
	if (ptyId) {
		try {
			deps.ptyManager.setDimensions(ptyId, cols, rows);
			const attachmentID = deps.ptyManager.getSession(ptyId)?.attachmentID;
			await deps.client.updatePersistentPty(
				ptyId,
				{ cols, rows },
				...(attachmentID ? [attachmentID] : []),
			);
		} catch (resizeErr) {
			// Non-fatal — log but don't error to browser
			deps.log.warn(
				`client=${clientId} session=${resolveSessionForLog(deps, clientId)} Resize failed ${ptyId}: ${formatErrorDetail(resizeErr)}`,
			);
		}
	}
}

export async function handlePtyClose(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["pty_close"],
): Promise<void> {
	const { ptyId } = payload;
	if (ptyId) {
		deps.ptyManager.closeSession(ptyId);
		try {
			await deps.client.deletePersistentPty(ptyId);
		} catch (err) {
			deps.log.warn(
				`client=${clientId} Delete failed ${ptyId}: ${formatErrorDetail(err)}`,
			);
		}
		deps.wsHandler.broadcast({ type: "pty_deleted", ptyId });
	}
}
