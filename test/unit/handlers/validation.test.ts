// ─── Inbound payload validation ──────────────────────────────────────────────

import { describe, expect, it } from "vitest";
import { validatePayload } from "../../../src/lib/handlers/validation.js";

describe("validatePayload", () => {
	it("accepts a well-formed message", () => {
		expect(validatePayload("message", { text: "hello" })).toBeNull();
	});

	it("rejects a message without string text", () => {
		expect(validatePayload("message", {})).toMatch(/text/);
		expect(validatePayload("message", { text: 42 })).toMatch(/text/);
	});

	it("rejects pty_input without ptyId or data", () => {
		expect(validatePayload("pty_input", { ptyId: "pty-1" })).toMatch(/data/);
		expect(validatePayload("pty_input", { data: "ls" })).toMatch(/ptyId/);
		expect(validatePayload("pty_input", { ptyId: "p", data: "ls" })).toBeNull();
	});

	it("allows optional pty_resize numbers but rejects wrong types", () => {
		expect(validatePayload("pty_resize", { ptyId: "p" })).toBeNull();
		expect(validatePayload("pty_resize", { ptyId: "p", cols: "80" })).toMatch(
			/cols/,
		);
		expect(
			validatePayload("pty_resize", { ptyId: "p", cols: 80, rows: 24 }),
		).toBeNull();
	});

	it("validates permission_response required fields", () => {
		expect(
			validatePayload("permission_response", {
				requestId: "per_1",
				decision: "once",
			}),
		).toBeNull();
		expect(
			validatePayload("permission_response", { requestId: "per_1" }),
		).toMatch(/decision/);
	});

	it("validates ask_user_response answers object", () => {
		expect(
			validatePayload("ask_user_response", {
				toolId: "t1",
				answers: { q1: "a" },
			}),
		).toBeNull();
		expect(
			validatePayload("ask_user_response", { toolId: "t1", answers: "nope" }),
		).toMatch(/answers/);
	});

	it("validates apply_agents names array", () => {
		expect(validatePayload("apply_agents", { names: ["a", "b"] })).toBeNull();
		expect(validatePayload("apply_agents", { names: "a" })).toMatch(/names/);
		expect(validatePayload("apply_agents", { names: [1] })).toMatch(/names/);
	});

	it("enforces the inbox delivery enum", () => {
		expect(
			validatePayload("set_inbox_delivery", {
				inboxId: "msg_1",
				delivery: "queue",
			}),
		).toBeNull();
		expect(
			validatePayload("set_inbox_delivery", {
				inboxId: "msg_1",
				delivery: "later",
			}),
		).toMatch(/delivery/);
	});

	it("validates activate_skill skillId", () => {
		expect(validatePayload("activate_skill", { skillId: "s1" })).toBeNull();
		expect(validatePayload("activate_skill", {})).toMatch(/skillId/);
	});

	it("validates MCP server payloads", () => {
		expect(validatePayload("mcp_connect", { server: "github" })).toBeNull();
		expect(validatePayload("mcp_connect", {})).toMatch(/server/);
		expect(
			validatePayload("mcp_add", {
				server: "github",
				config: { type: "remote", url: "https://x" },
			}),
		).toBeNull();
		expect(validatePayload("mcp_add", { server: "github" })).toMatch(/config/);
	});

	it("validates credential payloads", () => {
		expect(
			validatePayload("create_credential", {
				integrationID: "anthropic",
				value: { type: "key", key: "sk-1" },
			}),
		).toBeNull();
		expect(
			validatePayload("create_credential", { integrationID: "anthropic" }),
		).toMatch(/value/);
		expect(
			validatePayload("update_credential", {
				credentialId: "cred-1",
				label: "Work",
			}),
		).toBeNull();
		expect(
			validatePayload("update_credential", { credentialId: "cred-1" }),
		).toMatch(/label/);
		expect(
			validatePayload("activate_credential", { credentialId: "cred-1" }),
		).toBeNull();
		expect(validatePayload("delete_credential", {})).toMatch(/credentialId/);
	});

	it("passes through handlers without a guard", () => {
		expect(validatePayload("cancel", {})).toBeNull();
		expect(validatePayload("list_sessions", {})).toBeNull();
		expect(validatePayload("unknown_handler", { anything: true })).toBeNull();
	});

	it("validates message file attachments", () => {
		expect(
			validatePayload("message", {
				text: "hi",
				files: [
					{ uri: "data:text/plain;base64,aGk=", name: "a.txt" },
					{ uri: "file:///x" },
				],
			}),
		).toBeNull();
		expect(validatePayload("message", { text: "hi", files: "nope" })).toMatch(
			/files/,
		);
		expect(
			validatePayload("message", { text: "hi", files: [{ name: "a.txt" }] }),
		).toMatch(/uri/);
		expect(
			validatePayload("message", { text: "hi", files: [{ uri: "" }] }),
		).toMatch(/uri/);
		expect(
			validatePayload("message", {
				text: "hi",
				files: [{ uri: "x", name: 1 }],
			}),
		).toMatch(/name/);
	});

	it("validates integration connect payloads", () => {
		expect(
			validatePayload("integration_connect_key", {
				integrationID: "anthropic",
				key: "sk-1",
			}),
		).toBeNull();
		expect(
			validatePayload("integration_connect_key", {
				integrationID: "anthropic",
			}),
		).toMatch(/key/);
		expect(
			validatePayload("integration_connect_oauth", {
				integrationID: "anthropic",
				methodID: "claude-pro",
			}),
		).toBeNull();
		expect(
			validatePayload("integration_connect_oauth", {
				integrationID: "anthropic",
			}),
		).toMatch(/methodID/);
		expect(
			validatePayload("integration_connect_oauth", {
				integrationID: "anthropic",
				methodID: "m",
				answer: "nope",
			}),
		).toMatch(/answer/);
		expect(
			validatePayload("integration_oauth_status", {
				integrationID: "a",
				attemptID: "att-1",
			}),
		).toBeNull();
		expect(
			validatePayload("integration_oauth_status", { integrationID: "a" }),
		).toMatch(/attemptID/);
		expect(
			validatePayload("integration_oauth_complete", {
				integrationID: "a",
				attemptID: "att-1",
				code: "123",
			}),
		).toBeNull();
		expect(
			validatePayload("integration_oauth_complete", {
				integrationID: "a",
				attemptID: "att-1",
				code: 123,
			}),
		).toMatch(/code/);
		expect(
			validatePayload("integration_cancel_oauth", {
				integrationID: "a",
				attemptID: "att-1",
			}),
		).toBeNull();
		expect(
			validatePayload("integration_connect_command", {
				integrationID: "a",
				methodID: "cli",
			}),
		).toBeNull();
		expect(
			validatePayload("integration_command_status", {
				integrationID: "a",
				attemptID: "att-1",
			}),
		).toBeNull();
		expect(
			validatePayload("integration_cancel_command", { attemptID: "att-1" }),
		).toMatch(/integrationID/);
	});

	it("validates plugin payloads", () => {
		expect(validatePayload("list_plugins", {})).toBeNull();
		expect(validatePayload("check_plugins", {})).toBeNull();
		expect(validatePayload("check_plugins", { target: "x" })).toBeNull();
		expect(validatePayload("check_plugins", { target: 1 })).toMatch(/target/);
		expect(validatePayload("update_plugins", { targets: ["a"] })).toBeNull();
		expect(validatePayload("update_plugins", { targets: [] })).toMatch(
			/targets/,
		);
		expect(validatePayload("update_plugins", { targets: "a" })).toMatch(
			/targets/,
		);
	});

	it("tolerates extra unknown fields", () => {
		expect(
			validatePayload("message", { text: "hi", extra: { nested: true } }),
		).toBeNull();
	});
});
