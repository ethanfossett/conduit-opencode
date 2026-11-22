// ─── Shared Types ───────────────────────────────────────────────────────────
// Types shared between server and frontend.
// Imported by src/lib/types.ts (server) and frontend code.

/**
 * Branded type for request/response correlation IDs.
 * Prevents accidentally passing a session ID where a correlation ID is expected.
 * Erased at runtime — zero cost.
 */
export type RequestId = string & { readonly __brand: "RequestId" };

/**
 * Branded type for OpenCode permission entity IDs (e.g., "per_cd6d6dc8...").
 * Prevents accidentally passing a session ID or correlation ID where a
 * permission ID is expected. Erased at runtime — zero cost.
 */
export type PermissionId = string & { readonly __brand: "PermissionId" };

// ─── Base16 Theme ───────────────────────────────────────────────────────────

export const BASE16_KEYS = [
	"base00",
	"base01",
	"base02",
	"base03",
	"base04",
	"base05",
	"base06",
	"base07",
	"base08",
	"base09",
	"base0A",
	"base0B",
	"base0C",
	"base0D",
	"base0E",
	"base0F",
] as const;

export type Base16Key = (typeof BASE16_KEYS)[number];

export type Base16Theme = {
	name: string;
	author?: string;
	variant: "dark" | "light";
	/** Optional CSS variable overrides applied after Base16→CSS mapping. */
	overrides?: Record<string, string>;
} & Record<Base16Key, string>;

// ─── Todo / Progress ────────────────────────────────────────────────────────

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoItem {
	id: string;
	subject: string;
	description?: string;
	status: TodoStatus;
}

// ─── Tool Status ────────────────────────────────────────────────────────────

/** Status of a tool call — shared between server relay and frontend. */
export type ToolStatus = "pending" | "running" | "completed" | "error";

/** Part type in an assistant message — covers text, reasoning, tool calls, and structural parts. */
export type PartType =
	| "text"
	| "reasoning"
	| "tool"
	| "file"
	| "snapshot"
	| "patch"
	| "agent"
	| "compaction"
	| "subtask"
	| "retry"
	| "step-start"
	| "step-finish";

/** Canonical PascalCase tool names used by the frontend after mapping from OpenCode's lowercase names. */
export type ToolName =
	| "Read"
	| "Edit"
	| "Write"
	| "Bash"
	| "Glob"
	| "Grep"
	| "WebFetch"
	| "WebSearch"
	| "TodoWrite"
	| "TodoRead"
	| "AskUserQuestion"
	| "Task"
	| "LSP"
	| "Skill";

// ─── Agent / Model / Command info ───────────────────────────────────────────

export interface AgentInfo {
	id: string;
	name: string;
	description?: string;
}

export interface ProviderInfo {
	id: string;
	name: string;
	configured: boolean;
	models: ModelInfo[];
}

export interface ModelInfo {
	id: string;
	name: string;
	provider: string;
	cost?: { input?: number; output?: number };
	limit?: { context?: number; output?: number };
	variants?: string[];
}

export interface CommandInfo {
	name: string;
	description?: string;
	args?: string;
}

/** A skill discovered from OpenCode (GET /api/skill → Skill.Info). */
export interface SkillInfo {
	id: string;
	name: string;
	description?: string;
	/** Whether the skill can be auto-invoked by the model. */
	autoinvoke?: boolean;
	/** Absolute path to the skill definition file. */
	path?: string;
}

// ─── MCP Servers ─────────────────────────────────────────────────────────────
// Configured MCP servers and their runtime status (GET /api/mcp → Mcp.Server).
// Conduit surfaces these read-only plus connect/disconnect for the Settings UI.

/** Runtime status of an MCP server (Mcp.Status.* variants). */
export type McpServerStatus =
	| { status: "connected" }
	| { status: "pending" }
	| { status: "disabled" }
	| { status: "failed"; error: string }
	| { status: "needs_auth"; error: string };

export interface McpServerInfo {
	name: string;
	status: McpServerStatus;
	integrationID?: string;
}

export interface McpResource {
	server: string;
	name: string;
	uri: string;
	description?: string;
	mimeType?: string;
}

export interface McpResourceTemplate {
	server: string;
	name: string;
	uriTemplate: string;
	description?: string;
	mimeType?: string;
}

export interface McpResourceCatalog {
	resources: McpResource[];
	templates: McpResourceTemplate[];
}

