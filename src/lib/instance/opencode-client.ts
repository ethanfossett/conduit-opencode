// ─── OpenCode v2 REST API Client ────────────────────────────────────────────
// Typed HTTP client wrapper for OpenCode's v2 HttpApi. The v2 server mounts its
// JSON API exclusively under `/api/*` (the origin root serves the web app HTML),
// so every request below is issued against `${origin}${API_PREFIX}${path}`.
//
// All state lives in OpenCode. The relay never caches or duplicates.
//
// The public method surface is intentionally unchanged from the previous (v1)
// client so the relay, bridges, handlers and session layer keep working; the
// v2 response envelopes ({ data } / { location, data }) and the v2 message
// shape (tagged-union content) are normalised back into conduit's flat
// `SessionDetail` / `Message` shapes here.

import { DEFAULT_OPENCODE_URL } from "../constants.js";
import { ENV } from "../env.js";
import { OpenCodeApiError, OpenCodeConnectionError } from "../errors.js";
import { createLogger } from "../logger.js";
import type {
	CredentialCreateInput,
	CredentialEntry,
	IntegrationAttempt,
	IntegrationAttemptStatus,
	IntegrationInfo,
	McpResourceCatalog,
	McpServerConfig,
	McpServerInfo,
	PluginInfo,
	PromptFileAttachment,
	ReferenceInfo,
	ServerInfo,
	SkillInfo,
} from "../shared-types.js";

const log = createLogger("opencode-client");

/** Every v2 endpoint lives under this prefix. */
const API_PREFIX = "/api";

// ─── Types (conduit-facing, unchanged) ───────────────────────────────────────

export interface OpenCodeClientOptions {
	baseUrl?: string;
	auth?: { username: string; password: string };
	timeout?: number;
	retries?: number;
	retryDelay?: number;
	/** Absolute directory path for per-project scoping via x-opencode-directory header. */
	directory?: string;
}

export interface SessionCreateOptions {
	title?: string;
	agentID?: string;
	providerID?: string;
	modelID?: string;
}

/** v2 session list sort order. */
export type SessionOrder = "asc" | "desc";

export interface SessionListOptions {
	archived?: boolean;
	/** Convenience for parentID="null" (root sessions only). */
	roots?: boolean;
	limit?: number;
	/** Sort order for the first page (v2 `order`). */
	order?: SessionOrder;
	/** Server-side full-text search (v2 `search`). */
	search?: string;
	/**
	 * Filter by parent session: the literal string "null" returns root sessions
	 * only, or a `ses_...` ID returns that session's direct children.
	 */
	parentID?: string;
	/** Location filter (v2 `directory`). */
	directory?: string;
	/** Project filter (v2 `project`). */
	project?: string;
	/** Subpath filter (v2 `subpath`). */
	subpath?: string;
	/** Opaque pagination cursor from a previous page's `cursor.next`. */
	cursor?: string;
	/** Abort signal — cancels the request (used to supersede stale searches). */
	signal?: AbortSignal;
}

/** A page of sessions plus the opaque cursors for neighbouring pages. */
export interface SessionListPage {
	sessions: SessionDetail[];
	cursor: { previous?: string | null; next?: string | null };
}

export type SessionStatus = { type: "idle" } | { type: "busy" };

export interface PromptOptions {
	text: string;
	/** Legacy image data-URLs; normalised into `files` when sent. */
	images?: string[];
	/**
	 * Arbitrary file attachments (v2 PromptInput.FileAttachment). Inline bytes
	 * are passed as `data:` URIs; on-disk files as `file:` URIs.
	 */
	files?: PromptFileAttachment[];
	agent?: string;
	model?: { providerID: string; modelID: string };
	variant?: string;
	/**
	 * Custom system prompt appended to OpenCode's own system prompt for this
	 * message only. Used to give each chat a user-defined system prompt.
	 *
	 * NOTE(v2): the v2 prompt endpoint has no `system` field, so this is
	 * delivered as a hidden synthetic input (see sendMessageAsync).
	 */
	system?: string;
	/**
	 * Inbox delivery mode for this prompt (Session.Inbox.Delivery):
	 * "steer" interrupts/wakes the running turn, "queue" waits its turn.
	 * Omitted → OpenCode's default ("steer").
	 */
	delivery?: "steer" | "queue";
	/** Whether to resume execution after enqueueing (v2 `resume`). */
	resume?: boolean;
}

/** Options for running a slash command (v2 POST /session/{id}/command). */
export interface RunCommandOptions {
	/** Command name without the leading slash, e.g. "init". */
	name: string;
	/** Command arguments (the text after the command name). */
	text?: string;
	files?: Array<Record<string, unknown>>;
	agents?: Array<Record<string, unknown>>;
	skills?: Array<Record<string, unknown>>;
	/** Inbox delivery mode: "steer" (default) or "queue". */
	delivery?: string;
}

/** A single permission rule in a v2 Permission.Ruleset. */
export interface PermissionRule {
	action: string;
	resource: string;
	effect: "allow" | "deny" | "ask";
}

/** A v2 saved permission (GET /api/permission/saved). */
export interface SavedPermissionInfo {
	id: string;
	projectID: string;
	action: string;
	resource: string;
	time: { created: number; updated: number };
}

export interface PermissionReplyOptions {
	id: string;
	/** Session that owns the permission request (v2 permissions are session-scoped). */
	sessionId?: string;
	decision: "once" | "always" | "reject";
}

export interface QuestionReplyOptions {
	id: string;
	/** Session that owns the form (v2 questions are session-scoped forms). */
	sessionId?: string;
	answers: string[][];
}

export interface Agent {
	id: string;
	name: string;
	description?: string;
	/** Agent mode: "primary" (user-facing), "subagent" (task tool), or "all" */
	mode?: string;
	/** Whether the agent is hidden from user selection */
	hidden?: boolean;
}

export interface Provider {
	id: string;
	name: string;
	models?: Array<{
		id: string;
		name: string;
		limit?: { context?: number; output?: number };
		variants?: Record<string, Record<string, unknown>>;
	}>;
}

export interface ProviderListResult {
	providers: Provider[];
	defaults: Record<string, string>;
	connected: string[];
}

export interface PtyCreateOptions {
	command?: string;
	args?: string[];
	cwd?: string;
}

export interface HealthResponse {
	ok: boolean;
	version?: string;
}

export interface SessionDetail {
	id: string;
	slug?: string;
	title?: string;
	version?: string;
	projectID?: string;
	directory?: string;
	parentID?: string;
	time?: {
		created?: number;
		updated?: number;
		compacting?: number;
		archived?: number;
	};
	/** @deprecated Use time.archived instead */
	archived?: boolean;
	agentID?: string;
	providerID?: string;
	modelID?: string;
	variant?: string;
}

export interface Message {
	id: string;
	role: string;
	sessionID: string;
	parts?: Array<{
		id: string;
		type: string;
		[key: string]: unknown;
	}>;
	cost?: number;
	tokens?: {
		input?: number;
		output?: number;
		cache?: { read?: number; write?: number };
	};
	time?: { created?: number; completed?: number };
}

// ─── Types (OpenCode v2 wire shapes) ─────────────────────────────────────────

interface V2ModelRef {
	id: string;
	providerID: string;
	variant?: string;
}

interface V2TokenUsage {
	input: number;
	output: number;
	reasoning?: number;
	cache?: { read: number; write: number };
}

interface V2SessionInfo {
	id: string;
	parentID?: string;
	projectID: string;
	agent?: string;
	model?: V2ModelRef;
	cost?: number;
	tokens?: V2TokenUsage;
	outcome?: string;
	time: { created: number; updated: number; idle?: number; archived?: number };
	title?: string;
	subpath?: string;
	location?: { directory?: string };
}

interface V2StructuredError {
	type?: string;
	message: string;
	status?: number;
	response?: { body: string };
}

type V2ToolContent =
	| { type: "text"; text: string }
	| { type: "file"; uri: string; mime: string; name?: string | null };

type V2ToolState =
	| { status: "streaming"; input: string }
	| { status: "running"; input: unknown; metadata: unknown }
	| {
			status: "completed";
			input: unknown;
			content: V2ToolContent[];
			metadata?: unknown;
	  }
	| {
			status: "error";
			input: unknown;
			error: V2StructuredError;
			content?: V2ToolContent[];
			metadata?: unknown;
	  };

