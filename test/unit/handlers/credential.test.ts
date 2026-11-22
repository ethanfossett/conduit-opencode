// ─── Credential handlers ─────────────────────────────────────────────────────

import { describe, expect, it, vi } from "vitest";
import {
	handleActivateCredential,
	handleCreateCredential,
	handleDeleteCredential,
	handleListCredentials,
	handleUpdateCredential,
} from "../../../src/lib/handlers/credential.js";
import type { CredentialEntry } from "../../../src/lib/shared-types.js";
import { createMockHandlerDeps } from "../../helpers/mock-factories.js";

const ENTRY: CredentialEntry = {
	id: "cred-1",
	integrationID: "anthropic",
	label: "Work",
	active: true,
	value: { type: "key", key: "sk-1234567890" },
};

describe("handleListCredentials", () => {
	it("replies with credential_list", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.listCredentials).mockResolvedValue([ENTRY]);
		await handleListCredentials(deps, "client-1", {});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "credential_list",
			credentials: [ENTRY],
		});
	});

	it("degrades to an empty list on failure", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.listCredentials).mockRejectedValue(new Error("x"));
		await handleListCredentials(deps, "client-1", {});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "credential_list",
			credentials: [],
		});
	});
});

describe("handleCreateCredential", () => {
	it("creates then broadcasts the refreshed list", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.listCredentials).mockResolvedValue([ENTRY]);
		const payload = {
			integrationID: "anthropic",
			value: { type: "key" as const, key: "sk-1" },
			activate: true,
		};
		await handleCreateCredential(deps, "client-1", payload);
		expect(deps.client.createCredential).toHaveBeenCalledWith(payload);
		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith({
			type: "credential_list",
			credentials: [ENTRY],
		});
	});

	it("surfaces CREDENTIAL_FAILED on error", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.createCredential).mockRejectedValue(new Error("x"));
		await handleCreateCredential(deps, "client-1", {
			integrationID: "anthropic",
			value: { type: "key", key: "sk-1" },
		});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "error", code: "CREDENTIAL_FAILED" }),
		);
	});
});

describe("handleUpdateCredential / handleDeleteCredential / handleActivateCredential", () => {
	it("updates the label and broadcasts", async () => {
		const deps = createMockHandlerDeps();
		await handleUpdateCredential(deps, "client-1", {
			credentialId: "cred-1",
			label: "Personal",
		});
		expect(deps.client.updateCredential).toHaveBeenCalledWith(
			"cred-1",
			"Personal",
		);
		expect(deps.wsHandler.broadcast).toHaveBeenCalled();
	});

	it("deletes and broadcasts", async () => {
		const deps = createMockHandlerDeps();
		await handleDeleteCredential(deps, "client-1", { credentialId: "cred-1" });
		expect(deps.client.deleteCredential).toHaveBeenCalledWith("cred-1");
		expect(deps.wsHandler.broadcast).toHaveBeenCalled();
	});

	it("activates and broadcasts", async () => {
		const deps = createMockHandlerDeps();
		await handleActivateCredential(deps, "client-1", {
			credentialId: "cred-1",
		});
		expect(deps.client.activateCredential).toHaveBeenCalledWith("cred-1");
		expect(deps.wsHandler.broadcast).toHaveBeenCalled();
	});

	it("surfaces CREDENTIAL_FAILED when activate throws", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.activateCredential).mockRejectedValue(new Error("x"));
		await handleActivateCredential(deps, "client-1", {
			credentialId: "cred-1",
		});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "error", code: "CREDENTIAL_FAILED" }),
		);
	});
});