export interface McpTimeout {
	startup?: number;
	catalog?: number;
	execution?: number;
}

export interface McpOAuthConfig {
	client_id?: string;
	client_secret?: string;
	scope?: string;
	callback_port?: number;
	redirect_uri?: string;
	auth_server_metadata_url?: string;
}

/** Config accepted by PUT /api/experimental/mcp/{server} (Mcp.*ConfigEncoded). */
export type McpServerConfig =
	| {
			type: "local";
			command: string[];
			cwd?: string;
			environment?: Record<string, string>;
			disabled?: boolean;
			codemode?: boolean;
			timeout?: McpTimeout;
			protocol?: string;
	  }
	| {
			type: "remote";
			url: string;
			headers?: Record<string, string>;
			oauth?: McpOAuthConfig | false;
			disabled?: boolean;
			codemode?: boolean;
			timeout?: McpTimeout;
			protocol?: string;
	  };

// ─── References (server-provided @-mentions) ─────────────────────────────────
// Project references exposed by OpenCode (GET /api/reference → Reference.Info).

export type ReferenceSource =
	| { type: "local"; path: string }
	| { type: "git"; repository: string; branch?: string };

export interface ReferenceInfo {
	name: string;
	path: string;
	description?: string;
	hidden?: boolean;
	source: ReferenceSource;
}

// ─── Integrations ────────────────────────────────────────────────────────────
// Available integrations and their auth methods (GET /api/integration).
// Conduit surfaces these read-only plus key/command/OAuth connect flows.

/** One authentication method advertised by an integration (Integration.Method). */
export type IntegrationMethod =
	| { type: "key"; label?: string; form?: unknown }
	| { type: "oauth"; id: string; label: string; form?: unknown }
	| { type: "command"; id: string; label: string; command: string[] }
	| { type: "env"; names: string[] };

/** A stored connection for an integration (Connection.Info, normalised). */
export interface IntegrationConnection {
	type?: string;
	credentialID?: string;
	label?: string;
	active?: boolean;
	names?: string[];
	[key: string]: unknown;
}

export interface IntegrationInfo {
	id: string;
	name: string;
	metadata?: Record<string, unknown>;
	methods: IntegrationMethod[];
	connections: IntegrationConnection[];
}

/** Details returned when an OAuth connection attempt begins. */
export interface IntegrationAttempt {
	attemptID: string;
	url?: string;
	instructions?: string;
	mode?: string;
	time?: { created?: number; expires?: number; [key: string]: unknown };
}

/** Polled status of an OAuth / command connect attempt. */
export interface IntegrationAttemptStatus {
	status: "pending" | "complete" | "failed" | "expired" | string;
	message?: string;
	time?: unknown;
}

// ─── Plugins ─────────────────────────────────────────────────────────────────
// Loaded plugins + state (GET /api/plugin → Plugin.Info).

export type PluginSource =
	| { type: "builtin" }
	| {
			type: "package";
			target: string;
			version?: string;
			outdated?: boolean;
			updating?: boolean;
	  }
	| { type: "local"; path: string }
	| { type: "sdk" };

export type PluginState =
	| { status: "active" }
	| { status: "failed"; error: string; ref?: string };

export interface PluginInfo {
	id?: string;
	source: PluginSource;
	features?: Record<string, boolean>;
	state: PluginState;
}

// ─── Integration Credentials ─────────────────────────────────────────────────
// Stored provider/integration credentials (GET/POST /api/credential).

export type CredentialValue =
	| {
			type: "key";
			key: string;
			metadata?: Record<string, unknown>;
			configuration?: unknown;
	  }
	| {
			type: "oauth";
			methodID: string;
			refresh: string;
			access: string;
			expires: number;
			metadata?: Record<string, unknown>;
	  };

export interface CredentialEntry {
	id: string;
	integrationID: string;
	label: string;
	active: boolean;
	value: CredentialValue;
}

/** Body accepted by POST /api/credential (Credential.CreateInput). */
export interface CredentialCreateInput {
	integrationID: string;
	value: CredentialValue;
	id?: string;
	label?: string;
	activate?: boolean;
}

// ─── Prompt File Attachments ─────────────────────────────────────────────────
// Wire shape of a prompt file attachment (PromptInput.FileAttachment).
// Inline bytes are carried as `data:` URIs; on-disk files use `file:` URIs.