type V2AssistantContent =
	| { type: "text"; text: string; state?: unknown }
	| {
			type: "reasoning";
			text: string;
			state?: unknown;
			time?: { created: number; completed?: number };
	  }
	| {
			type: "tool";
			id: string;
			name: string;
			executed?: boolean;
			state: V2ToolState;
			time?: { created?: number; ran?: number; completed?: number };
	  };

interface V2MessageBase {
	id: string;
	time?: { created?: number; completed?: number; streamed?: number };
}

interface V2MessageUser extends V2MessageBase {
	type: "user";
	text: string;
}

interface V2MessageAssistant extends V2MessageBase {
	type: "assistant";
	agent?: string;
	model?: V2ModelRef;
	content?: V2AssistantContent[];
	cost?: number;
	tokens?: V2TokenUsage;
	error?: V2StructuredError;
}

interface V2MessageCompaction extends V2MessageBase {
	type: "compaction";
	summary?: string;
	status?: string;
}

type V2Message =
	| V2MessageUser
	| V2MessageAssistant
	| V2MessageCompaction
	| (V2MessageBase & { type: string; [key: string]: unknown });

interface V2PermissionRequest {
	id: string;
	sessionID: string;
	action: string;
	resources?: string[];
	save?: string[];
	metadata?: Record<string, unknown>;
	message?: string;
}

interface V2FormField {
	key?: string;
	type?: string;
	title?: string;
	description?: string;
	required?: boolean;
	options?: Array<{ value: unknown; label: string; description?: string }>;
	[key: string]: unknown;
}

interface V2FormInfo {
	id: string;
	sessionID?: string;
	title?: string;
	metadata?: Record<string, unknown>;
	fields?: Record<string, V2FormField> | V2FormField[];
}

interface V2Pty {
	id: string;
	title?: string;
	command?: string;
	args?: string[];
	cwd?: string;
	status?: string;
	pid?: number;
	exitCode?: number;
}

// ─── Skills (v2) ─────────────────────────────────────────────────────────────

interface V2Skill {
	id: string;
	name: string;
	description?: string;
	autoinvoke?: boolean;
	path?: string;
	content?: string;
}

// ─── Persistent PTY (v2 experimental) ────────────────────────────────────────

/** Non-exported wire shape of PersistentPty.Info. */
interface V2PersistentPty {
	id: string;
	title: string;
	command: string;
	args: string[];
	cwd: string;
	status: "running" | "exited";
	pid: number;
	exitCode?: number;
	sessionID: string;
	foregroundProcess: string | null;
	size: { cols: number; rows: number };
	output: { head: number; tail: number };
}

/** Public shape exposed to the relay — mirrors PersistentPty.Info. */
export interface PersistentPtyInfo {
	id: string;
	title: string;
	command: string;
	args: string[];
	cwd: string;
	status: "running" | "exited";
	pid: number;
	exitCode?: number;
	sessionID: string;
	foregroundProcess: string | null;
	size: { cols: number; rows: number };
	output: { head: number; tail: number };
}

/** Input for creating a persistent terminal (PersistentPty.CreateInput). */
export interface PersistentPtyCreateInput {
	command?: string;
	args: string[];
	title: string;
	cwd?: string;
	env: Record<string, string>;
	size?: { cols: number; rows: number };
}

/** A persistent PTY snapshot (PersistentPty.Snapshot). */
export interface PersistentPtySnapshot {
	info: PersistentPtyInfo;
	text: string;
	checkpoint: string;
	cursor: { x: number; y: number };
}

/** The last screen of a session's most recently controlled terminal. */
export interface PersistentPtyReadResult {
	ptyID: string;
	title: string;
	cwd: string;
	foregroundProcess: string | null;
	screen: {
		text: string;
		cols: number;
		rows: number;
		cursor: { x: number; y: number };
	};
}

// ─── Session inbox (queue vs steer) ──────────────────────────────────────────

/** Wire shape of a Session.Inbox.Info entry. */
export interface V2InboxItem {
	id: string;
	sessionID: string;
	time: { created: number };
	type: string;
	delivery: "steer" | "queue";
	payload?: { text?: string; [key: string]: unknown };
}

interface V2FileSystemEntry {
	path: string;
	type: "file" | "directory";
}

interface V2FileDiff {
	file: string;
	patch: string;
	additions: number;
	deletions: number;
	status: string;
}

interface V2Agent {
	id: string;
	name: string;
	description?: string;
	mode?: string;
	hidden?: boolean;
}

interface V2ModelInfo {
	id: string;
	modelID: string;
	providerID: string;
	name?: string;
	variants?: Array<{ id: string }>;
	limit?: { context?: number; input?: number; output?: number };
	enabled?: boolean;
}

interface V2ProviderInfo {
	id: string;
	name: string;
	activation?: string;
}

// ─── Wire helpers ────────────────────────────────────────────────────────────

/** Unwrap a single-object v2 response envelope (`{ data }`). */
function unwrapData<T>(res: unknown): T {
	if (res && typeof res === "object" && "data" in (res as object)) {
		return (res as { data: T }).data;
	}
	return res as T;
}

/** Unwrap a list v2 response envelope (`{ location, data }` or `{ data }`). */
function unwrapList<T>(res: unknown): T[] {
	if (Array.isArray(res)) return res as T[];
	if (res && typeof res === "object") {
		const data = (res as { data?: unknown }).data;
		if (Array.isArray(data)) return data as T[];
	}
	return [];
}

/** Best-effort display name for an inline `data:` URI attachment. */
function dataUrlFileName(uri: string, fallback = "image"): string | undefined {
	const match = uri.match(/^data:([^;,]+)/);
	if (!match?.[1]) return undefined;
	const subtype = match[1].split("/")[1]?.split("+")[0];
	if (!subtype) return undefined;
	return `${fallback}.${subtype === "jpeg" ? "jpg" : subtype}`;
}

// ─── v2 → conduit mapping ────────────────────────────────────────────────────

function mapSession(s: V2SessionInfo): SessionDetail {
	const detail: SessionDetail = {
		id: s.id,
		projectID: s.projectID,
	};
	if (s.title !== undefined) detail.title = s.title;
	if (s.parentID !== undefined) detail.parentID = s.parentID;
	if (s.agent !== undefined) detail.agentID = s.agent;
	if (s.model) {
		detail.providerID = s.model.providerID;
		detail.modelID = s.model.id;
		if (s.model.variant !== undefined) detail.variant = s.model.variant;
	}
	if (s.location?.directory !== undefined)
		detail.directory = s.location.directory;
	detail.time = {
		...(s.time?.created !== undefined && { created: s.time.created }),
		...(s.time?.updated !== undefined && { updated: s.time.updated }),
		...(s.time?.archived !== undefined && { archived: s.time.archived }),
	};
	return detail;
}

/** Collapse a v2 tool `content` array into a display string. */
function toolContentToText(content: V2ToolContent[] | undefined): string {
	if (!content || content.length === 0) return "";
	return content
		.map((c) => {
			if (c.type === "text") return c.text;
			return `[file: ${c.name ?? c.uri}]`;
		})
		.join("\n");
}

function mapToolState(state: V2ToolState): {
	status: string;
	input?: unknown;
	output?: string;
	error?: unknown;
	metadata?: unknown;
} {
	switch (state.status) {
		case "streaming":
			return { status: "pending", input: state.input };
		case "running":
			return {
				status: "running",
				input: state.input,
				metadata: state.metadata,
			};
		case "completed":
			return {
				status: "completed",
				input: state.input,
				output: toolContentToText(state.content),
				...(state.metadata !== undefined && { metadata: state.metadata }),
			};
		case "error":
			return {
				status: "error",
				input: state.input,
				output: toolContentToText(state.content),
				error: state.error?.message ?? state.error,
				...(state.metadata !== undefined && { metadata: state.metadata }),
			};
	}
}

