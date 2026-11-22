// ─── Integration store ───────────────────────────────────────────────────────

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	attemptIsActive,
	attemptKey,
	attemptStatusFromApi,
	attemptStatusLabel,
	cancelIntegrationCommand,
	cancelIntegrationOAuth,
	clearIntegrationState,
	completeIntegrationOAuth,
	connectIntegrationKey,
	dismissAttempt,
	handleIntegrationAttempt,
	handleIntegrationList,
	integrationMethodLabel,
	integrationState,
	pollIntegrationCommand,
	pollIntegrationOAuth,
	requestIntegrations,
	startIntegrationCommand,
	startIntegrationOAuth,
} from "../../../src/lib/frontend/stores/integration.svelte.js";
import type {
	IntegrationInfo,
	IntegrationMethod,
} from "../../../src/lib/shared-types.js";

const INTEGRATIONS: IntegrationInfo[] = [
	{
		id: "anthropic",
		name: "Anthropic",
		methods: [{ type: "key" }],
		connections: [],
	},
];

beforeEach(() => {
	clearIntegrationState();
});

describe("handlers", () => {
	it("stores the integration list and marks it loaded", () => {
		handleIntegrationList({
			type: "integration_list",
			integrations: INTEGRATIONS,
		});
		expect(integrationState.integrations).toHaveLength(1);
		expect(integrationState.loaded).toBe(true);
	});

	it("tolerates a malformed list", () => {
		handleIntegrationList({
			type: "integration_list",
			integrations: undefined as never,
		});
		expect(integrationState.integrations).toEqual([]);
	});

	it("stores an attempt keyed by integration+attempt", () => {
		handleIntegrationAttempt({
			type: "integration_attempt",
			integrationID: "anthropic",
			attemptID: "att-1",
			kind: "oauth",
			phase: "started",
			url: "https://auth.example.com",
		});
		const attempt = integrationState.attempts["anthropic:att-1"];
		expect(attempt?.phase).toBe("started");
		expect(attempt?.url).toBe("https://auth.example.com");
	});

	it("keeps the start payload when a pending poll arrives", () => {
		handleIntegrationAttempt({
			type: "integration_attempt",
			integrationID: "anthropic",
			attemptID: "att-1",
			kind: "oauth",
			phase: "started",
			url: "https://auth.example.com",
			instructions: "Follow the link",
		});
		handleIntegrationAttempt({
			type: "integration_attempt",
			integrationID: "anthropic",
			attemptID: "att-1",
			kind: "oauth",
			phase: "pending",
		});
		const attempt = integrationState.attempts["anthropic:att-1"];
		expect(attempt?.phase).toBe("pending");
		expect(attempt?.url).toBe("https://auth.example.com");
		expect(attempt?.instructions).toBe("Follow the link");
	});

	it("dismissAttempt removes a terminal attempt", () => {
		handleIntegrationAttempt({
			type: "integration_attempt",
			integrationID: "anthropic",
			attemptID: "att-1",
			kind: "oauth",
			phase: "complete",
		});
		dismissAttempt("anthropic", "att-1");
		expect(integrationState.attempts["anthropic:att-1"]).toBeUndefined();
	});
});

