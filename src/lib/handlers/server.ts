// ─── Server Info / Config Handlers ───────────────────────────────────────────
//   GET  /api/info             → server identity + readiness
//   POST /api/location/reload  → shut down and rebuild every loaded location

import { formatErrorDetail, RelayError } from "../errors.js";
import type { PayloadMap } from "./payloads.js";
import type { HandlerDeps } from "./types.js";

export async function handleGetServerInfo(
	deps: HandlerDeps,
	clientId: string,
	_payload: PayloadMap["get_server_info"],
): Promise<void> {
	try {
		const info = await deps.client.getServerInfo();
		deps.wsHandler.sendTo(clientId, { type: "server_info", info });
	} catch (err) {
		deps.log.warn(
			`client=${clientId} Failed to get server info: ${formatErrorDetail(err)}`,
		);
		deps.wsHandler.sendTo(
			clientId,
			RelayError.fromCaught(
				err,
				"SERVER_INFO_FAILED",
				"Failed to get server info",
			).toMessage(),
		);
	}
}

export async function handleReloadConfig(
	deps: HandlerDeps,
	clientId: string,
	_payload: PayloadMap["reload_config"],
): Promise<void> {
	try {
		await deps.client.reloadConfig();
		deps.log.info(`client=${clientId} Reloaded OpenCode configuration`);
		deps.wsHandler.broadcast({ type: "config_reloaded", ok: true });
	} catch (err) {
		deps.wsHandler.sendTo(
			clientId,
			RelayError.fromCaught(
				err,
				"RELOAD_FAILED",
				"Failed to reload configuration",
			).toMessage(),
		);
	}
}