function mapMessage(raw: unknown, sessionId: string): Message | null {
	if (!raw || typeof raw !== "object") return null;
	const msg = raw as V2Message;
	if (typeof msg.id !== "string") {
		log.warn("Dropping malformed v2 message:", (msg as { id?: unknown }).id);
		return null;
	}

	const parts: Array<{ id: string; type: string; [key: string]: unknown }> = [];
	const base: Message = {
		id: msg.id,
		role: "assistant",
		sessionID: sessionId,
		parts,
	};
	if (msg.time?.created !== undefined || msg.time?.completed !== undefined) {
		base.time = {
			...(msg.time?.created !== undefined && { created: msg.time.created }),
			...(msg.time?.completed !== undefined && {
				completed: msg.time.completed,
			}),
		};
	}

	switch (msg.type) {
		case "user": {
			base.role = "user";
			const user = msg as V2MessageUser;
			parts.push({
				id: `${msg.id}-text`,
				type: "text",
				text: user.text ?? "",
			});
			return base;
		}
		case "assistant": {
			const a = msg as V2MessageAssistant;
			base.role = "assistant";
			if (a.cost !== undefined) base.cost = a.cost;
			if (a.tokens) {
				base.tokens = {
					input: a.tokens.input,
					output: a.tokens.output,
					...(a.tokens.cache && { cache: a.tokens.cache }),
				};
			}
			let idx = 0;
			for (const c of a.content ?? []) {
				if (c.type === "text") {
					parts.push({ id: `${msg.id}-t${idx++}`, type: "text", text: c.text });
				} else if (c.type === "reasoning") {
					parts.push({
						id: `${msg.id}-r${idx++}`,
						type: "reasoning",
						text: c.text,
						...(c.time && {
							time: { start: c.time.created, end: c.time.completed },
						}),
					});
				} else if (c.type === "tool") {
					parts.push({
						id: c.id,
						type: "tool",
						callID: c.id,
						tool: c.name,
						state: mapToolState(c.state),
						...(c.time && {
							time: { start: c.time.created, end: c.time.completed },
						}),
					});
				}
			}
			return base;
		}
		case "compaction": {
			const c = msg as V2MessageCompaction;
			base.role = "assistant";
			parts.push({
				id: msg.id,
				type: "compaction",
				summary: c.summary,
				status: c.status,
			});
			return base;
		}
		default:
			// shell / synthetic / system / skill / idle / agentSelected /
			// modelSelected / locationSwitched are not part of conduit's
			// history protocol and are skipped.
			return null;
	}
}

/**
 * Normalise a v2 message list into conduit's internal chronological order.
 *
 * OpenCode v2 returns messages NEWEST-FIRST (the list cursor encodes
 * `"order":"desc"`). Conduit's `Message[]` contract is the opposite — session
 * history, pagination cursors, the message poller and the frontend all assume
 * oldest-first. Reversing here restores that contract at the API boundary so
 * session_switched history is not delivered upside-down (which previously
 * rendered the newest reply at the top and the oldest turn at the bottom).
 */
export function mapMessages(raw: unknown, sessionId: string): Message[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.map((m) => mapMessage(m, sessionId))
		.filter((m): m is Message => m !== null)
		.reverse();
}

// ─── Client ──────────────────────────────────────────────────────────────────

export class OpenCodeClient {
	private readonly baseUrl: string;
	private readonly headers: Record<string, string>;
	private readonly timeout: number;
	private readonly retries: number;
	private readonly retryDelay: number;
	/**
	 * Last custom system prompt injected as a synthetic input per session.
	 * Synthetic messages persist in OpenCode's history, so re-injecting an
	 * unchanged prompt on every turn would accumulate duplicates.
	 */
	private readonly injectedSystemPrompts = new Map<string, string>();

	constructor(options: OpenCodeClientOptions = {}) {
		this.baseUrl = (options.baseUrl ?? DEFAULT_OPENCODE_URL).replace(
			/\/+$/,
			"",
		);
		this.timeout = options.timeout ?? 10_000;
		this.retries = options.retries ?? 2;
		this.retryDelay = options.retryDelay ?? 1000;

		this.headers = {
			"Content-Type": "application/json",
			Accept: "application/json",
		};

		// HTTP Basic Auth from options or env vars
		const password = options.auth?.password ?? ENV.opencodePassword;
		const username = options.auth?.username ?? ENV.opencodeUsername;
		if (password) {
			const encoded = Buffer.from(`${username}:${password}`).toString("base64");
			this.headers["Authorization"] = `Basic ${encoded}`;
		}

		// Per-project directory scoping (v2 honours x-opencode-directory)
		if (options.directory) {
			this.headers["x-opencode-directory"] = options.directory;
		}
	}

	/** V2 location-aware provider routes accept an explicit directory query. */
	private atLocation(path: string): string {
		const directory = this.headers["x-opencode-directory"];
		return directory
			? `${path}?location[directory]=${encodeURIComponent(directory)}`
			: path;
	}

	// ─── System ──────────────────────────────────────────────────────────────

	async getHealth(): Promise<HealthResponse> {
		// Prefer /api/info (identity + readiness). Fall back to the cheap
		// authenticated /api/location probe when /info is unavailable.
		try {
			const info = await this.getServerInfo();
			return {
				ok: true,
				...(info.version ? { version: info.version } : {}),
			} as HealthResponse;
		} catch {
			await this.get("/location");
			return { ok: true } as HealthResponse;
		}
	}

	/** Current VCS provider + branch (v2 GET /api/vcs). */
	async getVcs(): Promise<{
		provider?: string;
		branch?: string;
		defaultBranch?: string;
	}> {
		const res = await this.get("/vcs");
		const data = unwrapData<{
			provider?: string;
			branch?: { current?: string; default?: string };
		}>(res);
		return {
			...(data?.provider !== undefined && { provider: data.provider }),
			...(data?.branch?.current !== undefined && {
				branch: data.branch.current,
			}),
			...(data?.branch?.default !== undefined && {
				defaultBranch: data.branch.default,
			}),
		};
	}

	/** List branches (v2 GET /api/vcs/branch). */
	async listVcsBranches(options?: {
		search?: string;
		limit?: number;
	}): Promise<string[]> {
		const params = new URLSearchParams();
		if (options?.search !== undefined) params.set("search", options.search);
		if (options?.limit !== undefined)
			params.set("limit", String(options.limit));
		const query = params.toString();
		const res = await this.get(`/vcs/branch${query ? `?${query}` : ""}`);
		return unwrapList<string>(res);
	}

	/** Diff against the working tree / a branch / a commit (v2 GET /api/vcs/diff). */
	async getVcsDiff(options?: {
		mode?: "working" | "branch" | "committed";
		base?: string;
		context?: number;
	}): Promise<
		Array<{
			path: string;
			diff: string;
			additions: number;
			deletions: number;
			status: string;
		}>
	> {
		const params = new URLSearchParams();
		if (options?.mode !== undefined) params.set("mode", options.mode);
		if (options?.base !== undefined) params.set("base", options.base);
		if (options?.context !== undefined)
			params.set("context", String(options.context));
		const query = params.toString();
		const res = await this.get(`/vcs/diff${query ? `?${query}` : ""}`);
		return unwrapList<V2FileDiff>(res).map((d) => ({
			path: d.file,
			diff: d.patch,
			additions: d.additions,
			deletions: d.deletions,
			status: d.status,
		}));
	}

	// ─── Sessions ────────────────────────────────────────────────────────────

	/**
	 * List sessions with the full v2 query surface (limit, order, search,
	 * parentID, directory, project, subpath, cursor). Returns just the session
	 * array — use {@link listSessionsPage} when the pagination cursors are needed.
	 */
	async listSessions(options?: SessionListOptions): Promise<SessionDetail[]> {
		return (await this.listSessionsPage(options)).sessions;
	}

	/** List a page of sessions, preserving the opaque pagination cursors. */
	async listSessionsPage(
		options?: SessionListOptions,
	): Promise<SessionListPage> {
		const params = new URLSearchParams();
		if (options?.limit !== undefined)
			params.set("limit", String(options.limit));
		if (options?.order !== undefined) params.set("order", options.order);
		if (options?.search !== undefined) params.set("search", options.search);
		// Explicit parentID wins; otherwise `roots` is sugar for parentID="null".
		if (options?.parentID !== undefined) {
			params.set("parentID", options.parentID);
		} else if (options?.roots) {
			params.set("parentID", "null");
		}
		if (options?.directory !== undefined)
			params.set("directory", options.directory);
		if (options?.project !== undefined) params.set("project", options.project);
		if (options?.subpath !== undefined) params.set("subpath", options.subpath);
		if (options?.cursor !== undefined) params.set("cursor", options.cursor);
		const query = params.toString();
		const path = `/session${query ? `?${query}` : ""}`;
		const res = await this.get(path, options?.signal);
		const rawCursor =
			res && typeof res === "object" && "cursor" in (res as object)
				? (
						res as {
							cursor?: { previous?: string | null; next?: string | null };
						}
					).cursor
				: undefined;
		return {
			sessions: unwrapList<V2SessionInfo>(res).map(mapSession),
			cursor: {
				previous: rawCursor?.previous ?? null,
				next: rawCursor?.next ?? null,
			},
		};
	}

	async getSession(sessionId: string): Promise<SessionDetail> {
		const res = await this.get(`/session/${sessionId}`);
		return mapSession(unwrapData<V2SessionInfo>(res));
	}

