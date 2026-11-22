// ─── Credentials Store ───────────────────────────────────────────────────────
// Tracks stored integration credentials for the Settings panel. The server is
// authoritative: the store mirrors credential_list broadcasts and exposes
// create/activate/delete actions over the WebSocket.

import type {
	CredentialCreateInput,
	CredentialEntry,
	CredentialValue,
	RelayMessage,
} from "../types.js";

// ─── State ──────────────────────────────────────────────────────────────────

export const credentialState = $state({
	credentials: [] as CredentialEntry[],
	/** True once at least one credential_list has been received. */
	loaded: false,
});

// ─── Derived helpers ────────────────────────────────────────────────────────

/** Short, non-sensitive summary of a credential's value. */
export function credentialValueSummary(entry: CredentialEntry): string {
	const value: CredentialValue | undefined = entry.value;
	if (!value) return "";
	if (value.type === "oauth") return `OAuth · ${value.methodID}`;
	if (value.type === "key") {
		const key = value.key ?? "";
		if (key.length <= 8) return "API key";
		return `API key · …${key.slice(-4)}`;
	}
	return "";
}

// ─── Message handlers ───────────────────────────────────────────────────────

export function handleCredentialList(
	msg: Extract<RelayMessage, { type: "credential_list" }>,
): void {
	credentialState.credentials = Array.isArray(msg.credentials)
		? msg.credentials
		: [];
	credentialState.loaded = true;
}

// ─── Actions ────────────────────────────────────────────────────────────────

type SendFn = (data: Record<string, unknown>) => void;

/** Request the current credential list. */
export function requestCredentials(sendFn: SendFn): void {
	sendFn({ type: "list_credentials" });
}

/** Create a new API-key credential. */
export function createApiKeyCredential(
	sendFn: SendFn,
	opts: {
		integrationID: string;
		key: string;
		label?: string;
		activate?: boolean;
	},
): void {
	const integrationID = opts.integrationID.trim();
	const key = opts.key.trim();
	if (!integrationID || !key) return;
	const input: CredentialCreateInput = {
		integrationID,
		value: { type: "key", key },
		...(opts.label?.trim() ? { label: opts.label.trim() } : {}),
		...(opts.activate !== undefined ? { activate: opts.activate } : {}),
	};
	sendFn({ type: "create_credential", ...input });
}

export function activateCredential(sendFn: SendFn, credentialId: string): void {
	if (!credentialId) return;
	sendFn({ type: "activate_credential", credentialId });
}

export function deleteCredential(sendFn: SendFn, credentialId: string): void {
	if (!credentialId) return;
	sendFn({ type: "delete_credential", credentialId });
}

export function clearCredentialState(): void {
	credentialState.credentials = [];
	credentialState.loaded = false;
}