export interface PromptFileAttachment {
	/** `data:` URI for inline bytes, or `file:` URI for an on-disk path. */
	uri: string;
	name?: string;
	description?: string;
	/** Location of the `@mention` token inside the prompt text, when known. */
	mention?: { start: number; end: number; text: string };
}

// ─── Server Info ─────────────────────────────────────────────────────────────
// Identity/readiness of the OpenCode server (GET /api/info → ServerInfo).

export interface ServerInfo {
	version: string;
	pid: number;
	urls: string[];
	paths: { tmp: string };
	capabilities?: { persistentPty?: boolean | null } | null;
}

// ─── Session Inbox ───────────────────────────────────────────────────────────
// Durable enqueued session work (GET /api/session/{id}/inbox). Conduit only
// surfaces the fields needed by the composer's queue UI.

/** Inbox delivery mode: "steer" interrupts the running turn, "queue" waits. */
export type InboxDelivery = "steer" | "queue";

/** Normalised subset of Session.Inbox.Info used by the frontend. */
export interface InboxItemInfo {
	/** Inbox item id (msg_…). Used to cancel / change delivery. */
	id: string;
	/** Item kind: user | synthetic | compaction | move. */
	type: string;
	delivery: InboxDelivery;
	/** Best-effort display text (user/synthetic payload text; empty otherwise). */
	text: string;
	/** Unix-ms creation time, when available. */
	createdAt?: number;
}

// ─── File Browser ───────────────────────────────────────────────────────────

export interface FileEntry {
	name: string;
	type: "file" | "directory";
	size?: number;
	modified?: number;
}

// ─── Session ────────────────────────────────────────────────────────────────

export interface SessionInfo {
	id: string;
	title: string;
	createdAt?: string | number;
	updatedAt?: string | number;
	messageCount?: number;
	processing?: boolean;
	/** Parent session ID — set when this session was forked from another. */
	parentID?: string;
	/** The message ID at the fork point — messages up to this ID are inherited context. */
	forkMessageId?: string;
	/** Unix-ms timestamp of the fork-point message. Messages created before
	 *  this time are inherited context from the parent session. */
	forkPointTimestamp?: number;
	/** Number of pending questions on this session (from server). */
	pendingQuestionCount?: number;
}

// ─── Ask User / Questions ───────────────────────────────────────────────────

export interface AskUserQuestion {
	question: string;
	header: string;
	options: { label: string; description?: string }[];
	multiSelect: boolean;
	custom?: boolean;
	/** v2 form field key. Used to key answers for Form.Reply.answer. */
	key?: string;
	/** v2 form field type (string/number/integer/boolean/multiselect/external). */
	fieldType?: string;
}

// ─── Usage ──────────────────────────────────────────────────────────────────

export interface UsageInfo {
	input: number;
	output: number;
	cache_read: number;
	cache_creation: number;
}

// ─── PTY / Terminal ─────────────────────────────────────────────────────────

export type PtyStatus = "running" | "exited";

export interface PtyInfo {
	id: string;
	title: string;
	command: string;
	cwd: string;
	status: PtyStatus;
	pid: number;
}

// ─── History Types ──────────────────────────────────────────────────────────

/** Shape of HistoryMessage parts (tool calls, text, reasoning, etc.) */
export interface HistoryMessagePart {
	id: string;
	type: PartType;
	/** Text content — matches OpenCode's TextPart schema (field is "text", not "content"). */
	text?: string;
	/** Server-pre-rendered HTML for assistant text parts (C3 optimization). */
	renderedHtml?: string;
	/** Tool state — present on tool-type parts, contains status/input/output. */
	state?: {
		status?: ToolStatus;
		input?: unknown;
		output?: string;
		error?: string;
		[key: string]: unknown;
	};
	callID?: string;
	tool?: string;
	time?: unknown;
	[key: string]: unknown;
}

/** A single message from the OpenCode REST history API */
export interface HistoryMessage {
	id: string;
	role: "user" | "assistant";
	parts?: HistoryMessagePart[];
	time?: { created?: number; completed?: number };
	/** Cost in dollars — present on assistant messages from REST API. */
	cost?: number;
	/** Token usage — present on assistant messages from REST API. */
	tokens?: {
		input?: number;
		output?: number;
		cache?: { read?: number; write?: number };
	};
	[key: string]: unknown;
}

// ─── Project Types ──────────────────────────────────────────────────────────