	async createSession(options?: SessionCreateOptions): Promise<SessionDetail> {
		const body: Record<string, unknown> = {};
		if (options?.title) body["title"] = options.title;
		if (options?.agentID) body["agent"] = options.agentID;
		if (options?.providerID && options?.modelID) {
			body["model"] = { providerID: options.providerID, id: options.modelID };
		}
		const res = await this.post("/session", body);
		return mapSession(unwrapData<V2SessionInfo>(res));
	}

	async deleteSession(sessionId: string): Promise<void> {
		await this.delete(`/session/${sessionId}`);
	}

	async updateSession(
		sessionId: string,
		updates: { title?: string; archived?: boolean },
	): Promise<SessionDetail> {
		const body: Record<string, unknown> = {};
		if (updates.title !== undefined) body["title"] = updates.title;
		if (updates.archived !== undefined) {
			body["metadata"] = { archived: updates.archived };
		}
		await this.patch(`/session/${sessionId}`, body);
		return this.getSession(sessionId);
	}

	/**
	 * Current status of all sessions. The v2 API exposes only a boolean
	 * "running" signal per session (GET /api/session/active); sessions absent
	 * from that map are idle.
	 */
	async getSessionStatuses(): Promise<Record<string, SessionStatus>> {
		const res = await this.get("/session/active");
		const data = unwrapData<Record<string, { type?: string }>>(res);
		const out: Record<string, SessionStatus> = {};
		if (data && typeof data === "object") {
			for (const [id, value] of Object.entries(data)) {
				out[id] =
					value?.type === "running" ? { type: "busy" } : { type: "idle" };
			}
		}
		return out;
	}

	// ─── Messages ────────────────────────────────────────────────────────────

	async getMessages(sessionId: string): Promise<Message[]> {
		const res = await this.get(`/session/${sessionId}/message`);
		return mapMessages(unwrapList<V2Message>(res), sessionId);
	}

	async getMessage(sessionId: string, messageId: string): Promise<Message> {
		const res = await this.get(`/session/${sessionId}/message/${messageId}`);
		const msg = mapMessage(unwrapData<V2Message>(res), sessionId);
		if (!msg) {
			throw new OpenCodeApiError(
				`GET /api/session/${sessionId}/message/${messageId} returned malformed message`,
				{
					endpoint: `/session/${sessionId}/message/${messageId}`,
					responseStatus: 200,
				},
			);
		}
		return msg;
	}

	/** Get a page of messages with optional limit and before cursor */
	async getMessagesPage(
		sessionId: string,
		options?: { limit?: number; before?: string },
	): Promise<Message[]> {
		const params = new URLSearchParams();
		if (options?.limit) params.set("limit", String(options.limit));
		if (options?.before) params.set("cursor", options.before);
		const query = params.toString();
		const path = `/session/${sessionId}/message${query ? `?${query}` : ""}`;
		const res = await this.get(path);
		return mapMessages(unwrapList<V2Message>(res), sessionId);
	}

	/** Switch the session's active model (v2 persists this on the session). */
	async switchModel(
		sessionId: string,
		model: { providerID: string; modelID: string; variant?: string },
	): Promise<void> {
		const ref: V2ModelRef = { providerID: model.providerID, id: model.modelID };
		if (model.variant !== undefined) ref.variant = model.variant;
		await this.post(`/session/${sessionId}/model`, { model: ref });
	}

	/** Switch the session's active agent (v2 persists this on the session). */
	async switchAgent(sessionId: string, agent: string): Promise<void> {
		await this.post(`/session/${sessionId}/agent`, { agent });
	}

	/**
	 * Send a message. In v2 the requested agent/model/variant are session
	 * state (applied via the dedicated switch endpoints) rather than per-prompt
	 * fields, so they are applied first when provided.
	 */
	async sendMessageAsync(
		sessionId: string,
		prompt: PromptOptions,
	): Promise<void> {
		if (prompt.model || prompt.variant) {
			// Fall back to the session's current model when only a variant is given.
			let providerID = prompt.model?.providerID;
			let modelID = prompt.model?.modelID;
			if ((!providerID || !modelID) && prompt.variant) {
				const session = await this.getSession(sessionId);
				providerID = providerID ?? session.providerID;
				modelID = modelID ?? session.modelID;
			}
			if (providerID && modelID) {
				await this.switchModel(sessionId, {
					providerID,
					modelID,
					...(prompt.variant !== undefined && { variant: prompt.variant }),
				});
			}
		}
		if (prompt.agent) {
			await this.switchAgent(sessionId, prompt.agent);
		}
		// v2's prompt endpoint has no `system` field. Inject the custom system
		// prompt as a hidden synthetic input instead — the same mechanism
		// OpenCode's own UI uses for editor context. `resume: false` admits the
		// input without scheduling a separate run; the prompt below flushes it
		// into the same turn. Synthetic messages are not surfaced in conduit's
		// history (mapMessage skips them) and persist in OpenCode's context, so
		// only inject when the prompt actually changed.
		if (prompt.system) {
			if (this.injectedSystemPrompts.get(sessionId) !== prompt.system) {
				await this.post(`/session/${sessionId}/synthetic`, {
					text: prompt.system,
					resume: false,
				});
				this.injectedSystemPrompts.set(sessionId, prompt.system);
			}
		} else {
			this.injectedSystemPrompts.delete(sessionId);
		}

		// v2 prompt attachments are PromptInput.FileAttachment entries: an
		// `uri` (data: URI for inline bytes, file: URI for on-disk paths) plus
		// an optional display name. Legacy `images` data-URLs are folded into
		// the same list; entries are deduplicated by URI.
		const files: PromptFileAttachment[] = [];
		const seenUris = new Set<string>();
		const pushFile = (file: PromptFileAttachment | undefined) => {
			if (!file?.uri || seenUris.has(file.uri)) return;
			seenUris.add(file.uri);
			files.push(file);
		};
		if (prompt.images) {
			for (const img of prompt.images) {
				const name = dataUrlFileName(img);
				pushFile({ uri: img, ...(name != null && { name }) });
			}
		}
		if (prompt.files) {
			for (const file of prompt.files) pushFile(file);
		}
		const body: Record<string, unknown> = { text: prompt.text ?? "" };
		if (files.length > 0) body["files"] = files;
		if (prompt.delivery) body["delivery"] = prompt.delivery;
		if (prompt.resume !== undefined) body["resume"] = prompt.resume;
		log.debug("prompt body:", JSON.stringify({ ...body, files: files.length }));
		await this.post(`/session/${sessionId}/prompt`, body);
	}

	async abortSession(sessionId: string): Promise<void> {
		await this.post(`/session/${sessionId}/interrupt`, {});
	}

	// ─── Permissions ─────────────────────────────────────────────────────────

	async listPendingPermissions(): Promise<
		Array<{ id: string; permission: string; [key: string]: unknown }>
	> {
		const res = await this.get("/permission/request");
		const list = unwrapList<V2PermissionRequest>(res);
		// Normalise to the shape the permission bridge expects.
		return list.map((p) => ({
			id: p.id,
			sessionID: p.sessionID,
			sessionId: p.sessionID,
			permission: p.action,
			patterns: p.resources ?? [],
			metadata: p.metadata,
			always: p.save,
		}));
	}

	async replyPermission(options: PermissionReplyOptions): Promise<void> {
		if (!options.sessionId) {
			throw new OpenCodeApiError(
				"Cannot reply to a v2 permission request without a sessionId",
				{ endpoint: "/permission", responseStatus: 400 },
			);
		}
		await this.post(
			`/session/${options.sessionId}/permission/${options.id}/reply`,
			{ decision: options.decision },
		);
	}

	// ─── Saved permissions & session permission rulesets ────────────────────

	/**
	 * List permissions saved for a project (v2 GET /api/permission/saved).
	 * OpenCode persists these automatically when a permission is answered with
	 * the `always` decision and the request carries `save` resources.
	 */
	async listSavedPermissions(
		projectID?: string,
	): Promise<SavedPermissionInfo[]> {
		const query = projectID
			? `?projectID=${encodeURIComponent(projectID)}`
			: "";
		const res = await this.get(`/permission/saved${query}`);
		return unwrapList<SavedPermissionInfo>(res);
	}

	/** Remove a saved permission by ID (v2 DELETE /api/permission/saved/{id}). */
	async deleteSavedPermission(id: string): Promise<void> {
		await this.delete(`/permission/saved/${encodeURIComponent(id)}`);
	}

