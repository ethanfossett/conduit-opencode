// ─── References Handler ──────────────────────────────────────────────────────
// Server-provided @-mention references (v2 GET /api/reference → Reference.Info).
// Conduit merges these into the composer's @ menu alongside the client-side
// file list.

import { formatErrorDetail } from "../errors.js";
import type { PayloadMap } from "./payloads.js";
import type { HandlerDeps } from "./types.js";

export async function handleGetReferences(
	deps: HandlerDeps,
	clientId: string,
	_payload: PayloadMap["get_references"],
): Promise<void> {
	try {
		const references = await deps.client.listReferences();
		deps.wsHandler.sendTo(clientId, { type: "reference_list", references });
	} catch (err) {
		deps.log.warn(
			`client=${clientId} Failed to list references: ${formatErrorDetail(err)}`,
		);
		deps.wsHandler.sendTo(clientId, { type: "reference_list", references: [] });
	}
}
