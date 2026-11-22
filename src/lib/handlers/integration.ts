// ─── Integration + Plugin Handlers ───────────────────────────────────────────
// Integration discovery + connect flows:
//   GET    /api/integration                          → list integrations
//   POST   /api/integration/{id}/connect/key         → connect with API key
//   POST   /api/integration/{id}/connect/oauth       → begin OAuth attempt
//   GET    /api/integration/{id}/connect/oauth/{a}   → poll OAuth attempt
//   POST   /api/integration/{id}/connect/oauth/{a}/complete → finish attempt
//   DELETE /api/integration/{id}/connect/oauth/{a}   → cancel attempt
//   POST   /api/integration/{id}/connect/command     → begin command attempt
//   GET    /api/integration/{id}/connect/command/{a} → poll command attempt
//   DELETE /api/integration/{id}/connect/command/{a} → cancel attempt
// Plugin management:
//   GET    /api/plugin        → list plugins
//   POST   /api/plugin/check  → refresh update status
//   POST   /api/plugin/update → update package plugins
//
// Connect attempts are client-scoped (sent only to the requesting browser);
// integration/plugin catalog changes are broadcast so every Settings panel
// stays in sync.

import { formatErrorDetail, RelayError } from "../errors.js";
import type {
	IntegrationAttemptStatus,
	RelayMessage,
} from "../shared-types.js";
import type { PayloadMap } from "./payloads.js";
import type { HandlerDeps } from "./types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Map an attempt status onto the relay phase union. */
function attemptPhase(
	status: IntegrationAttemptStatus,
): Extract<RelayMessage, { type: "integration_attempt" }>["phase"] {
	switch (status?.status) {
		case "complete":
			return "complete";
		case "failed":
			return "failed";
		case "expired":
			return "expired";
		default:
			return "pending";
	}
}

/** Re-list integrations and broadcast to every client. */
async function broadcastIntegrations(
	deps: HandlerDeps,
	clientId: string,
): Promise<void> {
	try {
		const integrations = await deps.client.listIntegrations();
		deps.wsHandler.broadcast({ type: "integration_list", integrations });
	} catch (err) {
		deps.log.warn(
			`client=${clientId} Failed to refresh integrations: ${formatErrorDetail(err)}`,
		);
	}
}

/** Re-list plugins and broadcast to every client. */
async function broadcastPlugins(
	deps: HandlerDeps,
	clientId: string,
): Promise<void> {
	try {
		const plugins = await deps.client.listPlugins();
		deps.wsHandler.broadcast({ type: "plugin_list", plugins });
	} catch (err) {
		deps.log.warn(
			`client=${clientId} Failed to refresh plugins: ${formatErrorDetail(err)}`,
		);
	}
}

function sendAttemptError(
	deps: HandlerDeps,
	clientId: string,
	action: string,
	err: unknown,
): void {
	deps.wsHandler.sendTo(
		clientId,
		RelayError.fromCaught(err, "INTEGRATION_FAILED", action).toMessage(),
	);
}

// ─── Integration list ────────────────────────────────────────────────────────

export async function handleListIntegrations(
	deps: HandlerDeps,
	clientId: string,
	_payload: PayloadMap["list_integrations"],
): Promise<void> {
	try {
		const integrations = await deps.client.listIntegrations();
		deps.wsHandler.sendTo(clientId, { type: "integration_list", integrations });
	} catch (err) {
		deps.log.warn(
			`client=${clientId} Failed to list integrations: ${formatErrorDetail(err)}`,
		);
		deps.wsHandler.sendTo(clientId, {
			type: "integration_list",
			integrations: [],
		});
	}
}

// ─── Key connect ─────────────────────────────────────────────────────────────

export async function handleIntegrationConnectKey(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["integration_connect_key"],
): Promise<void> {
	const integrationID = payload.integrationID?.trim();
	const key = payload.key?.trim();
	if (!integrationID || !key) {
		deps.wsHandler.sendTo(
			clientId,
			new RelayError(
				"integration_connect_key requires 'integrationID' and 'key'",
				{ code: "INVALID_REQUEST" },
			).toMessage(),
		);
		return;
	}
	try {
		await deps.client.integrationConnectKey(integrationID, {
			key,
			...(payload.label !== undefined && { label: payload.label }),
			...(payload.answer !== undefined && { answer: payload.answer }),
		});
		await broadcastIntegrations(deps, clientId);
	} catch (err) {
		sendAttemptError(
			deps,
			clientId,
			`Failed to connect integration "${integrationID}"`,
			err,
		);
	}
}

// ─── OAuth connect ───────────────────────────────────────────────────────────