/** A project in the project list */
export interface ProjectInfo {
	slug: string;
	title: string;
	directory: string;
	clientCount?: number;
	instanceId?: string;
}

// ─── File History Types ─────────────────────────────────────────────────────

/** A file version from file history */
export interface FileVersion {
	id: string;
	path: string;
	content: string;
	timestamp: number;
	source: "edit" | "write" | "external";
	toolName?: string;
	description?: string;
	[key: string]: unknown;
}

// ─── Relay WebSocket messages ───────────────────────────────────────────────

export type RelayMessage =
	// ── Streaming ──────────────────────────────────────────────────────────
	| { type: "delta"; text: string; messageId?: string }
	| { type: "thinking_start"; messageId?: string }
	| { type: "thinking_delta"; text: string; messageId?: string }
	| { type: "thinking_stop"; messageId?: string }
	// ── Tools ──────────────────────────────────────────────────────────────
	| { type: "tool_start"; id: string; name: string; messageId?: string }
	| {
			type: "tool_executing";
			id: string;
			name: string;
			input: Record<string, unknown> | undefined;
			/** Tool part metadata — carries sessionId for Task/subagent tools. */
			metadata?: Record<string, unknown>;
			messageId?: string;
	  }
	| {
			type: "tool_result";
			id: string;
			content: string;
			is_error: boolean;
			isTruncated?: boolean;
			fullContentLength?: number;
			messageId?: string;
	  }
	| { type: "tool_content"; toolId: string; content: string }
	// ── Permissions / Questions ────────────────────────────────────────────
	| {
			type: "permission_request";
			sessionId: string;
			requestId: PermissionId;
			toolName: string;
			toolInput: Record<string, unknown>;
			toolUseId?: string;
			always?: string[];
	  }
	| { type: "permission_resolved"; requestId: PermissionId; decision: string }
	| {
			type: "ask_user";
			toolId: string;
			questions: AskUserQuestion[];
			toolUseId?: string;
	  }
	| { type: "ask_user_resolved"; toolId: string; sessionId?: string }
	| { type: "ask_user_error"; toolId: string; message: string }
	// ── Session lifecycle ──────────────────────────────────────────────────
	| {
			type: "result";
			usage: UsageInfo;
			cost: number;
			duration: number;
			sessionId: string;
			messageId?: string;
	  }
	| { type: "status"; status: string }
	| { type: "done"; code: number }
	| {
			type: "session_switched";
			id: string;
			/** Correlation ID echoed from new_session request. */
			requestId?: RequestId;
			/** Raw events for client replay (cache hit). */
			events?: RelayMessage[];
			/** When true, the event cache does not cover the full session
			 *  (eviction or late start) and the frontend should fall through
			 *  to server-based pagination when the replay buffer is exhausted. */
			eventsHasMore?: boolean;
			/** Structured messages for REST API fallback (converted to ChatMessages and prepended to chatState). */
			history?: {
				messages: HistoryMessage[];
				hasMore: boolean;
				total?: number;
			};
			/** Current input draft text for this session (from input_sync). */
			inputText?: string;
	  }
	| {
			type: "session_list";
			sessions: SessionInfo[];
			roots: boolean;
			search?: boolean;
			/** Opaque cursor for the next page of search results (search only). */
			cursor?: string;
			/** True when these sessions extend (rather than replace) prior search results. */
			append?: boolean;
	  }
	| {
			type: "session_forked";
			/** The newly created forked session. */
			session: SessionInfo;
			/** The session this was forked from. */
			parentId: string;
			/** Title of the parent session. */
			parentTitle: string;
	  }
	| {
			type: "history_page";
			sessionId: string;
			messages: HistoryMessage[];
			hasMore: boolean;
			total?: number;
	  }
	| { type: "session_compacted"; sessionId: string }
	| {
			type: "session_moved";
			sessionId: string;
			directory: string;
	  }
	// ── Model / Agent / Commands ───────────────────────────────────────────
	| { type: "model_info"; model: string; provider: string; sessionId?: string }
	| {
			type: "agent_info";
			agent: string;
			sessionId?: string;
	  }
	| {
			type: "system_prompt_info";
			/** Custom system prompt for this chat (empty string = none). */
			text: string;
			sessionId?: string;
	  }
	| {
			type: "variant_lock_info";
			provider: string;
			model: string;
			prime: string | null;
			subagent: string | null;
			modelDefault?: string | null;
			sessionId?: string;
	  }
	| {
			type: "default_model_info";
			model: string;
			provider: string;
			subagentModel?: string;
			subagentProvider?: string;
			subagentVariant?: string;
	  }
	| { type: "model_list"; providers: ProviderInfo[] }
	| { type: "agent_list"; agents: AgentInfo[]; activeAgentId?: string }
	| {
			type: "agent_library";
			agents: Array<{
				name: string;
				source: "library" | "default";
				definition: Record<string, unknown>;
			}>;
			applied: string[];
	  }
	| { type: "agent_saved"; name: string }
	| { type: "agent_deleted"; name: string; deleted: boolean }
	| {
			type: "agent_import_result";
			imported: string[];
			skipped: string[];
			invalid: string[];
	  }
	| { type: "agent_export"; bundle: unknown }
	| { type: "agents_applied"; names: string[] }
	| { type: "agents_removed"; names: string[]; removed: string[] }
	| { type: "command_list"; commands: CommandInfo[] }
	| { type: "skill_list"; skills: SkillInfo[] }
	// ── MCP servers ────────────────────────────────────────────────────────
	| { type: "mcp_list"; servers: McpServerInfo[] }
	| {
			type: "mcp_resources";
			resources: McpResource[];
			templates: McpResourceTemplate[];
	  }
	// ── Server-provided references (@-mentions) ────────────────────────────
	| { type: "reference_list"; references: ReferenceInfo[] }
	// ── Integrations (connect flows) ───────────────────────────────────────
	| { type: "integration_list"; integrations: IntegrationInfo[] }
	| {
			type: "integration_attempt";
			integrationID: string;
			attemptID: string;
			/** Which connect flow owns the attempt. */
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
	  }
	// ── Plugins ────────────────────────────────────────────────────────────
	| { type: "plugin_list"; plugins: PluginInfo[] }
	| {
			type: "plugin_updated";
			targets: string[];
			ok: boolean;
			message?: string;
	  }
	// ── Integration credentials ────────────────────────────────────────────
	| { type: "credential_list"; credentials: CredentialEntry[] }
	// ── Server info / config ───────────────────────────────────────────────
	| { type: "server_info"; info: ServerInfo }
	| { type: "config_reloaded"; ok: boolean }
	// ── Session inbox (queue vs steer) ─────────────────────────────────────
	| { type: "inbox_list"; sessionId: string; items: InboxItemInfo[] }
	// ── Projects ───────────────────────────────────────────────────────────
	| {
			type: "project_list";
			projects: readonly ProjectInfo[];
			current?: string;
			addedSlug?: string;
	  }
	| { type: "directory_list"; path: string; entries: string[] }
	// ── File browser ───────────────────────────────────────────────────────
	| { type: "file_list"; path: string; entries: FileEntry[] }
	| { type: "file_content"; path: string; content: string; binary?: boolean }
	| { type: "file_tree"; entries: string[] }
	| { type: "file_saved"; path: string }
	| { type: "file_changed"; path: string; changeType: "edited" | "external" }
	// ── VCS ────────────────────────────────────────────────────────────────
	| {
			type: "vcs_info";
			provider?: string;
			branch?: string;
			defaultBranch?: string;
			files: Array<{
				path: string;
				status: string;
				additions?: number;
				deletions?: number;
			}>;
	  }
	| {
			type: "vcs_diff";
			diffs: Array<{
				path: string;
				diff: string;
				additions: number;
				deletions: number;
				status: string;
			}>;
	  }
	// ── PTY / Terminal ─────────────────────────────────────────────────────
	| { type: "pty_created"; pty: PtyInfo }
	| { type: "pty_output"; ptyId: string; data: string }
	| { type: "pty_exited"; ptyId: string; exitCode: number }
	| { type: "pty_deleted"; ptyId: string }
	| { type: "pty_list"; ptys: PtyInfo[] }
	// ── Todo ────────────────────────────────────────────────────────────────
	| { type: "todo_state"; items: TodoItem[] }
	// ── Connection status (for frontend reconnection UI) ────────────────
	| {
			type: "connection_status";
			status: "disconnected" | "reconnecting" | "connected";
	  }
	// ── Cache / Replay ────────────────────────────────────────────────────
	| { type: "user_message"; text: string }
	| {
			type: "submission_result";
			requestId: string;
			sessionId: string;
			accepted: boolean;
	  }
	// ── Misc ────────────────────────────────────────────────────────────────
	| {
			type: "error";
			code: string;
			message: string;
			statusCode?: number;
			details?: Record<string, unknown>;
	  }
	| { type: "client_count"; count: number }
	| { type: "input_sync"; text: string; from?: string; sessionId?: string }
	| { type: "update_available"; version?: string }
	// ── Instance Management ──────────────────────────────────────────────
	| { type: "instance_list"; instances: readonly OpenCodeInstance[] }
	| {
			type: "instance_status";
			instanceId: string;
			status: InstanceStatus;
	  }
	| {
			type: "instance_update";
			instanceId: string;
			name?: string;
			env?: Record<string, string>;
			port?: number;
	  }
	// ── Variant / thinking level ────────────────────────────────────────
	| {
			type: "variant_info";
			variant?: string;
			variants?: string[];
			locked?: boolean;
			sessionId?: string;
	  }
	| { type: "proxy_detected"; found: boolean; port: number }
	| {
			type: "scan_result";
			discovered: number[];
			lost: number[];
			active: number[];
	  }
	// ── Cross-session notifications ──────────────────────────────────────
	// Broadcast to ALL clients when a notification-worthy event (done, error)
	// is dropped by the pipeline because no viewers are on that session.
	// The frontend triggers sound/browser notifications without updating
	// chat state. See ws-dispatch.ts and event-pipeline.ts.
	| {
			type: "notification_event";
			/** The original event type (done, error, etc.) */
			eventType: string;
			/** Error message (for error events) */
			message?: string;
			/** Session that triggered the event (for notification click routing) */
			sessionId?: string;
	  };

