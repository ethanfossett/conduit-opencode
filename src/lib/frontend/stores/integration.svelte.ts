// ─── Integration Store ───────────────────────────────────────────────────────
// Available integrations + their auth methods, and in-flight connect attempts
// (key / OAuth / command). The server is authoritative: the store mirrors
// `integration_list` broadcasts and `integration_attempt` lifecycle messages,
// and exposes actions that drive the Settings panel.

import type {
	IntegrationAttemptStatus,
	IntegrationInfo,
	IntegrationMethod,
	RelayMessage,
} from "../types.js";

// ─── State ──────────────────────────────────────────────────────────────────

/** Client-side view of one in-flight connect attempt. */
export interface IntegrationAttemptView {
	integrationID: string;
	attemptID: string;
	kind: "oauth" | "command";
	phase:
		| "started"
		| "pending"
		| "complete"
		| "failed"
		| "expired"
		| "cancelled";
	url?: string;
	instructions?: string;
	message?: string;
	updatedAt: number;
}

export const integrationState = $state({
	integrations: [] as IntegrationInfo[],
	/** Attempts keyed by `${integrationID}:${attemptID}`. */
	attempts: {} as Record<string, IntegrationAttemptView>,
	/** True once at least one integration_list has been received. */
	loaded: false,
});

// ─── Pure helpers ───────────────────────────────────────────────────────────

export function attemptKey(integrationID: string, attemptID: string): string {
	return `${integrationID}:${attemptID}`;
}

/** Human-readable label for one auth method. */
export function integrationMethodLabel(method: IntegrationMethod): string {
	switch (method.type) {
		case "key":
			return method.label || "API key";
		case "oauth":
			return method.label || "OAuth";
		case "command":
			return method.label || "Command";
		case "env":
			return `Environment (${method.names.join(", ")})`;
		default:
			return "Unknown";
	}
}

/** True when the attempt is still running (worth polling). */
export function attemptIsActive(attempt: IntegrationAttemptView): boolean {
	return attempt.phase === "started" || attempt.phase === "pending";
}

/** Short status line for an attempt. */
export function attemptStatusLabel(attempt: IntegrationAttemptView): string {
	switch (attempt.phase) {
		case "started":
			return "Waiting for authorization…";
		case "pending":
			return attempt.kind === "command"
				? "Waiting for command…"
				: "Waiting for authorization…";
		case "complete":
			return "Connected";
		case "failed":
			return attempt.message || "Failed";
		case "expired":
			return "Expired";
		case "cancelled":
			return "Cancelled";
		default:
			return attempt.phase;
	}
}

// ─── Message handlers ───────────────────────────────────────────────────────

export function handleIntegrationList(
	msg: Extract<RelayMessage, { type: "integration_list" }>,
): void {
	integrationState.integrations = Array.isArray(msg.integrations)
		? msg.integrations.filter(
				(i) => i && typeof i.id === "string" && typeof i.name === "string",
			)
		: [];
	integrationState.loaded = true;
}

export function handleIntegrationAttempt(
	msg: Extract<RelayMessage, { type: "integration_attempt" }>,
): void {
	if (!msg.integrationID || !msg.attemptID) return;
	const key = attemptKey(msg.integrationID, msg.attemptID);
	const previous = integrationState.attempts[key];
	const view: IntegrationAttemptView = {
		integrationID: msg.integrationID,
		attemptID: msg.attemptID,
		kind: msg.kind,
		phase: msg.phase,
		updatedAt: Date.now(),
		...(msg.url != null && { url: msg.url }),
		...(msg.instructions != null && { instructions: msg.instructions }),
		...(msg.message != null && { message: msg.message }),
	};
	// A poll that only says "pending" must not erase the start payload.
	if (view.phase === "pending" && previous) {
		if (view.url === undefined && previous.url !== undefined)
			view.url = previous.url;
		if (view.instructions === undefined && previous.instructions !== undefined)
			view.instructions = previous.instructions;
	}
	integrationState.attempts = { ...integrationState.attempts, [key]: view };
}

/** Forget a terminal attempt (dismiss). */
export function dismissAttempt(integrationID: string, attemptID: string): void {
	const key = attemptKey(integrationID, attemptID);
	const next = { ...integrationState.attempts };
	delete next[key];
	integrationState.attempts = next;
}

// ─── Actions ────────────────────────────────────────────────────────────────

type SendFn = (data: Record<string, unknown>) => void;

/** Request the current integration list. */
export function requestIntegrations(sendFn: SendFn): void {
	sendFn({ type: "list_integrations" });
}

/** Connect an integration with a raw API key. */
export function connectIntegrationKey(
	sendFn: SendFn,
	opts: { integrationID: string; key: string; label?: string },
): void {
	const integrationID = opts.integrationID?.trim();
	const key = opts.key?.trim();
	if (!integrationID || !key) return;
	sendFn({
		type: "integration_connect_key",
		integrationID,
		key,
		...(opts.label?.trim() ? { label: opts.label.trim() } : {}),
	});
}

/** Begin an OAuth attempt for a method. */
export function startIntegrationOAuth(
	sendFn: SendFn,
	opts: { integrationID: string; methodID: string; label?: string },
): void {
	if (!opts.integrationID || !opts.methodID) return;
	sendFn({
		type: "integration_connect_oauth",
		integrationID: opts.integrationID,
		methodID: opts.methodID,
		...(opts.label ? { label: opts.label } : {}),
	});
}

export function pollIntegrationOAuth(
	sendFn: SendFn,
	integrationID: string,
	attemptID: string,
): void {
	sendFn({ type: "integration_oauth_status", integrationID, attemptID });
}

export function completeIntegrationOAuth(
	sendFn: SendFn,
	integrationID: string,
	attemptID: string,
	code?: string,
): void {
	sendFn({
		type: "integration_oauth_complete",
		integrationID,
		attemptID,
		...(code != null && code !== "" ? { code } : {}),
	});
}

export function cancelIntegrationOAuth(
	sendFn: SendFn,
	integrationID: string,
	attemptID: string,
): void {
	sendFn({ type: "integration_cancel_oauth", integrationID, attemptID });
}

/** Begin a command connect attempt for a method. */
export function startIntegrationCommand(
	sendFn: SendFn,
	opts: { integrationID: string; methodID: string; label?: string },
): void {
	if (!opts.integrationID || !opts.methodID) return;
	sendFn({
		type: "integration_connect_command",
		integrationID: opts.integrationID,
		methodID: opts.methodID,
		...(opts.label ? { label: opts.label } : {}),
	});
}

export function pollIntegrationCommand(
	sendFn: SendFn,
	integrationID: string,
	attemptID: string,
): void {
	sendFn({ type: "integration_command_status", integrationID, attemptID });
}

export function cancelIntegrationCommand(
	sendFn: SendFn,
	integrationID: string,
	attemptID: string,
): void {
	sendFn({ type: "integration_cancel_command", integrationID, attemptID });
}

/** Merge a polled attempt status into local state (used for optimistic UI). */
export function attemptStatusFromApi(
	status: IntegrationAttemptStatus,
): IntegrationAttemptView["phase"] {
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

export function clearIntegrationState(): void {
	integrationState.integrations = [];
	integrationState.attempts = {};
	integrationState.loaded = false;
}