	/** Read a session's permission ruleset (v2 GET /api/session/{id}). */
	async getSessionPermissions(sessionId: string): Promise<PermissionRule[]> {
		const res = await this.get(`/session/${sessionId}`);
		const data = unwrapData<{ permissions?: PermissionRule[] }>(res);
		return Array.isArray(data?.permissions) ? data.permissions : [];
	}

	/** Replace a session's permission ruleset (v2 PATCH /api/session/{id}). */
	async updateSessionPermissions(
		sessionId: string,
		permissions: PermissionRule[],
	): Promise<void> {
		await this.patch(`/session/${sessionId}`, { permissions });
	}

	/**
	 * Add (or replace) a single allow/deny rule in a session's permission
	 * ruleset. Fetches the current ruleset, drops any existing rule for the
	 * same action+resource, then PATCHes the updated set.
	 */
	async addSessionPermission(
		sessionId: string,
		rule: PermissionRule,
	): Promise<void> {
		const current = await this.getSessionPermissions(sessionId);
		const next = current.filter(
			(r) => !(r.action === rule.action && r.resource === rule.resource),
		);
		next.push(rule);
		await this.updateSessionPermissions(sessionId, next);
	}

	// ─── Questions (v2 forms) ────────────────────────────────────────────────

	async listPendingQuestions(): Promise<
		Array<{ id: string; [key: string]: unknown }>
	> {
		const res = await this.get("/form");
		const forms = unwrapList<V2FormInfo>(res);
		// Shape the v2 form into the object the question bridge / handlers read.
		return forms.map((f) => {
			const rawFields = f.fields ?? {};
			const fields: V2FormField[] = Array.isArray(rawFields)
				? rawFields
				: Object.entries(rawFields).map(([key, value]) => ({
						key,
						...value,
					}));
			const questions = fields.map((field) => ({
				question: field.title ?? field.key ?? "",
				header: field.title ?? field.key ?? "",
				options: (field.options ?? []).map((o) => ({
					label: String(o.label),
					description: o.description,
				})),
				multiple: field.type === "multiselect",
				custom: field["custom"] ?? true,
				key: field.key,
				fieldType: field.type,
			}));
			return {
				id: f.id,
				sessionID: f.sessionID,
				sessionId: f.sessionID,
				title: f.title,
				questions,
				fields,
			};
		});
	}

	async replyQuestion(options: QuestionReplyOptions): Promise<void> {
		if (!options.sessionId) {
			throw new OpenCodeApiError(
				"Cannot reply to a v2 form without a sessionId",
				{ endpoint: "/form", responseStatus: 400 },
			);
		}
		const pending = await this.listPendingQuestions().catch(() => []);
		const form = pending.find((f) => f.id === options.id);
		const answer = formatFormAnswer(
			form as { fields?: V2FormField[] } | undefined,
			options.answers,
		);
		await this.post(`/session/${options.sessionId}/form/${options.id}/reply`, {
			answer,
		});
	}

	async rejectQuestion(id: string, sessionId?: string): Promise<void> {
		if (!sessionId) {
			throw new OpenCodeApiError(
				"Cannot reject a v2 form without a sessionId",
				{ endpoint: "/form", responseStatus: 400 },
			);
		}
		await this.delete(`/session/${sessionId}/form/${id}`);
	}

	// ─── Discovery ───────────────────────────────────────────────────────────

	async listAgents(): Promise<Agent[]> {
		const res = await this.get("/agent");
		return unwrapList<V2Agent>(res).map((a) => ({
			id: a.id,
			name: a.name,
			...(a.description !== undefined && { description: a.description }),
			...(a.mode !== undefined && { mode: a.mode }),
			...(a.hidden !== undefined && { hidden: a.hidden }),
		}));
	}

	async listProviders(): Promise<ProviderListResult> {
		const [providerRes, modelRes, defaultRes] = await Promise.all([
			this.get(this.atLocation("/provider")),
			this.get(this.atLocation("/model")),
			this.get(this.atLocation("/model/default")).catch(() => undefined),
		]);
		const providers = unwrapList<V2ProviderInfo>(providerRes);
		const models = unwrapList<V2ModelInfo>(modelRes);
		const defaultModel =
			defaultRes === undefined
				? undefined
				: (unwrapData<V2ModelInfo | null>(defaultRes) ?? undefined);

		// Group models by provider (v2 keeps models separate from providers).
		const modelsByProvider = new Map<string, Provider["models"]>();
		for (const m of models) {
			const list = modelsByProvider.get(m.providerID) ?? [];
			const variants: Record<string, Record<string, unknown>> = {};
			for (const v of m.variants ?? []) variants[v.id] = {};
			list?.push({
				id: m.id,
				name: m.name ?? m.modelID,
				...(m.limit && {
					limit: {
						...(m.limit.context !== undefined && {
							context: m.limit.context,
						}),
						...(m.limit.output !== undefined && { output: m.limit.output }),
					},
				}),
				...(Object.keys(variants).length > 0 && { variants }),
			});
			modelsByProvider.set(m.providerID, list);
		}

		const result: Provider[] = providers.map((p) => ({
			id: p.id,
			name: p.name ?? p.id,
			models: modelsByProvider.get(p.id) ?? [],
		}));

		const defaults: Record<string, string> = {};
		if (defaultModel) defaults[defaultModel.providerID] = defaultModel.id;

		const connected = providers
			.filter((p) => p.activation !== "disabled")
			.map((p) => p.id);

		return { providers: result, defaults, connected };
	}

	async listCommands(
		_directory?: string,
	): Promise<Array<{ name: string; description?: string }>> {
		const res = await this.get("/command");
		return unwrapList<{ name: string; description?: string }>(res);
	}

	/**
	 * List registered skills (v2 GET /api/skill). `directory` scopes the
	 * lookup via the `location[directory]` deep-object query when provided.
	 */
	async listSkills(directory?: string): Promise<SkillInfo[]> {
		const query =
			directory != null
				? `?location[directory]=${encodeURIComponent(directory)}`
				: "";
		const res = await this.get(`/skill${query}`);
		return unwrapList<V2Skill>(res).map((s) => ({
			id: s.id,
			name: s.name || s.id,
			...(s.description != null && { description: s.description }),
			...(s.autoinvoke != null && { autoinvoke: s.autoinvoke }),
			...(s.path != null && { path: s.path }),
		}));
	}

	/**
	 * Activate a skill for a session (v2 POST /experimental/session/{id}/skill).
	 * Appends a skill message and (optionally) resumes execution.
	 */
	async activateSkill(
		sessionId: string,
		skillId: string,
		options?: { resume?: boolean },
	): Promise<void> {
		const body: Record<string, unknown> = { id: skillId };
		if (options?.resume !== undefined) body["resume"] = options.resume;
		await this.post(`/experimental/session/${sessionId}/skill`, body);
	}

	// ─── Project ─────────────────────────────────────────────────────────────

	async listProjects(): Promise<
		Array<{ id: string; name?: string; path?: string; worktree?: string }>
	> {
		const res = await this.get("/project");
		const list = Array.isArray(res) ? res : unwrapList<unknown>(res);
		return (list as Array<{ id?: string; canonical?: string; name?: string }>)
			.filter((p) => typeof p?.id === "string")
			.map((p) => ({
				id: p.id as string,
				...(p.name !== undefined && { name: p.name }),
				...(p.canonical !== undefined && {
					path: p.canonical,
					worktree: p.canonical,
				}),
			}));
	}

	// ─── Session Advanced ────────────────────────────────────────────────────

	async forkSession(
		sessionId: string,
		options: { messageID?: string; title?: string },
	): Promise<SessionDetail> {
		const body: Record<string, unknown> = {};
		if (options.messageID) body["before"] = options.messageID;
		const res = await this.post(`/session/${sessionId}/fork`, body);
		return mapSession(unwrapData<V2SessionInfo>(res));
	}

	/**
	 * Stage a reversible session boundary (v2 POST /revert/stage). Does NOT
	 * apply the revert on its own — call commitRevert() to apply it.
	 *
	 * @param files When true, the staged revert also reverts file changes on
	 *   disk. When false/omitted, only the conversation boundary is staged.
	 */
	async revertSession(
		sessionId: string,
		messageId: string,
		options?: { files?: boolean },
	): Promise<void> {
		const body: Record<string, unknown> = { messageID: messageId };
		if (options?.files !== undefined) body["files"] = options.files;
		await this.post(`/session/${sessionId}/revert/stage`, body);
	}

