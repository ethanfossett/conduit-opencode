// ─── Inbound Payload Validation ──────────────────────────────────────────────
// Lightweight, hand-written runtime guards for messages arriving at the
// WebSocket dispatch boundary. No external dependencies.
//
// `validatePayload(handler, payload)` returns a human-readable error string
// when the payload is malformed, or null when it is acceptable. Handlers
// without a guard are passed through unchanged (forward-compatible: unknown
// extra fields are always tolerated).

import type { PayloadMap } from "./payloads.js";

type Payload = Record<string, unknown>;
/** Returns an error message, or null when the payload is valid. */
type Guard = (payload: Payload) => string | null;

const isString = (v: unknown): v is string => typeof v === "string";
const isNumber = (v: unknown): v is number =>
	typeof v === "number" && Number.isFinite(v);
const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

function requireString(payload: Payload, key: string): string | null {
	if (!isString(payload[key])) return `"${key}" must be a string`;
	return null;
}

function optionalString(payload: Payload, key: string): string | null {
	const v = payload[key];
	if (v !== undefined && !isString(v)) return `"${key}" must be a string`;
	return null;
}

function requireNumber(payload: Payload, key: string): string | null {
	if (!isNumber(payload[key])) return `"${key}" must be a number`;
	return null;
}

function requireStringArray(payload: Payload, key: string): string | null {
	const v = payload[key];
	if (!Array.isArray(v) || !v.every(isString))
		return `"${key}" must be an array of strings`;
	return null;
}

/** Optional array of prompt file attachments ({uri, name?, description?}). */
function optionalFileAttachments(payload: Payload, key: string): string | null {
	const v = payload[key];
	if (v === undefined) return null;
	if (!Array.isArray(v)) return `"${key}" must be an array of objects`;
	for (const item of v) {
		if (!isObject(item) || !isString(item["uri"]) || item["uri"] === "") {
			return `"${key}" entries must be objects with a non-empty "uri"`;
		}
		if (item["name"] !== undefined && !isString(item["name"]))
			return `"${key}" entry "name" must be a string`;
	}
	return null;
}

/** Optional plain object (used for form answers). */
function optionalObject(payload: Payload, key: string): string | null {
	const v = payload[key];
	if (v !== undefined && !isObject(v)) return `"${key}" must be an object`;
	return null;
}

/** Run guards in order, returning the first error (or null). */
function first(
	payload: Payload,
	...guards: Array<(p: Payload) => string | null>
): string | null {
	for (const guard of guards) {
		const err = guard(payload);
		if (err) return err;
	}
	return null;
}

function requireOneOf(
	payload: Payload,
	key: string,
	values: readonly string[],
): string | null {
	const v = payload[key];
	if (!isString(v) || !values.includes(v))
		return `"${key}" must be one of ${values.map((x) => `"${x}"`).join(", ")}`;
	return null;
}

// ─── Guard table ─────────────────────────────────────────────────────────────