// ─── Instance Types ─────────────────────────────────────────────────────────

export type InstanceStatus = "starting" | "healthy" | "unhealthy" | "stopped";

export interface OpenCodeInstance {
	id: string;
	name: string;
	port: number;
	managed: boolean;
	status: InstanceStatus;
	pid?: number;
	env?: Record<string, string>;
	needsRestart?: boolean;
	exitCode?: number;
	lastHealthCheck?: number;
	restartCount: number;
	createdAt: number;
}

export interface InstanceConfig {
	name: string;
	port: number;
	managed: boolean;
	env?: Record<string, string>;
	/** For external (unmanaged) instances: the full URL */
	url?: string;
}

// ─── Typed API Responses ────────────────────────────────────────────────────
// Every HTTP JSON endpoint uses one of these types with `satisfies` at the
// JSON.stringify call site.  This prevents serialization bugs where fields
// are silently dropped.

/** Standard API error envelope used by all error responses. */
export interface ApiError {
	error: {
		code: string;
		message: string;
	};
}

// ─── Auth ──────────────────────────────────────────────────────────────────

export interface AuthStatusResponse {
	hasPin: boolean;
	authenticated: boolean;
}

export type AuthResponse =
	| { ok: true }
	| { ok: false; locked: true; retryAfter: number }
	| { ok: false; attemptsLeft: number };