	/** Apply a staged revert (v2 POST /revert/commit). */
	async commitRevert(sessionId: string): Promise<void> {
		await this.post(`/session/${sessionId}/revert/commit`, {});
		// The revert may have truncated the synthetic system-prompt input, so
		// allow it to be injected again on the next message.
		this.injectedSystemPrompts.delete(sessionId);
	}

	/** Clear a staged-but-uncommitted revert (v2 DELETE /revert). */
	async clearRevert(sessionId: string): Promise<void> {
		await this.delete(`/session/${sessionId}/revert`);
		this.injectedSystemPrompts.delete(sessionId);
	}

	/** Run a slash command (v2 POST /session/{id}/command). */
	async runCommand(
		sessionId: string,
		options: RunCommandOptions,
	): Promise<void> {
		const body: Record<string, unknown> = {
			name: options.name,
			text: options.text ?? "",
		};
		if (options.files && options.files.length > 0)
			body["files"] = options.files;
		if (options.agents && options.agents.length > 0)
			body["agents"] = options.agents;
		if (options.skills && options.skills.length > 0)
			body["skills"] = options.skills;
		if (options.delivery) body["delivery"] = options.delivery;
		await this.post(`/session/${sessionId}/command`, body);
	}

	async summarizeSession(sessionId: string): Promise<void> {
		await this.post(`/session/${sessionId}/compact`, {});
	}

	// ─── Session Inbox (queue vs steer) ───────────────────────────────────────

	/** List durable enqueued work not yet delivered (GET /session/{id}/inbox). */
	async listSessionInbox(sessionId: string): Promise<V2InboxItem[]> {
		const res = await this.get(`/session/${sessionId}/inbox`);
		return unwrapList<V2InboxItem>(res);
	}

	/** Cancel a queued inbox item (DELETE .../inbox/{inboxID}). */
	async cancelInboxItem(sessionId: string, inboxId: string): Promise<void> {
		await this.delete(
			`/session/${sessionId}/inbox/${encodeURIComponent(inboxId)}`,
		);
	}

	/** Change a queued item's delivery mode (PATCH .../inbox/{inboxID}). */
	async updateInboxItem(
		sessionId: string,
		inboxId: string,
		delivery: "steer" | "queue",
	): Promise<void> {
		await this.patch(
			`/session/${sessionId}/inbox/${encodeURIComponent(inboxId)}`,
			{ delivery },
		);
	}

	/**
	 * Move a session to another directory (v2 POST /session/{id}/move).
	 * Changing directories makes the session continue work in a new location.
	 */
	async moveSession(sessionId: string, directory: string): Promise<void> {
		await this.post(`/session/${sessionId}/move`, { directory });
	}

	async getSessionDiff(
		sessionId: string,
		messageId?: string,
	): Promise<{ diffs: Array<{ path: string; diff: string }> }> {
		const params = new URLSearchParams();
		if (messageId) params.set("from", messageId);
		const query = params.toString();
		const res = await this.get(
			`/session/${sessionId}/diff${query ? `?${query}` : ""}`,
		);
		const diffs = unwrapList<V2FileDiff>(res).map((d) => ({
			path: d.file,
			diff: d.patch,
		}));
		return { diffs };
	}

	// ─── PTY (persistent, v2 experimental) ───────────────────────────────────
	// Persistent PTYs live on the OpenCode server and survive relay restarts.
	// Routes: /experimental/session/{id}/terminal (list/create),
	//         /experimental/persistent-pty/{id} (get/update/delete).

	/** List a session's persistent terminals (running and exited). */
	async listSessionTerminals(sessionId: string): Promise<PersistentPtyInfo[]> {
		const res = await this.get(`/experimental/session/${sessionId}/terminal`);
		return unwrapList<V2PersistentPty>(res);
	}

	/**
	 * Create a persistent terminal owned by a session. The v2 body requires
	 * `args` and `env` (may be empty) and a `title`.
	 */
	async createSessionTerminal(
		sessionId: string,
		input: PersistentPtyCreateInput,
	): Promise<PersistentPtyInfo> {
		const res = await this.post(
			`/experimental/session/${sessionId}/terminal`,
			input,
		);
		return unwrapData<V2PersistentPty>(res);
	}

	/** Fetch a persistent PTY's info by id. */
	async getPersistentPty(ptyId: string): Promise<PersistentPtyInfo> {
		const res = await this.get(`/experimental/persistent-pty/${ptyId}`);
		return unwrapData<V2PersistentPty>(res);
	}

	/**
	 * Resize a persistent terminal (or set its attachment). Non-fatal helper —
	 * mirrors the legacy resizePty surface.
	 */
	async updatePersistentPty(
		ptyId: string,
		size: { cols: number; rows: number },
		attachmentID?: string,
	): Promise<PersistentPtyInfo> {
		const res = await this.put(`/experimental/persistent-pty/${ptyId}`, {
			size,
			...(attachmentID && { attachmentID }),
		});
		return unwrapData<V2PersistentPty>(res);
	}

	/** Delete (shut down) a persistent terminal. */
	async deletePersistentPty(ptyId: string): Promise<void> {
		await this.delete(`/experimental/persistent-pty/${ptyId}`);
	}

	/** Fetch a persistent PTY's screen snapshot (text + cursor + checkpoint). */
	async getPersistentPtySnapshot(
		ptyId: string,
	): Promise<PersistentPtySnapshot> {
		const res = await this.get(
			`/experimental/persistent-pty/${ptyId}/snapshot`,
		);
		return unwrapData<PersistentPtySnapshot>(res);
	}

	/**
	 * Read the last physical rows of a session's most recently controlled
	 * terminal without taking control. Returns null when no terminal exists.
	 */
	async readSessionTerminal(
		sessionId: string,
		lines?: number,
	): Promise<PersistentPtyReadResult | null> {
		const query = lines !== undefined ? `?lines=${lines}` : "";
		const res = await this.get(
			`/experimental/session/${sessionId}/terminal/read${query}`,
		);
		const data = unwrapData<PersistentPtyReadResult | null>(res);
		return data ?? null;
	}

	// ─── PTY (legacy ephemeral v1 — retained for back-compat) ─────────────────

	async listPtys(): Promise<Array<{ id: string; [key: string]: unknown }>> {
		const res = await this.get("/pty");
		return unwrapList<V2Pty>(res) as Array<{
			id: string;
			[key: string]: unknown;
		}>;
	}

	async createPty(options?: PtyCreateOptions): Promise<{ id: string }> {
		const res = await this.post("/pty", options ?? {});
		return unwrapData<V2Pty>(res) as { id: string };
	}

	async deletePty(ptyId: string): Promise<void> {
		await this.delete(`/pty/${ptyId}`);
	}

	async resizePty(ptyId: string, cols: number, rows: number): Promise<void> {
		await this.put(`/pty/${ptyId}`, { size: { cols, rows } });
	}

	// ─── Files ──────────────────────────────────────────────────────────────

	async listDirectory(
		path?: string,
	): Promise<Array<{ name: string; type: string; size?: number }>> {
		const dirPath = path || ".";
		const res = await this.get(`/fs/list?path=${encodeURIComponent(dirPath)}`);
		return unwrapList<V2FileSystemEntry>(res).map((e) => ({
			name: e.path.split("/").pop() ?? e.path,
			type: e.type,
		}));
	}

	async getFileContent(
		path: string,
	): Promise<{ content: string; binary?: boolean }> {
		const url = `${this.baseUrl}${API_PREFIX}/fs/read/${path
			.split("/")
			.map(encodeURIComponent)
			.join("/")}`;
		const res = await fetch(url, { headers: this.headers });
		if (!res.ok) {
			throw new OpenCodeApiError(
				`GET /api/fs/read/${path} failed with ${res.status}`,
				{
					endpoint: `/fs/read/${path}`,
					responseStatus: res.status,
				},
			);
		}
		const text = await res.text();
		const binary = text.includes("\u0000");
		return { content: text, binary };
	}

	async getFileStatus(): Promise<
		Array<{
			path: string;
			status: string;
			additions?: number;
			deletions?: number;
		}>
	> {
		const res = await this.get("/vcs/status");
		return unwrapList<{
			file: string;
			status: string;
			additions: number;
			deletions: number;
		}>(res).map((s) => ({
			path: s.file,
			status: s.status,
			additions: s.additions,
			deletions: s.deletions,
		}));
	}

