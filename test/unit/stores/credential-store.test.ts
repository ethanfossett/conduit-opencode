// ─── Credentials store ───────────────────────────────────────────────────────

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	activateCredential,
	clearCredentialState,
	createApiKeyCredential,
	credentialState,
	credentialValueSummary,
	deleteCredential,
	handleCredentialList,
	requestCredentials,
} from "../../../src/lib/frontend/stores/credentials.svelte.js";
import type { CredentialEntry } from "../../../src/lib/shared-types.js";

const ENTRY: CredentialEntry = {
	id: "cred-1",
	integrationID: "anthropic",
	label: "Work",
	active: true,
	value: { type: "key", key: "sk-1234567890abcd" },
};

beforeEach(() => {
	clearCredentialState();
});

describe("handleCredentialList", () => {
	it("stores entries and marks loaded", () => {
		handleCredentialList({ type: "credential_list", credentials: [ENTRY] });
		expect(credentialState.credentials).toHaveLength(1);
		expect(credentialState.loaded).toBe(true);
	});

	it("tolerates a malformed list", () => {
		handleCredentialList({
			type: "credential_list",
			credentials: undefined as never,
		});
		expect(credentialState.credentials).toEqual([]);
	});
});

describe("credentialValueSummary", () => {
	it("summarizes key credentials without exposing the full secret", () => {
		const summary = credentialValueSummary(ENTRY);
		expect(summary).toContain("API key");
		expect(summary).not.toContain("sk-1234567890abcd");
		expect(summary.endsWith("abcd")).toBe(true);
	});

	it("summarizes short keys generically", () => {
		expect(
			credentialValueSummary({ ...ENTRY, value: { type: "key", key: "abc" } }),
		).toBe("API key");
	});

	it("summarizes oauth credentials", () => {
		expect(
			credentialValueSummary({
				...ENTRY,
				value: {
					type: "oauth",
					methodID: "m-1",
					refresh: "r",
					access: "a",
					expires: 0,
				},
			}),
		).toBe("OAuth · m-1");
	});
});

describe("actions", () => {
	it("requestCredentials sends list_credentials", () => {
		const send = vi.fn();
		requestCredentials(send);
		expect(send).toHaveBeenCalledWith({ type: "list_credentials" });
	});

	it("createApiKeyCredential sends a create_credential payload", () => {
		const send = vi.fn();
		createApiKeyCredential(send, {
			integrationID: "anthropic",
			key: "sk-1",
			label: "Work",
			activate: true,
		});
		expect(send).toHaveBeenCalledWith({
			type: "create_credential",
			integrationID: "anthropic",
			value: { type: "key", key: "sk-1" },
			label: "Work",
			activate: true,
		});
	});

	it("createApiKeyCredential ignores incomplete input", () => {
		const send = vi.fn();
		createApiKeyCredential(send, { integrationID: "", key: "" });
		expect(send).not.toHaveBeenCalled();
	});

	it("activate/delete send the right messages", () => {
		const send = vi.fn();
		activateCredential(send, "cred-1");
		deleteCredential(send, "cred-1");
		expect(send).toHaveBeenNthCalledWith(1, {
			type: "activate_credential",
			credentialId: "cred-1",
		});
		expect(send).toHaveBeenNthCalledWith(2, {
			type: "delete_credential",
			credentialId: "cred-1",
		});
	});
});