const VALIDATORS: Partial<Record<keyof PayloadMap, Guard>> = {
	message: (p) =>
		first(
			p,
			(q) => requireString(q, "text"),
			(q) => optionalFileAttachments(q, "files"),
		),
	run_command: (p) => requireString(p, "name"),
	permission_response: (p) =>
		first(
			p,
			(q) => requireString(q, "requestId"),
			(q) => requireString(q, "decision"),
		),
	ask_user_response: (p) =>
		first(
			p,
			(q) => requireString(q, "toolId"),
			(q) => (isObject(q["answers"]) ? null : '"answers" must be an object'),
		),
	question_reject: (p) => requireString(p, "toolId"),
	new_session: (p) => {
		const model = p["model"];
		if (model === undefined) return null;
		if (!isObject(model)) return '"model" must be an object';
		return (
			requireString(model, "providerID") ?? requireString(model, "modelID")
		);
	},
	switch_session: (p) => requireString(p, "sessionId"),
	view_session: (p) => requireString(p, "sessionId"),
	delete_session: (p) => requireString(p, "sessionId"),
	summarize_session: (p) => requireString(p, "sessionId"),
	rename_session: (p) =>
		first(
			p,
			(q) => requireString(q, "sessionId"),
			(q) => requireString(q, "title"),
		),
	fork_session: (p) => requireString(p, "sessionId"),
	move_session: (p) =>
		first(
			p,
			(q) => requireString(q, "sessionId"),
			(q) => requireString(q, "directory"),
		),
	search_sessions: (p) => requireString(p, "query"),
	load_more_history: (p) => requireNumber(p, "offset"),
	switch_agent: (p) => requireString(p, "agentId"),
	set_system_prompt: (p) => requireString(p, "text"),
	switch_model: (p) =>
		first(
			p,
			(q) => requireString(q, "modelId"),
			(q) => requireString(q, "providerId"),
		),
	set_default_model: (p) =>
		first(
			p,
			(q) => requireString(q, "provider"),
			(q) => requireString(q, "model"),
		),
	set_subagent_model: (p) =>
		first(
			p,
			(q) => requireString(q, "provider"),
			(q) => requireString(q, "model"),
		),
	set_model_default: (p) =>
		first(
			p,
			(q) => requireString(q, "provider"),
			(q) => requireString(q, "model"),
			(q) =>
				q["variant"] === null || isString(q["variant"])
					? null
					: '"variant" must be a string or null',
		),
	set_variant_lock: (p) =>
		first(
			p,
			(q) => requireString(q, "provider"),
			(q) => requireString(q, "model"),
			(q) => requireOneOf(q, "scope", ["prime", "subagent"]),
			(q) =>
				typeof q["locked"] === "boolean" ? null : '"locked" must be a boolean',
		),
	switch_variant: (p) => requireString(p, "variant"),
	save_agent: (p) =>
		first(
			p,
			(q) => requireString(q, "name"),
			(q) =>
				isObject(q["definition"]) ? null : '"definition" must be an object',
		),
	delete_agent: (p) => requireString(p, "name"),
	apply_agents: (p) => requireStringArray(p, "names"),
	remove_applied_agents: (p) => requireStringArray(p, "names"),
	add_project: (p) => requireString(p, "directory"),
	list_directories: (p) => requireString(p, "path"),
	remove_project: (p) => requireString(p, "slug"),
	rename_project: (p) =>
		first(
			p,
			(q) => requireString(q, "slug"),
			(q) => requireString(q, "title"),
		),
	get_file_content: (p) => requireString(p, "path"),
	save_file: (p) =>
		first(
			p,
			(q) => requireString(q, "path"),
			(q) => requireString(q, "content"),
		),
	get_tool_content: (p) => requireString(p, "toolId"),
	terminal_command: (p) =>
		first(
			p,
			(q) => requireString(q, "action"),
			(q) => optionalString(q, "ptyId"),
		),
	pty_input: (p) =>
		first(
			p,
			(q) => requireString(q, "ptyId"),
			(q) => requireString(q, "data"),
		),
	pty_resize: (p) =>
		first(
			p,
			(q) => requireString(q, "ptyId"),
			(q) =>
				q["cols"] === undefined || isNumber(q["cols"])
					? null
					: '"cols" must be a number',
			(q) =>
				q["rows"] === undefined || isNumber(q["rows"])
					? null
					: '"rows" must be a number',
		),
	pty_close: (p) => requireString(p, "ptyId"),
	rewind: (p) =>
		first(
			p,
			(q) => optionalString(q, "messageId"),
			(q) => optionalString(q, "uuid"),
			(q) => optionalString(q, "mode"),
			(q) =>
				q["files"] === undefined || typeof q["files"] === "boolean"
					? null
					: '"files" must be a boolean',
		),
	input_sync: (p) => requireString(p, "text"),
	instance_add: (p) => requireString(p, "name"),
	instance_remove: (p) => requireString(p, "instanceId"),
	instance_start: (p) => requireString(p, "instanceId"),
	instance_stop: (p) => requireString(p, "instanceId"),
	instance_update: (p) => requireString(p, "instanceId"),
	instance_rename: (p) =>
		first(
			p,
			(q) => requireString(q, "instanceId"),
			(q) => requireString(q, "name"),
		),
	set_project_instance: (p) =>
		first(
			p,
			(q) => requireString(q, "slug"),
			(q) => requireString(q, "instanceId"),
		),
	list_inbox: (p) => optionalString(p, "sessionId"),
	cancel_inbox: (p) =>
		first(
			p,
			(q) => requireString(q, "inboxId"),
			(q) => optionalString(q, "sessionId"),
		),
	set_inbox_delivery: (p) =>
		first(
			p,
			(q) => requireString(q, "inboxId"),
			(q) => requireOneOf(q, "delivery", ["steer", "queue"]),
		),
	get_skills: (p) => optionalString(p, "directory"),
	activate_skill: (p) => requireString(p, "skillId"),
	mcp_add: (p) =>
		first(
			p,
			(q) => requireString(q, "server"),
			(q) => (isObject(q["config"]) ? null : '"config" must be an object'),
		),
	mcp_remove: (p) => requireString(p, "server"),
	mcp_connect: (p) => requireString(p, "server"),
	mcp_disconnect: (p) => requireString(p, "server"),
	create_credential: (p) =>
		first(
			p,
			(q) => requireString(q, "integrationID"),
			(q) => (isObject(q["value"]) ? null : '"value" must be an object'),
		),
	update_credential: (p) =>
		first(
			p,
			(q) => requireString(q, "credentialId"),
			(q) => requireString(q, "label"),
		),
	delete_credential: (p) => requireString(p, "credentialId"),
	activate_credential: (p) => requireString(p, "credentialId"),
	nodecode_setup: (p) => {
		const action = p["action"];
		if (action !== "status" && action !== "connect" && action !== "test") {
			return '"action" must be status, connect, or test';
		}
		return (
			requireString(p, "requestId") ??
			(action === "connect"
				? requireString(p, "key")
				: optionalString(p, "key"))
		);
	},
	list_integrations: () => null,
	integration_connect_key: (p) =>
		first(
			p,
			(q) => requireString(q, "integrationID"),
			(q) => requireString(q, "key"),
			(q) => optionalString(q, "label"),
			(q) => optionalObject(q, "answer"),
		),
	integration_connect_oauth: (p) =>
		first(
			p,
			(q) => requireString(q, "integrationID"),
			(q) => requireString(q, "methodID"),
			(q) => optionalString(q, "label"),
			(q) => optionalObject(q, "answer"),
		),
	integration_oauth_status: (p) =>
		first(
			p,
			(q) => requireString(q, "integrationID"),
			(q) => requireString(q, "attemptID"),
		),
	integration_oauth_complete: (p) =>
		first(
			p,
			(q) => requireString(q, "integrationID"),
			(q) => requireString(q, "attemptID"),
			(q) => optionalString(q, "code"),
		),
	integration_cancel_oauth: (p) =>
		first(
			p,
			(q) => requireString(q, "integrationID"),
			(q) => requireString(q, "attemptID"),
		),
	integration_connect_command: (p) =>
		first(
			p,
			(q) => requireString(q, "integrationID"),
			(q) => requireString(q, "methodID"),
			(q) => optionalString(q, "label"),
		),
	integration_command_status: (p) =>
		first(
			p,
			(q) => requireString(q, "integrationID"),
			(q) => requireString(q, "attemptID"),
		),
	integration_cancel_command: (p) =>
		first(
			p,
			(q) => requireString(q, "integrationID"),
			(q) => requireString(q, "attemptID"),
		),
	check_plugins: (p) => optionalString(p, "target"),
	update_plugins: (p) =>
		first(
			p,
			(q) => requireStringArray(q, "targets"),
			(q) =>
				Array.isArray(q["targets"]) && q["targets"].length > 0
					? null
					: '"targets" must not be empty',
		),
};

/**
 * Validate an inbound payload for a handler. Returns an error message when the
 * payload is malformed, or null when it is acceptable.
 */
export function validatePayload(
	handler: string,
	payload: Record<string, unknown>,
): string | null {
	const guard = VALIDATORS[handler as keyof PayloadMap];
	if (!guard) return null;
	return guard(payload);
}