	/**
	 * Write a file's contents (v2 POST /api/experimental/fs/write).
	 * `path` is absolute or relative to the request location; missing parent
	 * directories are created by OpenCode.
	 */
	async writeFile(path: string, content: string): Promise<{ path: string }> {
		const url = `${this.baseUrl}${API_PREFIX}/experimental/fs/write?path=${encodeURIComponent(path)}`;
		const headers: Record<string, string> = {
			"Content-Type": "application/octet-stream",
			...this.getAuthHeaders(),
		};
		const res = await fetch(url, { method: "POST", headers, body: content });
		if (!res.ok) {
			let responseBody: unknown;
			try {
				responseBody = await res.json();
			} catch {
				responseBody = await res.text().catch(() => "[body unreadable]");
			}
			throw new OpenCodeApiError(
				`POST /experimental/fs/write failed with ${res.status}`,
				{
					endpoint: "/experimental/fs/write",
					responseStatus: res.status,
					responseBody,
				},
			);
		}
		const data = unwrapData<{ path?: string }>(
			await res.json().catch(() => ({})),
		);
		return { path: data?.path ?? path };
	}

	// ─── Config ──────────────────────────────────────────────────────────────

	async getConfig(): Promise<Record<string, unknown>> {
		const res = await this.get("/config");
		const entries = Array.isArray(res)
			? res
			: unwrapList<Record<string, unknown>>(res);
		// Merge document config entries into a single effective config object.
		const merged: Record<string, unknown> = {};
		for (const entry of entries) {
			if (!entry || typeof entry !== "object") continue;
			if ((entry as { type?: string }).type !== "document") continue;
			const info = (entry as { info?: unknown }).info;
			if (info && typeof info === "object") {
				const cfg = (info as { config?: unknown }).config ?? info;
				if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) {
					Object.assign(merged, cfg as Record<string, unknown>);
				}
			}
		}
		return merged;
	}

	/** Check each config document since providers can be defined at different scopes. */
	async hasConfiguredProvider(providerID: string): Promise<boolean> {
		const res = await this.get(this.atLocation("/config"));
		const entries = Array.isArray(res) ? res : unwrapList<unknown>(res);
		return entries.some((entry) => {
			const document = entry as {
				type?: string;
				info?: {
					providers?: Record<string, unknown>;
					config?: { providers?: Record<string, unknown> };
				};
			} | null;
			if (document?.type !== "document") return false;
			const providers =
				document.info?.config?.providers ?? document.info?.providers;
			return !!providers && Object.hasOwn(providers, providerID);
		});
	}

	/** Send one text request without creating a chat or retrying a paid call. */
	async generateText(
		model: { providerID: string; modelID: string },
		prompt: string,
	): Promise<string> {
		const res = await this.request(
			"POST",
			"/experimental/generate",
			{
				model: { providerID: model.providerID, id: model.modelID },
				prompt,
			},
			undefined,
			0,
		);
		return unwrapData<{ text?: string }>(res)?.text ?? "";
	}

	// ─── Server Info ─────────────────────────────────────────────────────────

	/** Server identity + readiness (v2 GET /api/info → ServerInfo). */
	async getServerInfo(): Promise<ServerInfo> {
		const res = await this.get("/info");
		return unwrapData<ServerInfo>(res);
	}

	/** Shut down and rebuild every loaded location (v2 POST /api/location/reload). */
	async reloadConfig(): Promise<void> {
		await this.post("/location/reload", {});
	}

	// ─── MCP Servers ─────────────────────────────────────────────────────────

	/** List configured MCP servers and their status (v2 GET /api/mcp). */
	async listMcpServers(): Promise<McpServerInfo[]> {
		const res = await this.get("/mcp");
		return unwrapList<McpServerInfo>(res);
	}

	/** Resources + resource templates from connected MCP servers (v2 GET /api/mcp/resource). */
	async listMcpResources(): Promise<McpResourceCatalog> {
		const res = await this.get("/mcp/resource");
		const data = unwrapData<McpResourceCatalog>(res);
		return {
			resources: data?.resources ?? [],
			templates: data?.templates ?? [],
		};
	}

	/** Add or replace an MCP server, connecting it immediately (v2 PUT /api/experimental/mcp/{server}). */
	async addMcpServer(name: string, config: McpServerConfig): Promise<void> {
		await this.put(`/experimental/mcp/${encodeURIComponent(name)}`, { config });
	}

	/** Remove an MCP server (v2 DELETE /api/experimental/mcp/{server}). */
	async removeMcpServer(name: string): Promise<void> {
		await this.delete(`/experimental/mcp/${encodeURIComponent(name)}`);
	}

	/** Connect an MCP server at runtime (v2 POST /api/experimental/mcp/{server}/connect). */
	async connectMcpServer(name: string): Promise<void> {
		await this.post(
			`/experimental/mcp/${encodeURIComponent(name)}/connect`,
			{},
		);
	}

	/** Disconnect an MCP server at runtime (v2 POST /api/experimental/mcp/{server}/disconnect). */
	async disconnectMcpServer(name: string): Promise<void> {
		await this.post(
			`/experimental/mcp/${encodeURIComponent(name)}/disconnect`,
			{},
		);
	}

	// ─── Integration Credentials ─────────────────────────────────────────────

	/** List stored integration credentials (v2 GET /api/credential). */
	async listCredentials(): Promise<CredentialEntry[]> {
		const res = await this.get("/credential");
		return unwrapList<CredentialEntry>(res);
	}

	/** Store a credential, optionally activating it (v2 POST /api/credential). */
	async createCredential(
		input: CredentialCreateInput,
	): Promise<CredentialEntry> {
		const res = await this.post("/credential", input);
		return unwrapData<CredentialEntry>(res);
	}

	/** Update a credential's label (v2 PATCH /api/credential/{id}). */
	async updateCredential(id: string, label: string): Promise<void> {
		await this.patch(`/credential/${encodeURIComponent(id)}`, { label });
	}

	/** Remove a credential (v2 DELETE /api/credential/{id}). */
	async deleteCredential(id: string): Promise<void> {
		await this.delete(`/credential/${encodeURIComponent(id)}`);
	}

	/** Activate a stored credential (v2 POST /api/credential/{id}/activate). */
	async activateCredential(id: string): Promise<void> {
		await this.post(`/credential/${encodeURIComponent(id)}/activate`, {});
	}

	// ─── Integrations ────────────────────────────────────────────────────────

	/** List available integrations + auth methods (v2 GET /api/integration). */
	async listIntegrations(): Promise<IntegrationInfo[]> {
		const res = await this.get(this.atLocation("/integration"));
		return unwrapList<IntegrationInfo>(res);
	}

	/** Fetch one integration by ID (v2 GET /api/integration/{id}). */
	async getIntegration(id: string): Promise<IntegrationInfo | undefined> {
		const res = await this.get(`/integration/${encodeURIComponent(id)}`);
		const data = unwrapData<IntegrationInfo | undefined>(res);
		return data ?? undefined;
	}

	/** Connect an integration with a raw API key (v2 POST …/connect/key). */
	async integrationConnectKey(
		id: string,
		input: {
			key: string;
			label?: string;
			answer?: Record<string, unknown>;
		},
	): Promise<void> {
		await this.request(
			"POST",
			this.atLocation(`/integration/${encodeURIComponent(id)}/connect/key`),
			{
				key: input.key,
				...(input.label !== undefined && { label: input.label }),
				...(input.answer !== undefined && { answer: input.answer }),
			},
			undefined,
			0,
		);
	}

	/** Begin an OAuth connect attempt (v2 POST …/connect/oauth). */
	async integrationConnectOAuth(
		id: string,
		input: {
			methodID: string;
			label?: string;
			answer?: Record<string, unknown>;
		},
	): Promise<IntegrationAttempt> {
		const res = await this.post(
			`/integration/${encodeURIComponent(id)}/connect/oauth`,
			{
				methodID: input.methodID,
				...(input.label !== undefined && { label: input.label }),
				...(input.answer !== undefined && { answer: input.answer }),
			},
		);
		return unwrapData<IntegrationAttempt>(res);
	}

	/** Poll an OAuth attempt (v2 GET …/connect/oauth/{attemptID}). */
	async integrationOAuthStatus(
		id: string,
		attemptID: string,
	): Promise<IntegrationAttemptStatus> {
		const res = await this.get(
			`/integration/${encodeURIComponent(id)}/connect/oauth/${encodeURIComponent(attemptID)}`,
		);
		return unwrapData<IntegrationAttemptStatus>(res);
	}

	/** Finish a code-based OAuth attempt (v2 POST …/complete). */
	async integrationOAuthComplete(
		id: string,
		attemptID: string,
		code?: string,
	): Promise<void> {
		await this.post(
			`/integration/${encodeURIComponent(id)}/connect/oauth/${encodeURIComponent(attemptID)}/complete`,
			code !== undefined ? { code } : {},
		);
	}

	/** Cancel an OAuth attempt (v2 DELETE …/connect/oauth/{attemptID}). */
	async integrationCancelOAuth(id: string, attemptID: string): Promise<void> {
		await this.delete(
			`/integration/${encodeURIComponent(id)}/connect/oauth/${encodeURIComponent(attemptID)}`,
		);
	}

	/** Begin a command connect attempt (v2 POST …/connect/command). */
	async integrationConnectCommand(
		id: string,
		input: { methodID: string; label?: string },
	): Promise<IntegrationAttempt> {
		const res = await this.post(
			`/integration/${encodeURIComponent(id)}/connect/command`,
			{
				methodID: input.methodID,
				...(input.label !== undefined && { label: input.label }),
			},
		);
		return unwrapData<IntegrationAttempt>(res);
	}

	/** Poll a command attempt (v2 GET …/connect/command/{attemptID}). */
	async integrationCommandStatus(
		id: string,
		attemptID: string,
	): Promise<IntegrationAttemptStatus> {
		const res = await this.get(
			`/integration/${encodeURIComponent(id)}/connect/command/${encodeURIComponent(attemptID)}`,
		);
		return unwrapData<IntegrationAttemptStatus>(res);
	}

	/** Cancel a command attempt (v2 DELETE …/connect/command/{attemptID}). */
	async integrationCancelCommand(id: string, attemptID: string): Promise<void> {
		await this.delete(
			`/integration/${encodeURIComponent(id)}/connect/command/${encodeURIComponent(attemptID)}`,
		);
	}

	// ─── Plugins ─────────────────────────────────────────────────────────────

	/** List loaded plugins + state (v2 GET /api/plugin). */
	async listPlugins(): Promise<PluginInfo[]> {
		const res = await this.get("/plugin");
		return unwrapList<PluginInfo>(res);
	}

	/**
	 * Check one (or all) package plugins for updates
	 * (v2 POST /api/plugin/check → refreshed Plugin.Info list).
	 */
	async checkPlugins(target?: string): Promise<PluginInfo[]> {
		const res = await this.post(
			"/plugin/check",
			target !== undefined ? { target } : {},
		);
		return unwrapList<PluginInfo>(res);
	}

	/**
	 * Update package plugins and wait for the server to finish
	 * (v2 POST /api/plugin/update). Responds once every update completed.
	 */
	async updatePlugins(targets: string[]): Promise<void> {
		await this.post("/plugin/update", { targets });
	}

	// ─── References ──────────────────────────────────────────────────────────

	/** List project references available for @-mentions (v2 GET /api/reference). */
	async listReferences(): Promise<ReferenceInfo[]> {
		const res = await this.get("/reference");
		return unwrapList<ReferenceInfo>(res);
	}

	// ─── Internal HTTP methods ─────────────────────────────────────────────

	private async request(
		method: string,
		path: string,
		body?: unknown,
		signal?: AbortSignal,
		retries = this.retries,
	): Promise<unknown> {
		const url = `${this.baseUrl}${API_PREFIX}${path}`;

		// Abort before we even start if the caller already cancelled.
		if (signal?.aborted) {
			throw new DOMException("The operation was aborted.", "AbortError");
		}

		let lastError: Error | undefined;
		for (let attempt = 0; attempt <= retries; attempt++) {
			try {
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), this.timeout);
				// Link the caller's signal so an abort cancels the in-flight fetch.
				const onAbort = () => controller.abort();
				signal?.addEventListener("abort", onAbort, { once: true });

				const init: RequestInit = {
					method,
					headers: this.headers,
					signal: controller.signal,
				};

				if (body !== undefined && method !== "GET" && method !== "DELETE") {
					init.body = JSON.stringify(body);
				}

				const res = await fetch(url, init);
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);

				if (!res.ok) {
					let responseBody: unknown;
					try {
						responseBody = await res.json();
					} catch {
						responseBody = await res.text().catch(() => "[body unreadable]");
					}
					throw new OpenCodeApiError(
						`${method} ${path} failed with ${res.status}`,
						{
							endpoint: path,
							responseStatus: res.status,
							responseBody,
						},
					);
				}

				// 204 No Content
				if (res.status === 204) return undefined;

				const contentType = res.headers.get("content-type") ?? "";
				if (contentType.includes("application/json")) {
					return await res.json();
				}
				return await res.text();
			} catch (err) {
				lastError = err instanceof Error ? err : new Error(String(err));

				// Caller cancelled (superseded search) — surface immediately,
				// never retry a request the caller no longer wants.
				if (signal?.aborted) {
					throw new DOMException("The operation was aborted.", "AbortError");
				}

				// Don't retry on 4xx client errors
				if (err instanceof OpenCodeApiError && err.responseStatus < 500) {
					throw err;
				}

				// Retry on network/5xx errors
				if (attempt < retries) {
					await new Promise((r) =>
						setTimeout(r, this.retryDelay * (attempt + 1)),
					);
				}
			}
		}

		throw new OpenCodeConnectionError(
			`Failed to reach OpenCode at ${url} after ${retries + 1} attempts`,
			{ ...(lastError != null && { cause: lastError }) },
		);
	}

	private get(path: string, signal?: AbortSignal): Promise<unknown> {
		return this.request("GET", path, undefined, signal);
	}

	private post(path: string, body: unknown): Promise<unknown> {
		return this.request("POST", path, body);
	}

	private put(path: string, body: unknown): Promise<unknown> {
		return this.request("PUT", path, body);
	}

	private patch(path: string, body: unknown): Promise<unknown> {
		return this.request("PATCH", path, body);
	}

	private delete(path: string): Promise<unknown> {
		return this.request("DELETE", path);
	}

	/** Expose the origin base URL (without the /api prefix). */
	getBaseUrl(): string {
		return this.baseUrl;
	}

	/** Expose the v2 API base URL for the SSE consumer. */
	getApiBaseUrl(): string {
		return `${this.baseUrl}${API_PREFIX}`;
	}

	/** Expose auth headers for SSE consumer and PTY upstream connections */
	getAuthHeaders(): Record<string, string> {
		const result: Record<string, string> = {};
		if (this.headers["Authorization"]) {
			result["Authorization"] = this.headers["Authorization"];
		}
		if (this.headers["x-opencode-directory"]) {
			result["x-opencode-directory"] = this.headers["x-opencode-directory"];
		}
		return result;
	}
}

