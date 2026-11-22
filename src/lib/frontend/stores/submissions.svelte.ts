import type { RelayMessage } from "../types.js";
import { generateUuid } from "../utils/format.js";
import {
	forgetSubmission,
	rememberSubmission,
	submissionFingerprint,
} from "../utils/submission-identity.js";
import { showToast } from "./ui.svelte.js";
import { wsSend } from "./ws-send.svelte.js";

export type SubmissionStatus = "sending" | "accepted" | "failed" | "unknown";
export const submissionState = $state({
	statuses: {} as Record<string, SubmissionStatus>,
	revision: 0,
});
const pending = new Map<
	string,
	{ resolve: (accepted: boolean) => void; timer: ReturnType<typeof setTimeout> }
>();
const fingerprints = new Map<string, string>();

/** Local socket failure returns null without waiting for an acknowledgement. Only an upstream receipt
 * resolves true. Keep drafts on failures/timeouts and never automatically retry. */
export async function submitPrompt(
	payload: Record<string, unknown>,
	scope = "standalone",
	isCurrent: () => boolean = () => true,
): Promise<{
	requestId: string;
	accepted: Promise<boolean>;
	recovered: boolean;
} | null> {
	let fingerprint: string;
	try {
		fingerprint = await submissionFingerprint(scope, payload);
	} catch {
		showToast(
			"Could not prepare a recoverable submission. Your draft is retained.",
			{ variant: "warn" },
		);
		return null;
	}
	if (!isCurrent()) return null;
	const identity = rememberSubmission(fingerprint, generateUuid(), {
		scope,
		sessionId: String(payload["sessionId"] ?? ""),
	});
	submissionState.revision++;
	const requestId = identity.requestId;
	fingerprints.set(requestId, fingerprint);
	if (!identity.durable)
		showToast(
			"Submission recovery is unavailable. Keep this tab open until delivery is confirmed.",
			{ variant: "warn" },
		);
	let resolveResult: (accepted: boolean) => void = () => {};
	const accepted = new Promise<boolean>((resolve) => {
		resolveResult = resolve;
	});
	const timer = setTimeout(() => {
		pending.delete(requestId);
		submissionState.statuses[requestId] = "unknown";
		showToast(
			"Delivery is unconfirmed. Your draft is retained — check chat history before retrying.",
			{ variant: "warn" },
		);
		resolveResult(false);
	}, 30_000);
	pending.set(requestId, { resolve: resolveResult, timer });
	if (!wsSend({ ...payload, requestId })) {
		clearTimeout(timer);
		pending.delete(requestId);
		fingerprints.delete(requestId);
		resolveResult(false);
		return null;
	}
	submissionState.statuses[requestId] = "sending";

	return { requestId, accepted, recovered: identity.recovered };
}

export function handleSubmissionResult(
	message: Extract<RelayMessage, { type: "submission_result" }>,
): void {
	const item = pending.get(message.requestId);
	const fingerprint = fingerprints.get(message.requestId);
	if (fingerprint) {
		forgetSubmission(fingerprint);
		fingerprints.delete(message.requestId);
		submissionState.revision++;
	}

	// A late receipt still corrects a previously unconfirmed bubble.
	submissionState.statuses[message.requestId] = message.accepted
		? "accepted"
		: "failed";
	if (item) {
		clearTimeout(item.timer);
		pending.delete(message.requestId);
		item.resolve(message.accepted);
		if (!message.accepted)
			showToast(
				"OpenCode did not accept this submission. Your draft is retained.",
				{ variant: "warn" },
			);
	}
}