export async function handleIntegrationConnectOAuth(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["integration_connect_oauth"],
): Promise<void> {
	const integrationID = payload.integrationID?.trim();
	const methodID = payload.methodID?.trim();
	if (!integrationID || !methodID) {
		deps.wsHandler.sendTo(
			clientId,
			new RelayError(
				"integration_connect_oauth requires 'integrationID' and 'methodID'",
				{ code: "INVALID_REQUEST" },
			).toMessage(),
		);
		return;
	}
	try {
		const attempt = await deps.client.integrationConnectOAuth(integrationID, {
			methodID,
			...(payload.label !== undefined && { label: payload.label }),
			...(payload.answer !== undefined && { answer: payload.answer }),
		});
		deps.wsHandler.sendTo(clientId, {
			type: "integration_attempt",
			integrationID,
			attemptID: attempt.attemptID,
			kind: "oauth",
			phase: "started",
			...(attempt.url != null && { url: attempt.url }),
			...(attempt.instructions != null && {
				instructions: attempt.instructions,
			}),
		});
	} catch (err) {
		sendAttemptError(
			deps,
			clientId,
			`Failed to start OAuth for "${integrationID}"`,
			err,
		);
	}
}

export async function handleIntegrationOAuthStatus(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["integration_oauth_status"],
): Promise<void> {
	const integrationID = payload.integrationID?.trim();
	const attemptID = payload.attemptID?.trim();
	if (!integrationID || !attemptID) {
		deps.wsHandler.sendTo(
			clientId,
			new RelayError(
				"integration_oauth_status requires 'integrationID' and 'attemptID'",
				{ code: "INVALID_REQUEST" },
			).toMessage(),
		);
		return;
	}
	try {
		const status = await deps.client.integrationOAuthStatus(
			integrationID,
			attemptID,
		);
		const phase = attemptPhase(status);
		deps.wsHandler.sendTo(clientId, {
			type: "integration_attempt",
			integrationID,
			attemptID,
			kind: "oauth",
			phase,
			...(status.message != null && { message: status.message }),
		});
		if (phase === "complete" || phase === "failed" || phase === "expired") {
			await broadcastIntegrations(deps, clientId);
		}
	} catch (err) {
		sendAttemptError(
			deps,
			clientId,
			`Failed to poll OAuth attempt for "${integrationID}"`,
			err,
		);
	}
}

export async function handleIntegrationOAuthComplete(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["integration_oauth_complete"],
): Promise<void> {
	const integrationID = payload.integrationID?.trim();
	const attemptID = payload.attemptID?.trim();
	if (!integrationID || !attemptID) {
		deps.wsHandler.sendTo(
			clientId,
			new RelayError(
				"integration_oauth_complete requires 'integrationID' and 'attemptID'",
				{ code: "INVALID_REQUEST" },
			).toMessage(),
		);
		return;
	}
	try {
		await deps.client.integrationOAuthComplete(
			integrationID,
			attemptID,
			payload.code,
		);
		deps.wsHandler.sendTo(clientId, {
			type: "integration_attempt",
			integrationID,
			attemptID,
			kind: "oauth",
			phase: "complete",
		});
		await broadcastIntegrations(deps, clientId);
	} catch (err) {
		sendAttemptError(
			deps,
			clientId,
			`Failed to complete OAuth attempt for "${integrationID}"`,
			err,
		);
	}
}

export async function handleIntegrationCancelOAuth(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["integration_cancel_oauth"],
): Promise<void> {
	const integrationID = payload.integrationID?.trim();
	const attemptID = payload.attemptID?.trim();
	if (!integrationID || !attemptID) {
		deps.wsHandler.sendTo(
			clientId,
			new RelayError(
				"integration_cancel_oauth requires 'integrationID' and 'attemptID'",
				{ code: "INVALID_REQUEST" },
			).toMessage(),
		);
		return;
	}
	try {
		await deps.client.integrationCancelOAuth(integrationID, attemptID);
		deps.wsHandler.sendTo(clientId, {
			type: "integration_attempt",
			integrationID,
			attemptID,
			kind: "oauth",
			phase: "cancelled",
		});
	} catch (err) {
		sendAttemptError(
			deps,
			clientId,
			`Failed to cancel OAuth attempt for "${integrationID}"`,
			err,
		);
	}
}

// ─── Command connect ─────────────────────────────────────────────────────────

