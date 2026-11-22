import { createHash } from "node:crypto";
import type { HandlerDeps } from "./types.js";

// Receipts are scoped to an upstream client (one project relay), not a browser
// connection. A duplicate while the first request is pending joins its result.
const receipts = new WeakMap<
	object,
	Map<
		string,
		{ fingerprint: string; result: Promise<boolean>; expires: number }
	>
>();
const TTL_MS = 10 * 60_000;
const MAX_RECEIPTS = 1_000;

export async function withSubmissionReceipt(
	deps: HandlerDeps,
	clientId: string,
	payload: { requestId?: string; sessionId?: string },
	kind: "message" | "run_command",
	send: () => Promise<boolean>,
): Promise<void> {
	const requestId = payload.requestId;
	if (!requestId) {
		await send();
		return;
	}
	if (typeof requestId !== "string" || requestId.length > 128) return;
	const sessionId =
		payload.sessionId ?? deps.wsHandler.getClientSession(clientId) ?? "";
	let cache = receipts.get(deps.client);
	if (!cache) {
		cache = new Map();
		receipts.set(deps.client, cache);
	}
	const now = Date.now();
	for (const [key, value] of cache) if (value.expires < now) cache.delete(key);
	const fingerprint = createHash("sha256")
		.update(JSON.stringify({ kind, sessionId, payload }))
		.digest("hex");
	let receipt = cache.get(requestId);
	if (
		(receipt && receipt.fingerprint !== fingerprint) ||
		(!receipt && cache.size >= MAX_RECEIPTS)
	) {
		deps.wsHandler.sendTo(clientId, {
			type: "submission_result",
			requestId,
			sessionId,
			accepted: false,
		});
		return;
	}
	if (!receipt) {
		// Schedule work after inserting the receipt so concurrent callers share it.
		const result = Promise.resolve()
			.then(send)
			.catch((error: unknown) => {
				deps.log.warn("Submission failed:", error);
				return false;
			});
		receipt = { fingerprint, result, expires: Number.POSITIVE_INFINITY };
		cache.set(requestId, receipt);
		const retained = receipt;
		void result.then(() => {
			retained.expires = Date.now() + TTL_MS;
		});
	}
	const accepted = await receipt.result;
	deps.wsHandler.sendTo(clientId, {
		type: "submission_result",
		requestId,
		sessionId,
		accepted,
	});
}
