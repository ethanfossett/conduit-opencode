import type {
	CredentialCreateInput,
	McpServerConfig,
	PermissionId,
	PromptFileAttachment,
	RequestId,
} from "../shared-types.js";

// ─── Payload Type Map ────────────────────────────────────────────────────────

/**
 * Type map for all incoming WebSocket message payloads.
 * Each key corresponds to an IncomingMessageType, and the value
 * is the expected shape of the payload for that message type.
 *
 * NOTE: At the dispatch boundary, raw JSON is cast to these types.
 * Phase 2 (Valibot) will add runtime validation.
 */
export interface PayloadMap {
	message: {
		requestId?: string;
		text: string;
		/** Bind prepared submissions to the intended session. */
		sessionId?: string;
		/** Legacy image data-URLs (kept for older clients). */
		images?: string[];
		/** Arbitrary file attachments (v2 PromptInput.FileAttachment). */
		files?: PromptFileAttachment[];
		/** Inbox delivery mode: "steer" (send now) or "queue". */
		delivery?: "steer" | "queue";
	};
	cancel: Record<string, never>;
	rewind: {
		messageId?: string;
		uuid?: string;
		/** "both" | "conversation" | "files" (legacy clients). */
		mode?: string;
		/** v2 revert semantics: true reverts file changes too. */
		files?: boolean;
	};
	input_sync: { text: string; sessionId?: string };
	permission_response: {
		requestId: PermissionId;
		decision: string;
		persistScope?: "tool" | "pattern";
		persistPattern?: string;
	};
	ask_user_response: {
		toolId: string;
		/** Answer values keyed by v2 form field key (string or multiselect array). */
		answers: Record<string, string | string[]>;
	};
	question_reject: { toolId: string };
	run_command: {
		requestId?: string;
		name: string;
		text?: string;
		sessionId?: string;
		delivery?: "steer" | "queue";
	};
	new_session: { title?: string; requestId?: RequestId };
	switch_session: { sessionId: string };
	view_session: { sessionId: string };
	delete_session: { sessionId: string };
	rename_session: { sessionId: string; title: string };
	fork_session: { sessionId: string; messageId?: string };
	summarize_session: { sessionId: string };
	move_session: { sessionId: string; directory: string };
	list_sessions: Record<string, never>;
	search_sessions: {
		query: string;
		roots?: boolean;
		/** Opaque cursor from a previous search page (for "load more"). */
		cursor?: string;
		/** Max results per page. */
		limit?: number;
	};
	load_more_history: { sessionId?: string; offset: number };
	get_agents: Record<string, never>;
	switch_agent: { agentId: string; sessionId?: string };
	set_system_prompt: { text: string; sessionId?: string };
	list_agent_library: Record<string, never>;
	save_agent: { name: string; definition: Record<string, unknown> };
	delete_agent: { name: string };
	import_agents: { bundle: unknown; overwrite?: boolean };
	export_agents: Record<string, never>;
	apply_agents: { names: string[] };
	remove_applied_agents: { names: string[] };
	get_models: Record<string, never>;
	switch_model: { modelId: string; providerId: string; sessionId?: string };
	set_default_model: { provider: string; model: string };
	set_subagent_model: { provider: string; model: string; variant?: string };
	set_model_default: {
		provider: string;
		model: string;
		variant: string | null;
		sessionId?: string;
	};
	set_variant_lock: {
		provider: string;
		model: string;
		scope: "prime" | "subagent";
		locked: boolean;
		variant?: string;
		sessionId?: string;
	};
	switch_variant: { variant: string; sessionId?: string };
	get_commands: Record<string, never>;
	list_inbox: { sessionId?: string };
	cancel_inbox: { inboxId: string; sessionId?: string };
	set_inbox_delivery: {
		inboxId: string;
		delivery: "steer" | "queue";
		sessionId?: string;
	};
	get_skills: { directory?: string };
	activate_skill: { skillId: string; sessionId?: string; resume?: boolean };
	get_projects: Record<string, never>;
	add_project: { directory: string; instanceId?: string };
	list_directories: { path: string };
	remove_project: { slug: string };
	rename_project: { slug: string; title: string };
	get_file_list: { path?: string };
	get_file_content: { path: string };
	get_file_tree: Record<string, never>;
	save_file: { path: string; content: string };
	get_vcs: Record<string, never>;
	get_vcs_diff: {
		mode?: "working" | "branch" | "committed";
		base?: string;
		context?: number;
	};
	get_tool_content: { toolId: string };
	terminal_command: { action: string; ptyId?: string };
	pty_create: Record<string, never>;
	pty_input: { ptyId: string; data: string };
	pty_resize: { ptyId: string; cols?: number; rows?: number };
	pty_close: { ptyId: string };
	instance_add: {
		name: string;
		url?: string;
		managed?: boolean;
		port?: number;
		env?: Record<string, string>;
	};
	instance_remove: { instanceId: string };
	instance_start: { instanceId: string };
	instance_stop: { instanceId: string };
	instance_update: {
		instanceId: string;
		name?: string;
		port?: number;
		env?: Record<string, string>;
	};
	set_project_instance: { slug: string; instanceId: string };
	instance_rename: { instanceId: string; name: string };
	proxy_detect: Record<string, never>;
	scan_now: Record<string, never>;
	// ── MCP servers ──────────────────────────────────────────────────────────
	list_mcp: Record<string, never>;
	list_mcp_resources: Record<string, never>;
	mcp_add: { server: string; config: McpServerConfig };
	mcp_remove: { server: string };
	mcp_connect: { server: string };
	mcp_disconnect: { server: string };
	// ── Integration credentials ───────────────────────────────────────────────
	list_credentials: Record<string, never>;
	create_credential: CredentialCreateInput;
	update_credential: { credentialId: string; label: string };
	delete_credential: { credentialId: string };
	activate_credential: { credentialId: string };
	// ── Integrations (connect flows) ──────────────────────────────────────────
	list_integrations: Record<string, never>;
	integration_connect_key: {
		integrationID: string;
		key: string;
		label?: string;
		answer?: Record<string, unknown>;
	};
	integration_connect_oauth: {
		integrationID: string;
		methodID: string;
		label?: string;
		answer?: Record<string, unknown>;
	};
	integration_oauth_status: { integrationID: string; attemptID: string };
	integration_oauth_complete: {
		integrationID: string;
		attemptID: string;
		code?: string;
	};
	integration_cancel_oauth: { integrationID: string; attemptID: string };
	integration_connect_command: {
		integrationID: string;
		methodID: string;
		label?: string;
	};
	integration_command_status: { integrationID: string; attemptID: string };
	integration_cancel_command: { integrationID: string; attemptID: string };
	// ── Plugins ───────────────────────────────────────────────────────────────
	list_plugins: Record<string, never>;
	check_plugins: { target?: string };
	update_plugins: { targets: string[] };
	// ── Server-provided references ────────────────────────────────────────────
	get_references: Record<string, never>;
	// ── Server info / config ──────────────────────────────────────────────────
	get_server_info: Record<string, never>;
	reload_config: Record<string, never>;
}