export async function handleIntegrationConnectCommand(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["integration_connect_command"],
): Promise<void> {
	const integrationID = payload.integrationID?.trim();
	const methodID = payload.methodID?.trim();
	if (!integrationID || !methodID) {
		deps.wsHandler.sendTo(
			clientId,
			new RelayError(
				"integration_connect_command requires 'integrationID' and 'methodID'",
				{ code: "INVALID_REQUEST" },
			).toMessage(),
		);
		return;
	}
	try {
		const attempt = await deps.client.integrationConnectCommand(integrationID, {
			methodID,
			...(payload.label !== undefined && { label: payload.label }),
		});
		deps.wsHandler.sendTo(clientId, {
			type: "integration_attempt",
			integrationID,
			attemptID: attempt.attemptID,
			kind: "command",
			phase: "started",
			...(attempt.url != null && { url: attempt.url }),
			...(attempt.instructions != null && {
				instructions: attempt.instructions,
			}),
		});
	} catch (err) {
		sendAttemptError(
			deps,
			clientId,
			`Failed to start command connect for "${integrationID}"`,
			err,
		);
	}
}

export async function handleIntegrationCommandStatus(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["integration_command_status"],
): Promise<void> {
	const integrationID = payload.integrationID?.trim();
	const attemptID = payload.attemptID?.trim();
	if (!integrationID || !attemptID) {
		deps.wsHandler.sendTo(
			clientId,
			new RelayError(
				"integration_command_status requires 'integrationID' and 'attemptID'",
				{ code: "INVALID_REQUEST" },
			).toMessage(),
		);
		return;
	}
	try {
		const status = await deps.client.integrationCommandStatus(
			integrationID,
			attemptID,
		);
		const phase = attemptPhase(status);
		deps.wsHandler.sendTo(clientId, {
			type: "integration_attempt",
			integrationID,
			attemptID,
			kind: "command",
			phase,
			...(status.message != null && { message: status.message }),
		});
		if (phase === "complete" || phase === "failed" || phase === "expired") {
			await broadcastIntegrations(deps, clientId);
		}
	} catch (err) {
		sendAttemptError(
			deps,
			clientId,
			`Failed to poll command attempt for "${integrationID}"`,
			err,
		);
	}
}

export async function handleIntegrationCancelCommand(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["integration_cancel_command"],
): Promise<void> {
	const integrationID = payload.integrationID?.trim();
	const attemptID = payload.attemptID?.trim();
	if (!integrationID || !attemptID) {
		deps.wsHandler.sendTo(
			clientId,
			new RelayError(
				"integration_cancel_command requires 'integrationID' and 'attemptID'",
				{ code: "INVALID_REQUEST" },
			).toMessage(),
		);
		return;
	}
	try {
		await deps.client.integrationCancelCommand(integrationID, attemptID);
		deps.wsHandler.sendTo(clientId, {
			type: "integration_attempt",
			integrationID,
			attemptID,
			kind: "command",
			phase: "cancelled",
		});
	} catch (err) {
		sendAttemptError(
			deps,
			clientId,
			`Failed to cancel command attempt for "${integrationID}"`,
			err,
		);
	}
}

// ─── Plugins ─────────────────────────────────────────────────────────────────

export async function handleListPlugins(
	deps: HandlerDeps,
	clientId: string,
	_payload: PayloadMap["list_plugins"],
): Promise<void> {
	try {
		const plugins = await deps.client.listPlugins();
		deps.wsHandler.sendTo(clientId, { type: "plugin_list", plugins });
	} catch (err) {
		deps.log.warn(
			`client=${clientId} Failed to list plugins: ${formatErrorDetail(err)}`,
		);
		deps.wsHandler.sendTo(clientId, { type: "plugin_list", plugins: [] });
	}
}

export async function handleCheckPlugins(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["check_plugins"],
): Promise<void> {
	try {
		const plugins = await deps.client.checkPlugins(payload.target);
		deps.wsHandler.sendTo(clientId, { type: "plugin_list", plugins });
	} catch (err) {
		deps.wsHandler.sendTo(
			clientId,
			RelayError.fromCaught(
				err,
				"PLUGIN_FAILED",
				"Failed to check for plugin updates",
			).toMessage(),
		);
	}
}

export async function handleUpdatePlugins(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["update_plugins"],
): Promise<void> {
	const targets = (payload.targets ?? []).map((t) => t.trim()).filter(Boolean);
	if (targets.length === 0) {
		deps.wsHandler.sendTo(
			clientId,
			new RelayError("update_plugins requires at least one target", {
				code: "INVALID_REQUEST",
			}).toMessage(),
		);
		return;
	}
	try {
		await deps.client.updatePlugins(targets);
		// updatePlugins resolves once every update finished — refresh state.
		await broadcastPlugins(deps, clientId);
		deps.wsHandler.sendTo(clientId, {
			type: "plugin_updated",
			targets,
			ok: true,
		});
	} catch (err) {
		deps.wsHandler.sendTo(clientId, {
			type: "plugin_updated",
			targets,
			ok: false,
			message: `Plugin update failed: ${formatErrorDetail(err)}`,
		});
	}
}
