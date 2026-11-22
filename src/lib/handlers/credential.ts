// ─── Credential Handlers ─────────────────────────────────────────────────────
// Integration/provider credentials for v2:
//   GET    /api/credential                     → list
//   POST   /api/credential                     → create (+ optional activate)
//   PATCH  /api/credential/{id}                → update label
//   DELETE /api/credential/{id}                → remove
//   POST   /api/credential/{id}/activate       → activate
// Every mutation re-lists and broadcasts credential_list so all clients sync.

import { formatErrorDetail, RelayError } from "../errors.js";
import type { CredentialEntry } from "../shared-types.js";
import type { PayloadMap } from "./payloads.js";
import type { HandlerDeps } from "./types.js";

async function broadcastCredentials(deps: HandlerDeps, clientId: string) {
	try {
		const credentials: CredentialEntry[] = await deps.client.listCredentials();
		deps.wsHandler.broadcast({ type: "credential_list", credentials });
	} catch (err) {
		deps.log.warn(
			`client=${clientId} Failed to refresh credentials: ${formatErrorDetail(err)}`,
		);
	}
}

export async function handleListCredentials(
	deps: HandlerDeps,
	clientId: string,
	_payload: PayloadMap["list_credentials"],
): Promise<void> {
	try {
		const credentials = await deps.client.listCredentials();
		deps.wsHandler.sendTo(clientId, { type: "credential_list", credentials });
	} catch (err) {
		deps.log.warn(
			`client=${clientId} Failed to list credentials: ${formatErrorDetail(err)}`,
		);
		deps.wsHandler.sendTo(clientId, {
			type: "credential_list",
			credentials: [],
		});
	}
}

export async function handleCreateCredential(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["create_credential"],
): Promise<void> {
	try {
		await deps.client.createCredential(payload);
		await broadcastCredentials(deps, clientId);
	} catch (err) {
		deps.wsHandler.sendTo(
			clientId,
			RelayError.fromCaught(
				err,
				"CREDENTIAL_FAILED",
				`Failed to create credential for "${payload.integrationID}"`,
			).toMessage(),
		);
	}
}

export async function handleUpdateCredential(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["update_credential"],
): Promise<void> {
	try {
		await deps.client.updateCredential(payload.credentialId, payload.label);
		await broadcastCredentials(deps, clientId);
	} catch (err) {
		deps.wsHandler.sendTo(
			clientId,
			RelayError.fromCaught(
				err,
				"CREDENTIAL_FAILED",
				"Failed to update credential",
			).toMessage(),
		);
	}
}

export async function handleDeleteCredential(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["delete_credential"],
): Promise<void> {
	try {
		await deps.client.deleteCredential(payload.credentialId);
		await broadcastCredentials(deps, clientId);
	} catch (err) {
		deps.wsHandler.sendTo(
			clientId,
			RelayError.fromCaught(
				err,
				"CREDENTIAL_FAILED",
				"Failed to delete credential",
			).toMessage(),
		);
	}
}

export async function handleActivateCredential(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["activate_credential"],
): Promise<void> {
	try {
		await deps.client.activateCredential(payload.credentialId);
		await broadcastCredentials(deps, clientId);
	} catch (err) {
		deps.wsHandler.sendTo(
			clientId,
			RelayError.fromCaught(
				err,
				"CREDENTIAL_FAILED",
				"Failed to activate credential",
			).toMessage(),
		);
	}
}