describe("pure helpers", () => {
	it("labels methods", () => {
		const methods: IntegrationMethod[] = [
			{ type: "key" },
			{ type: "oauth", id: "main", label: "Claude Pro" },
			{ type: "command", id: "cli", label: "", command: ["gh", "auth"] },
			{ type: "env", names: ["A_KEY", "B_KEY"] },
		];
		expect(methods.map(integrationMethodLabel)).toEqual([
			"API key",
			"Claude Pro",
			"Command",
			"Environment (A_KEY, B_KEY)",
		]);
	});

	it("attemptKey joins ids", () => {
		expect(attemptKey("a", "b")).toBe("a:b");
	});

	it("gates active attempts", () => {
		const base = {
			integrationID: "a",
			attemptID: "1",
			kind: "oauth" as const,
			updatedAt: 0,
		};
		expect(attemptIsActive({ ...base, phase: "started" })).toBe(true);
		expect(attemptIsActive({ ...base, phase: "pending" })).toBe(true);
		expect(attemptIsActive({ ...base, phase: "complete" })).toBe(false);
		expect(attemptIsActive({ ...base, phase: "failed" })).toBe(false);
	});

	it("labels attempt statuses", () => {
		const base = {
			integrationID: "a",
			attemptID: "1",
			kind: "oauth" as const,
			updatedAt: 0,
		};
		expect(attemptStatusLabel({ ...base, phase: "started" })).toContain(
			"Waiting",
		);
		expect(attemptStatusLabel({ ...base, phase: "complete" })).toBe(
			"Connected",
		);
		expect(
			attemptStatusLabel({ ...base, phase: "failed", message: "bad key" }),
		).toBe("bad key");
	});

	it("maps polled API statuses to phases", () => {
		expect(attemptStatusFromApi({ status: "complete" })).toBe("complete");
		expect(attemptStatusFromApi({ status: "failed", message: "x" })).toBe(
			"failed",
		);
		expect(attemptStatusFromApi({ status: "expired" })).toBe("expired");
		expect(attemptStatusFromApi({ status: "pending" })).toBe("pending");
	});
});

describe("actions", () => {
	it("requestIntegrations sends list_integrations", () => {
		const send = vi.fn();
		requestIntegrations(send);
		expect(send).toHaveBeenCalledWith({ type: "list_integrations" });
	});

	it("connectIntegrationKey sends the key + optional label", () => {
		const send = vi.fn();
		connectIntegrationKey(send, {
			integrationID: "anthropic",
			key: " sk-1 ",
			label: " work ",
		});
		expect(send).toHaveBeenCalledWith({
			type: "integration_connect_key",
			integrationID: "anthropic",
			key: "sk-1",
			label: "work",
		});
	});

	it("connectIntegrationKey ignores blank input", () => {
		const send = vi.fn();
		connectIntegrationKey(send, { integrationID: "a", key: "  " });
		expect(send).not.toHaveBeenCalled();
	});

	it("oauth actions send the right messages", () => {
		const send = vi.fn();
		startIntegrationOAuth(send, { integrationID: "a", methodID: "m" });
		pollIntegrationOAuth(send, "a", "att-1");
		completeIntegrationOAuth(send, "a", "att-1", "code");
		cancelIntegrationOAuth(send, "a", "att-1");
		expect(send).toHaveBeenNthCalledWith(1, {
			type: "integration_connect_oauth",
			integrationID: "a",
			methodID: "m",
		});
		expect(send).toHaveBeenNthCalledWith(2, {
			type: "integration_oauth_status",
			integrationID: "a",
			attemptID: "att-1",
		});
		expect(send).toHaveBeenNthCalledWith(3, {
			type: "integration_oauth_complete",
			integrationID: "a",
			attemptID: "att-1",
			code: "code",
		});
		expect(send).toHaveBeenNthCalledWith(4, {
			type: "integration_cancel_oauth",
			integrationID: "a",
			attemptID: "att-1",
		});
	});

	it("completeIntegrationOAuth omits an empty code", () => {
		const send = vi.fn();
		completeIntegrationOAuth(send, "a", "att-1", "");
		expect(send).toHaveBeenCalledWith({
			type: "integration_oauth_complete",
			integrationID: "a",
			attemptID: "att-1",
		});
	});

	it("command actions send the right messages", () => {
		const send = vi.fn();
		startIntegrationCommand(send, { integrationID: "gh", methodID: "cli" });
		pollIntegrationCommand(send, "gh", "cmd-1");
		cancelIntegrationCommand(send, "gh", "cmd-1");
		expect(send).toHaveBeenNthCalledWith(1, {
			type: "integration_connect_command",
			integrationID: "gh",
			methodID: "cli",
		});
		expect(send).toHaveBeenNthCalledWith(2, {
			type: "integration_command_status",
			integrationID: "gh",
			attemptID: "cmd-1",
		});
		expect(send).toHaveBeenNthCalledWith(3, {
			type: "integration_cancel_command",
			integrationID: "gh",
			attemptID: "cmd-1",
		});
	});
});