/**
 * Normalise a v2 form's `fields` (array or keyed object) into an ordered array.
 * Object-keyed forms get their key injected so every field carries one.
 */
function normalizeFormFields(
	fields: V2FormField[] | Record<string, V2FormField> | undefined,
): V2FormField[] {
	if (!fields) return [];
	if (Array.isArray(fields)) return fields;
	return Object.entries(fields).map(([key, value]) => ({ key, ...value }));
}

/**
 * Convert conduit's positional `answers: string[][]` (one array of selected
 * values per field, in field order) into the v2 `Form.Reply.answer` object
 * keyed by each field's `key`. Values are coerced according to the field type
 * so String / Number / Integer / Boolean / Multiselect / External all round-trip.
 */
function formatFormAnswer(
	form: { fields?: V2FormField[] | Record<string, V2FormField> } | undefined,
	answers: string[][],
): Record<string, unknown> {
	const fields = normalizeFormFields(form?.fields);
	const answer: Record<string, unknown> = {};
	if (fields.length === 0) {
		// No form metadata available — fall back to keying by field index.
		answers.forEach((values, i) => {
			answer[`q${i}`] = values.length <= 1 ? (values[0] ?? "") : values;
		});
		return answer;
	}
	fields.forEach((field, i) => {
		const key = field.key ?? `q${i}`;
		const values = answers[i] ?? [];
		const type = (field.type ?? "string").toLowerCase();
		switch (type) {
			case "multiselect":
				answer[key] = values;
				break;
			case "boolean":
				answer[key] = values[0] === "true" || values[0] === "1";
				break;
			case "number":
			case "integer": {
				const raw = values[0];
				if (raw === undefined || raw === "") break;
				const n = Number(raw);
				if (Number.isNaN(n)) break;
				answer[key] = type === "integer" ? Math.trunc(n) : n;
				break;
			}
			// "string", "external" (and any unknown type) pass through as text.
			default:
				answer[key] = values[0] ?? "";
		}
	});
	return answer;
}