// ─── Setup ─────────────────────────────────────────────────────────────────

export interface SetupInfoResponse {
	httpsUrl: string;
	httpUrl: string;
	hasCert: boolean;
	lanMode: boolean;
}

// ─── Health ────────────────────────────────────────────────────────────────

export interface HealthResponse {
	ok: boolean;
	projects: number;
	uptime: number;
}

// ─── Info ──────────────────────────────────────────────────────────────────

export interface InfoResponse {
	version: string;
}

// ─── Themes ────────────────────────────────────────────────────────────────

export interface ThemesResponse {
	bundled: Record<string, Base16Theme>;
	custom: Record<string, Base16Theme>;
}

// ─── Projects ──────────────────────────────────────────────────────────────

export interface DashboardProjectResponse {
	slug: string;
	path: string;
	title: string;
	status: "registering" | "ready" | "error";
	error?: string;
	sessions: number;
	clients: number;
	isProcessing: boolean;
}

export interface ProjectsListResponse {
	projects: DashboardProjectResponse[];
	version: string;
}

// ─── Project Status ────────────────────────────────────────────────────────

export interface ProjectStatusResponse {
	status: "registering" | "ready" | "error";
	error?: string;
}

// ─── Push ──────────────────────────────────────────────────────────────────

export interface VapidKeyResponse {
	publicKey: string;
}

export interface PushOkResponse {
	ok: true;
}
