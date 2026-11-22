// ─── Mock OpenCode (v2) Server ───────────────────────────────────────────────
// Replays a recorded OpenCodeRecording as an HTTP + WebSocket server that
// speaks the OpenCode v2 wire protocol.
//
// The committed recordings were captured against OpenCode v1, so this mock
// owns a small v1→v2 adapter:
//   • REST lives under `/api/*` (requests may arrive with or without the
//     prefix — the recording lookup normalizes both).
//   • Single-object responses are wrapped in `{ data }`; module-level lists in
//     `{ location, data }`; `/api/config` and `/api/project` stay raw arrays.
//   • `/api/session/{id}/prompt` is matched against recorded `prompt_async`.
//   • SSE is served at `/api/event` using the v2 envelope
//     `{ id, created, type, location: { directory }, data }` and v2 event
//     names (session.text.delta, session.tool.*, session.idle, session.active,
//     permission.asked, filesystem.changed, …).

import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import type {
	OpenCodeInteraction,
	OpenCodeRecording,
} from "../e2e/fixtures/recorded/types.js";

// ─── Internal types ──────────────────────────────────────────────────────────

/** SSE event from a recording (v1 shape: { type, properties }). */
interface SseEvent {
	type: string;
	properties: Record<string, unknown>;
	delayMs: number;
}

/** A queued REST response. */
interface QueuedRestResponse {
	status: number;
	responseBody: unknown;
}

/** PTY interaction for replay. */
type PtyInteraction = Extract<
	OpenCodeInteraction,
	{ kind: "pty-open" | "pty-input" | "pty-output" | "pty-close" }
>;

// ─── Path normalization ──────────────────────────────────────────────────────

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIXED_ID_RE = /^[a-z]{2,4}_[A-Za-z0-9]+$/;

function normalizePath(path: string): string {
	const base = path.split("?")[0] ?? path;
	return base
		.split("/")
		.map((seg) => {
			if (seg === "") return seg;
			if (PREFIXED_ID_RE.test(seg) || UUID_RE.test(seg)) return ":param";
			return seg;
		})
		.join("/");
}

function exactKey(method: string, path: string): string {
	const base = path.split("?")[0] ?? path;
	return `${method.toUpperCase()} ${base}`;
}

function normalizedKey(method: string, path: string): string {
	return `${method.toUpperCase()} ${normalizePath(path)}`;
}

/** Strip a leading `/api` (v2 prefix) from a request path. */
function stripApi(path: string): string {
	const base = path.split("?")[0] ?? path;
	if (base === "/api") return "/";
	if (base.startsWith("/api/")) return base.slice(4);
	return base;
}

// ─── v1 → v2 shapes ──────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Json)
		: undefined;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

/** Map a v1 session object → v2 Session.Info. */
function sessionV2(raw: unknown): Json {
	const s = asRecord(raw) ?? {};
	const time = asRecord(s["time"]) ?? {};
	const model = asRecord(s["model"]);
	const location = asRecord(s["location"]);
	const directory =
		(location?.["directory"] as string | undefined) ??
		(s["directory"] as string | undefined);
	const out: Json = {
		id: s["id"],
		projectID: (s["projectID"] as string | undefined) ?? "project",
		cost: (s["cost"] as number | undefined) ?? 0,
		tokens: { input: 0, output: 0 },
		time: {
			created: (time["created"] as number | undefined) ?? 0,
			updated:
				(time["updated"] as number | undefined) ??
				(time["created"] as number | undefined) ??
				0,
		},
	};
	if (s["title"] !== undefined) out["title"] = s["title"];
	if (s["parentID"] !== undefined) out["parentID"] = s["parentID"];
	if (s["agent"] !== undefined) out["agent"] = s["agent"];
	else if (s["mode"] !== undefined) out["agent"] = s["mode"];
	if (directory !== undefined) out["location"] = { directory };
	// v1 keeps providerID/modelID flat; v2 nests them under `model`.
	if (model) {
		out["model"] = model;
	} else if (s["providerID"] !== undefined || s["modelID"] !== undefined) {
		const ref: Json = {};
		if (s["providerID"] !== undefined) ref["providerID"] = s["providerID"];
		if (s["modelID"] !== undefined) ref["id"] = s["modelID"];
		if (s["variant"] !== undefined) ref["variant"] = s["variant"];
		out["model"] = ref;
	}
	return out;
}

/** Map a v1 provider object → v2 Provider.Info. */
function providerV2(raw: unknown): Json {
	const p = asRecord(raw) ?? {};
	return {
		id: (p["id"] as string | undefined) ?? (p["name"] as string | undefined),
		name: (p["name"] as string | undefined) ?? (p["id"] as string | undefined),
		activation: "enabled",
		package: "",
	};
}

/** Map a v1 provider model object → v2 Model.Info. */
function modelV2(providerID: string, modelId: string, raw: unknown): Json {
	const m = asRecord(raw) ?? {};
	const variants = asRecord(m["variants"]) ?? {};
	const limit = asRecord(m["limit"]) ?? {};
	return {
		id: (m["id"] as string | undefined) ?? modelId,
		modelID: modelId,
		providerID,
		name: (m["name"] as string | undefined) ?? modelId,
		capabilities: {},
		variants: Object.keys(variants).map((id) => ({ id })),
		time: { released: 0 },
		cost: [],
		status: (m["status"] as string | undefined) ?? "active",
		enabled: true,
		limit: {
			context: (limit["context"] as number | undefined) ?? 0,
			output: (limit["output"] as number | undefined) ?? 0,
		},
	};
}

/** Map a v1 agent object → v2 Agent.Info. */
function agentV2(raw: unknown): Json {
	const a = asRecord(raw) ?? {};
	const name =
		(a["name"] as string | undefined) ?? (a["id"] as string | undefined);
	return {
		id: (a["id"] as string | undefined) ?? name,
		name,
		mode: (a["mode"] as string | undefined) ?? "primary",
		hidden: (a["hidden"] as boolean | undefined) ?? false,
		request: {},
		permissions: {},
		...(a["description"] !== undefined && { description: a["description"] }),
	};
}

/** Map a v1 permission object → v2 Permission.Request. */
function permissionV2(raw: unknown): Json {
	const p = asRecord(raw) ?? {};
	const out: Json = {
		id: p["id"],
		sessionID: p["sessionID"],
		action:
			(p["action"] as string | undefined) ??
			(p["permission"] as string | undefined) ??
			"",
		resources: asArray(p["resources"] ?? p["patterns"]),
	};
	if (p["save"] !== undefined || p["always"] !== undefined) {
		out["save"] = asArray(p["save"] ?? p["always"]);
	}
	if (p["metadata"] !== undefined) out["metadata"] = p["metadata"];
	if (p["message"] !== undefined) out["message"] = p["message"];
	return out;
}

/** Map a v1 question object → v2 Form.Info. */
function formV2(raw: unknown): Json {
	const q = asRecord(raw) ?? {};
	return {
		id:
			(q["id"] as string | undefined) ??
			`frm_${String(Math.random()).slice(2)}`,
		sessionID: q["sessionID"],
		title: (q["title"] as string | undefined) ?? "",
		fields: q["questions"] ?? q["fields"] ?? [],
		...(q["metadata"] !== undefined && { metadata: q["metadata"] }),
	};
}

/** Map a v1 tool state → v2 tool state. */
function toolStateV2(raw: unknown): Json {
	const s = asRecord(raw) ?? {};
	const status = s["status"] as string | undefined;
	switch (status) {
		case "pending":
			return { status: "streaming", input: s["raw"] ?? s["input"] ?? "" };
		case "running":
			return {
				status: "running",
				input: s["input"] ?? {},
				metadata: s["metadata"] ?? {},
			};
		case "completed":
			return {
				status: "completed",
				input: s["input"] ?? {},
				content: [{ type: "text", text: s["output"] ?? "" }],
				metadata: s["metadata"] ?? {},
			};
		case "error": {
			const err = s["error"];
			const message =
				typeof err === "string"
					? err
					: ((asRecord(err)?.["message"] as string | undefined) ??
						"Tool failed");
			return {
				status: "error",
				input: s["input"] ?? {},
				error: { message },
				content: [],
			};
		}
		default:
			return { status: "running", input: {}, metadata: {} };
	}
}

/** Map a v1 message part → v2 assistant content item (or null to drop). */
function partV2(raw: unknown): Json | null {
	const part = asRecord(raw) ?? {};
	const type = part["type"] as string | undefined;
	if (type === "text") return { type: "text", text: part["text"] ?? "" };
	if (type === "reasoning") {
		const time = asRecord(part["time"]);
		return {
			type: "reasoning",
			text: part["text"] ?? "",
			...(time && {
				time: { created: time["start"], completed: time["end"] },
			}),
		};
	}
	if (type === "tool") {
		return {
			type: "tool",
			id:
				(part["callID"] as string | undefined) ??
				(part["id"] as string | undefined),
			name: (part["tool"] as string | undefined) ?? "",
			state: toolStateV2(part["state"]),
			...(asRecord(part["time"]) && {
				time: {
					created: asRecord(part["time"])?.["start"],
					completed: asRecord(part["time"])?.["end"],
				},
			}),
		};
	}
	if (type === "compaction") {
		return {
			type: "compaction",
			summary: part["summary"],
			status: part["status"],
		};
	}
	return null;
}

function tokensV2(raw: unknown): Json {
	const t = asRecord(raw) ?? {};
	const cache = asRecord(t["cache"]);
	return {
		input: (t["input"] as number | undefined) ?? 0,
		output: (t["output"] as number | undefined) ?? 0,
		...(t["reasoning"] !== undefined && { reasoning: t["reasoning"] }),
		...(cache && {
			cache: { read: cache["read"] ?? 0, write: cache["write"] ?? 0 },
		}),
	};
}

/** Map a v1 message ({ info, parts }) → a v2 tagged-union message. */
function messageV2(raw: unknown): Json | null {
	const m = asRecord(raw) ?? {};
	const info = asRecord(m["info"]) ?? {};
	const id = info["id"];
	if (typeof id !== "string") return null;
	const time = asRecord(info["time"]);
	const base: Json = { id };
	if (time) {
		base["time"] = {
			...(time["created"] !== undefined && { created: time["created"] }),
			...(time["completed"] !== undefined && { completed: time["completed"] }),
		};
	}
	const role = (info["role"] as string | undefined) ?? "assistant";
	if (role === "user") {
		const text = asArray(m["parts"])
			.map((p) => asRecord(p))
			.filter((p) => p?.["type"] === "text")
			.map((p) => String(p?.["text"] ?? ""))
			.join("");
		return { ...base, type: "user", text };
	}
	if (role === "assistant") {
		const content = asArray(m["parts"])
			.map((p) => partV2(p))
			.filter((p): p is Json => p !== null);
		const out: Json = { ...base, type: "assistant", content };
		if (info["cost"] !== undefined) out["cost"] = info["cost"];
		if (info["tokens"] !== undefined) out["tokens"] = tokensV2(info["tokens"]);
		if (info["agent"] !== undefined) out["agent"] = info["agent"];
		if (info["error"] !== undefined) out["error"] = info["error"];
		return out;
	}
	// Unknown roles are dropped by the client; keep a minimal tagged object.
	return { ...base, type: role };
}

// ─── MockOpenCodeServer ──────────────────────────────────────────────────────

/** Structured log entry for debugging SSE delivery in E2E tests. */
export interface MockDiagnosticEntry {
	ts: number;
	event: string;
	detail?: string | undefined;
}

export class MockOpenCodeServer {
	private readonly recording: OpenCodeRecording;
	private server: Server | undefined;
	private wss: WebSocketServer | undefined;
	private _url = "";

	/** Diagnostic log for debugging E2E SSE delivery issues. */
	readonly diagnostics: MockDiagnosticEntry[] = [];

	// Replay state (rebuilt on reset)
	private exactQueues = new Map<string, QueuedRestResponse[]>();
	private normalizedQueues = new Map<string, QueuedRestResponse[]>();
	private ptyQueues = new Map<string, PtyInteraction[]>();
	private sseClients = new Set<ServerResponse>();
	private keepaliveIntervals = new Set<ReturnType<typeof setInterval>>();

	/** Counter for generating unique PTY IDs when no recording exists. */
	private ptyCounter = 0;

	/** Dynamically created PTY IDs (not from recording). */
	private dynamicPtyIds = new Set<string>();

	/** Sessions injected via POST /session (tracked separately for merging into all GET /session responses). */
	private injectedSessions = new Map<string, Record<string, unknown>>();

	/** Session IDs that have been deleted (filtered from GET /session). */
	private deletedSessionIds = new Set<string>();

	/** Title overrides from PATCH /session/:id. */
	private renamedSessions = new Map<string, string>();

	/** Counter for generating unique session IDs. */
	private sessionCounter = 0;

	/**
	 * SSE events grouped by prompt boundary. Segment 0 holds events before the
	 * first prompt, segment 1 after the first, etc. When a prompt fires, its
	 * segment (and segment 0 for the first prompt) is emitted independently of
	 * REST queue consumption.
	 */
	private sseSegments: SseEvent[][] = [[]];

	/** Number of prompt calls processed so far. */
	private promptsFired = 0;

	/**
	 * Session IDs from the recording's prompt URLs, in order. Used to rewrite
	 * SSE event session IDs to match the actual session used by the test.
	 */
	private recordedPromptSessionIds: string[] = [];

	/** Part id → v1 part type, used to distinguish text vs reasoning deltas. */
	private partTypes = new Map<string, string>();

	/** Monotonic SSE event id counter. */
	private eventCounter = 0;
	/** Recorded REST samples and SSE replay use different clocks. Once a lifecycle
	 * event has replayed, /session/active must agree with that live state. */
	private replayedActivity = new Map<string, boolean>();

	/** Models derived from the recorded v1 /provider payload for /api/model. */
	private derivedModels: Json[] = [];

	/** Default model derived from the recorded v1 /provider payload. */
	private derivedDefaultModel: Json | null = null;

	constructor(recording: OpenCodeRecording) {
		this.recording = recording;
		this.buildQueues();
	}

	/** Append a diagnostic entry. */
	private diag(event: string, detail?: string): void {
		this.diagnostics.push({ ts: Date.now(), event, detail });
	}

	/** Base URL of the mock server. Valid after start(). */
	get url(): string {
		return this._url;
	}

	private get cwd(): string {
		return process.cwd();
	}

	/** Start the mock HTTP + WS server on a random port. */
	async start(): Promise<void> {
		const server = createServer((req, res) => {
			this.handleRequest(req, res).catch(() => {
				if (!res.writableEnded) {
					res.writeHead(500);
					res.end();
				}
			});
		});
		this.server = server;

		const wss = new WebSocketServer({ noServer: true });
		this.wss = wss;
		server.on("upgrade", (req, socket, head) => {
			this.handleUpgrade(req, socket, head, wss);
		});

		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", resolve);
		});
		const addr = server.address() as AddressInfo;
		this._url = `http://127.0.0.1:${String(addr.port)}`;
	}

	/** Stop the mock server and clean up all resources. */
	async stop(): Promise<void> {
		this.cleanupSseClients();

		if (this.wss) {
			for (const client of this.wss.clients) {
				client.close();
			}
			this.wss.close();
			this.wss = undefined;
		}

		const server = this.server;
		if (server) {
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
			this.server = undefined;
		}
	}

	/** Re-initialize all replay state from the original recording. */
	reset(): void {
		this.cleanupSseClients();
		this.exactQueues.clear();
		this.normalizedQueues.clear();
		this.ptyQueues.clear();
		this.sseSegments = [[]];
		this.promptsFired = 0;
		this.ptyCounter = 0;
		this.dynamicPtyIds.clear();
		this.injectedSessions.clear();
		this.deletedSessionIds.clear();
		this.renamedSessions.clear();
		this.sessionCounter = 0;
		this.recordedPromptSessionIds = [];
		this.partTypes.clear();
		this.eventCounter = 0;
		this.replayedActivity.clear();
		this.derivedModels = [];
		this.derivedDefaultModel = null;
		this.buildQueues();
	}

	/**
	 * Force-flush all SSE segments without requiring a prompt.
	 * Use in tests that need SSE events without going through a prompt.
	 */
	flushPendingSse(): void {
		const allEvents = this.sseSegments.flat();
		this.emitEvents(allEvents);
		this.promptsFired = this.sseSegments.length;
	}

	/**
	 * Override the response for a specific exact endpoint.
	 * Replaces the entire queue for that key with a single sticky response
	 * (never consumed — always returns the same response).
	 */
	setExactResponse(
		method: string,
		path: string,
		status: number,
		responseBody: unknown,
	): void {
		const key = `${method.toUpperCase()} ${path}`;
		this.exactQueues.set(key, [{ status, responseBody }]);
	}

	/**
	 * Replace the message queue for a session with paginated responses.
	 * The first call returns `page1`, subsequent calls return `page2`.
	 */
	setMessagePages(sessionId: string, page1: unknown[], page2: unknown[]): void {
		const pages = [
			{ status: 200, responseBody: page1 },
			{ status: 200, responseBody: page2 },
		];
		// Exact key (matched first) plus normalized fallback.
		this.exactQueues.set(`GET /session/${sessionId}/message`, pages);
		this.normalizedQueues.set("GET /session/:param/message", [...pages]);
	}

	/**
	 * Emit a synthetic SSE event to all connected SSE clients.
	 * Accepts v1 or v2 event names/shapes; the v1→v2 adapter normalizes.
	 */
	emitTestEvent(
		type = "session.updated",
		properties: Record<string, unknown> = {},
	): void {
		this.emitEvents([{ type, properties, delayMs: 0 }]);
	}

	// ─── Session list fallback helpers ────────────────────────────────────
	// These mutate the GET /session queue's fallback entry in place so that
	// the standard queue-based response reflects create/delete/rename ops.

	private getSessionListFallback(): Array<Record<string, unknown>> {
		const queue = this.exactQueues.get("GET /session");
		if (!queue || queue.length === 0) return [];
		const fallback = queue.at(-1);
		if (!fallback || !Array.isArray(fallback.responseBody)) return [];
		return fallback.responseBody as Array<Record<string, unknown>>;
	}

	private injectIntoSessionListFallback(
		session: Record<string, unknown>,
	): void {
		const queue = this.exactQueues.get("GET /session");
		if (!queue || queue.length === 0) return;
		const fallback = queue.at(-1);
		if (!fallback || !Array.isArray(fallback.responseBody)) return;
		(fallback.responseBody as Array<Record<string, unknown>>).push(session);
	}

	private removeFromSessionListFallback(id: string): void {
		const queue = this.exactQueues.get("GET /session");
		if (!queue || queue.length === 0) return;
		const fallback = queue.at(-1);
		if (!fallback || !Array.isArray(fallback.responseBody)) return;
		fallback.responseBody = (
			fallback.responseBody as Array<Record<string, unknown>>
		).filter((s) => s["id"] !== id);
	}

	private renameInSessionListFallback(id: string, title: string): void {
		const list = this.getSessionListFallback();
		const session = list.find((s) => s["id"] === id);
		if (session) session["title"] = title;
	}

	/**
	 * Reset response queues without disconnecting SSE clients.
	 * For multi-test reuse within a shared relay.
	 */
	resetQueues(): void {
		this.exactQueues.clear();
		this.normalizedQueues.clear();
		this.ptyQueues.clear();
		this.promptsFired = 0;
		this.ptyCounter = 0;
		this.dynamicPtyIds.clear();
		this.injectedSessions.clear();
		this.deletedSessionIds.clear();
		this.renamedSessions.clear();
		this.sessionCounter = 0;
		this.recordedPromptSessionIds = [];
		this.partTypes.clear();
		this.eventCounter = 0;
		this.replayedActivity.clear();
		this.derivedModels = [];
		this.derivedDefaultModel = null;
		this.buildQueues();
	}

	// ─── Queue building ──────────────────────────────────────────────────────

	private static readonly PROMPT_RE =
		/\/session\/([^/]+)\/(?:prompt_async|prompt)$/;

	private buildQueues(): void {
		const { interactions } = this.recording;

		this.sseSegments = [[]];
		this.recordedPromptSessionIds = [];
		this.partTypes.clear();
		this.derivedModels = [];
		this.derivedDefaultModel = null;
		// Derive the v2 model catalog eagerly so /api/model is populated even
		// when it is requested concurrently with /api/provider.
		this.deriveModelsFromRecording();
		let currentSegment = 0;

		for (const ix of interactions) {
			if (ix.kind === "rest") {
				const isPrompt =
					ix.method === "POST" && MockOpenCodeServer.PROMPT_RE.test(ix.path);
				if (isPrompt) {
					currentSegment++;
					this.sseSegments[currentSegment] = [];
					const match = MockOpenCodeServer.PROMPT_RE.exec(ix.path);
					if (match?.[1]) this.recordedPromptSessionIds.push(match[1]);
				}

				const queued: QueuedRestResponse = {
					status: ix.status,
					responseBody: ix.responseBody,
				};

				const ek = exactKey(ix.method, ix.path);
				const nk = normalizedKey(ix.method, ix.path);

				this.pushQueue(this.exactQueues, ek, queued);
				if (nk !== ek) {
					this.pushQueue(this.normalizedQueues, nk, { ...queued });
				}
			} else if (ix.kind === "sse") {
				this.sseSegments[currentSegment]?.push({
					type: ix.type,
					properties: ix.properties,
					delayMs: ix.delayMs,
				});
			} else {
				this.pushPty(ix);
			}
		}
	}

	/** Push a response onto a queue map. */
	private pushQueue(
		map: Map<string, QueuedRestResponse[]>,
		key: string,
		entry: QueuedRestResponse,
	): void {
		const existing = map.get(key);
		if (existing) {
			existing.push(entry);
		} else {
			map.set(key, [entry]);
		}
	}

	/** Return a queue from a map that has at least one response, or undefined. */
	private getActiveQueue(
		map: Map<string, QueuedRestResponse[]>,
		key: string,
	): QueuedRestResponse[] | undefined {
		const queue = map.get(key);
		return queue && queue.length > 0 ? queue : undefined;
	}

	private pushPty(ix: PtyInteraction): void {
		const id = ix.ptyId;
		const existing = this.ptyQueues.get(id);
		if (existing) {
			existing.push(ix);
		} else {
			this.ptyQueues.set(id, [ix]);
		}
	}

	/**
	 * Candidate *recording* paths for a v2 request path (with `/api` stripped).
	 * Recordings were captured against v1, so some endpoints are renamed.
	 */
	private candidatePaths(apiPath: string): string[] {
		const out: string[] = [];
		out.push(apiPath);
		if (apiPath === "/location") out.push("/path");
		if (apiPath === "/fs/list") out.push("/file");
		if (apiPath.startsWith("/fs/read/")) out.push("/file/content");
		if (apiPath === "/permission/request") out.push("/permission");
		if (apiPath === "/form") out.push("/question");
		const prompt = /^\/session\/([^/]+)\/prompt$/.exec(apiPath);
		if (prompt?.[1]) out.push(`/session/${prompt[1]}/prompt_async`);
		const permReply = /^\/session\/([^/]+)\/permission\/([^/]+)\/reply$/.exec(
			apiPath,
		);
		if (permReply?.[2]) out.push(`/permission/${permReply[2]}/reply`);
		return out;
	}

	/**
	 * All candidate recording paths for a request path. Recordings may be
	 * keyed either with a `/api` prefix (regenerated v2 fixtures) or without
	 * (legacy v1 fixtures); this returns both forms plus v1 renames.
	 */
	private queueCandidates(path: string): string[] {
		const rawBase = path.split("?")[0] ?? path;
		const hadApi = rawBase === "/api" || rawBase.startsWith("/api/");
		const stripped = stripApi(path);
		const logical = new Set<string>([stripped]);
		for (const c of this.candidatePaths(stripped)) logical.add(c);
		const out = new Set<string>([rawBase]);
		for (const l of logical) {
			out.add(l);
			if (hadApi) out.add(`/api${l === "/" ? "" : l}`);
		}
		return [...out];
	}

	/** Look up a queued response for a v2 request, honoring v1 renames. */
	private findRestQueue(
		method: string,
		path: string,
	): QueuedRestResponse[] | undefined {
		for (const candidate of this.queueCandidates(path)) {
			const exact = this.getActiveQueue(
				this.exactQueues,
				exactKey(method, candidate),
			);
			if (exact) return exact;
			const normalized = this.getActiveQueue(
				this.normalizedQueues,
				normalizedKey(method, candidate),
			);
			if (normalized) return normalized;
		}
		return undefined;
	}

	// ─── HTTP request handling ───────────────────────────────────────────────

	private async handleRequest(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		const path = req.url ?? "/";
		const method = req.method ?? "GET";
		const basePath = stripApi(path);

		// SSE endpoint (v2: /api/event)
		if (basePath === "/event" && method === "GET") {
			this.handleSse(res);
			return;
		}

		// Read request body (used by stateful session handlers)
		const rawBody = await this.readBody(req);

		// ── Stateful PTY endpoints ──────────────────────────────────────────
		const ptyPath = basePath
			.replace(/^\/experimental\/session\/[^/]+\/terminal$/, "/pty")
			.replace(/^\/experimental\/persistent-pty\//, "/pty/");
		if (method === "POST" && ptyPath === "/pty") {
			const id = `pty_mock${String(++this.ptyCounter).padStart(3, "0")}`;
			this.dynamicPtyIds.add(id);
			this.respondJson(res, { data: { id } });
			return;
		}

		if (method === "GET" && ptyPath === "/pty") {
			const list = [...this.dynamicPtyIds].map((id) => ({ id }));
			this.respondJson(res, { location: { directory: this.cwd }, data: list });
			return;
		}

		if (method === "DELETE" && /^\/pty\/[^/]+$/.test(ptyPath)) {
			const id = ptyPath.split("/").pop() ?? "";
			this.dynamicPtyIds.delete(id);
			res.writeHead(204);
			res.end();
			return;
		}

		if (method === "PUT" && /^\/pty\/[^/]+$/.test(ptyPath)) {
			res.writeHead(204);
			res.end();
			return;
		}

		if (
			(method === "GET" || method === "POST") &&
			/^\/pty\/[^/]+\/connect-token$/.test(ptyPath)
		) {
			this.respondJson(res, { data: { token: "mock-ticket" } });
			return;
		}

		// ── Stateful session endpoints ──────────────────────────────────────
		// POST /session: use queue if available, otherwise generate dynamic session.
		if (method === "POST" && basePath === "/session") {
			let title = "Untitled";
			if (rawBody) {
				try {
					const parsed = JSON.parse(rawBody) as Record<string, unknown>;
					if (typeof parsed["title"] === "string") title = parsed["title"];
				} catch {
					/* ignore */
				}
			}

			const sessionQueue = this.findRestQueue("POST", path);
			if (sessionQueue && sessionQueue.length >= 1) {
				const entry =
					sessionQueue.length > 1
						? (sessionQueue.shift() as QueuedRestResponse)
						: (sessionQueue[0] as QueuedRestResponse);
				const body = { ...(entry.responseBody as Record<string, unknown>) };
				if (title !== "Untitled") body["title"] = title;
				const sessionId = body["id"] as string;
				if (sessionId && title !== "Untitled") {
					this.renamedSessions.set(sessionId, title);
				}
				if (sessionId) {
					this.deletedSessionIds.delete(sessionId);
					this.injectedSessions.set(sessionId, { ...body });
					const fallbackList = this.getSessionListFallback();
					const existing = fallbackList.find((s) => s["id"] === sessionId);
					if (existing) {
						if (title !== "Untitled") existing["title"] = title;
					} else {
						this.injectIntoSessionListFallback({ ...body });
					}
				}
				this.respondJson(res, { data: sessionV2(body) }, entry.status);
				return;
			}

			const id = `ses_mock${String(++this.sessionCounter).padStart(3, "0")}`;
			const session = { id, title, createdAt: new Date().toISOString() };
			this.injectedSessions.set(id, { ...session });
			this.injectIntoSessionListFallback(session);
			this.respondJson(res, { data: sessionV2(session) });
			return;
		}

		// GET /session: let the queue produce the base list, then apply
		// renames and filter deletes so every response reflects mutations.
		if (method === "GET" && basePath === "/session") {
			const sessionQueue =
				this.findRestQueue(method, path) ??
				this.getActiveQueue(this.exactQueues, "GET /session") ??
				this.getActiveQueue(this.normalizedQueues, "GET /session");

			if (sessionQueue) {
				const entry =
					sessionQueue.length > 1
						? (sessionQueue.shift() as QueuedRestResponse)
						: (sessionQueue[0] as QueuedRestResponse);
				let list = Array.isArray(entry.responseBody)
					? [...(entry.responseBody as Array<Record<string, unknown>>)]
					: [];

				for (const item of list) {
					const id = item["id"] as string;
					const newTitle = this.renamedSessions.get(id);
					if (newTitle !== undefined) item["title"] = newTitle;
				}

				for (const [id, session] of this.injectedSessions) {
					if (!list.some((s) => s["id"] === id)) {
						const renamedTitle = this.renamedSessions.get(id);
						list.push(
							renamedTitle
								? { ...session, title: renamedTitle }
								: { ...session },
						);
					}
				}

				list = list.filter(
					(s) => !this.deletedSessionIds.has(s["id"] as string),
				);

				this.respondJson(res, {
					data: list.map((s) => sessionV2(s)),
					cursor: { previous: null, next: null },
				});
				return;
			}
		}

		if (method === "DELETE" && /^\/session\/[^/]+$/.test(basePath)) {
			const id = basePath.split("/").pop() ?? "";
			this.deletedSessionIds.add(id);
			this.injectedSessions.delete(id);
			this.removeFromSessionListFallback(id);
			res.writeHead(204);
			res.end();
			return;
		}

		if (method === "PATCH" && /^\/session\/[^/]+$/.test(basePath)) {
			const id = basePath.split("/").pop() ?? "";
			let title: string | undefined;
			if (rawBody) {
				try {
					const parsed = JSON.parse(rawBody) as Record<string, unknown>;
					if (typeof parsed["title"] === "string") title = parsed["title"];
				} catch {
					/* ignore */
				}
			}
			if (title !== undefined) {
				this.renamedSessions.set(id, title);
				this.renameInSessionListFallback(id, title);
				const injected = this.injectedSessions.get(id);
				if (injected) injected["title"] = title;
			}
			const fallbackList = this.getSessionListFallback();
			const found = fallbackList.find((s) => s["id"] === id);
			const session = found ?? { id, title: title ?? "mock-title" };
			this.respondJson(res, { data: sessionV2(session) });
			return;
		}

		if (method === "GET" && basePath === "/session/search") {
			const queryString = path.split("?")[1] ?? "";
			const params = new URLSearchParams(queryString);
			const query = (
				params.get("q") ??
				params.get("query") ??
				""
			).toLowerCase();
			const fallbackList = this.getSessionListFallback();
			const allSessions = [...fallbackList];
			for (const [id, session] of this.injectedSessions) {
				if (!allSessions.some((s) => s["id"] === id)) {
					const renamedTitle = this.renamedSessions.get(id);
					allSessions.push(
						renamedTitle ? { ...session, title: renamedTitle } : { ...session },
					);
				}
			}
			const matches = allSessions
				.filter((s) => !this.deletedSessionIds.has(s["id"] as string))
				.filter((s) =>
					String(s["title"] ?? "")
						.toLowerCase()
						.includes(query),
				);
			this.respondJson(res, {
				data: matches.map((s) => sessionV2(s)),
				cursor: { previous: null, next: null },
			});
			return;
		}

		// ── GET /session/active (v2 replacement for /session/status) ─────────
		if (method === "GET" && basePath === "/session/active") {
			const statusQueue =
				this.findRestQueue(method, "/session/status") ??
				this.getActiveQueue(
					this.normalizedQueues,
					normalizedKey("GET", "/session/status"),
				);
			const active: Record<string, unknown> = {};
			if (statusQueue) {
				const shifted =
					statusQueue.length > 1 ? statusQueue.shift() : undefined;
				const statusEntry = shifted ?? statusQueue[0];
				const body = asRecord(statusEntry?.responseBody);
				if (body) {
					for (const [sid, value] of Object.entries(body)) {
						const status = asRecord(value);
						const type = status?.["type"];
						if (type === "busy") {
							active[sid] = { type: "running" };
						}
					}
				}
			}
			for (const [sessionId, running] of this.replayedActivity) {
				if (running) active[sessionId] = { type: "running" };
				else delete active[sessionId];
			}
			this.respondJson(res, { data: active });
			return;
		}

		// ── Generic queued response (falls back to synthetic v2 endpoints) ───
		const queue = this.findRestQueue(method, path);
		if (!queue) {
			const synthetic = this.syntheticFallback(method, basePath, rawBody);
			if (synthetic) {
				if (synthetic.status === 204) {
					res.writeHead(204);
					res.end();
				} else {
					this.respondJson(res, synthetic.body, synthetic.status);
				}
				return;
			}
			res.writeHead(404);
			res.end(
				JSON.stringify({
					error: "no queued response",
					exact: exactKey(method, stripApi(path)),
					normalized: normalizedKey(method, stripApi(path)),
				}),
			);
			return;
		}

		const shifted = queue.length > 1 ? queue.shift() : undefined;
		const entry = shifted ?? queue[0];
		if (!entry) {
			res.writeHead(404);
			res.end(JSON.stringify({ error: "empty queue" }));
			return;
		}

		// Detect prompt — emit the corresponding SSE segment.
		if (
			method === "POST" &&
			/\/session\/[^/]+\/(?:prompt|prompt_async)$/.test(basePath)
		) {
			this.firePromptSegment(basePath);
		}

		if (entry.status === 204) {
			res.writeHead(204);
			res.end();
			return;
		}

		// The recording path (post-rename) drives response translation.
		const recordingPath = this.resolveRecordingPath(method, stripApi(path));
		const translated = this.translateRestResponse(
			method,
			recordingPath,
			entry.responseBody,
		);
		this.respondJson(res, translated, entry.status);
	}

	/** Resolve the recording path used to translate a response body. */
	private resolveRecordingPath(method: string, apiPath: string): string {
		for (const candidate of this.queueCandidates(apiPath)) {
			if (
				this.exactQueues.has(exactKey(method, candidate)) ||
				this.normalizedQueues.has(normalizedKey(method, candidate))
			) {
				return stripApi(candidate);
			}
		}
		return stripApi(apiPath);
	}

	private respondJson(res: ServerResponse, body: unknown, status = 200): void {
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(JSON.stringify(body));
	}

	/** Translate a recorded (v1) response body into its v2 wire shape. */
	private translateRestResponse(
		method: string,
		path: string,
		body: unknown,
	): unknown {
		if (body === null || body === undefined) return body;
		const dir = this.cwd;
		const loc = { directory: dir };

		if (path === "/path" || path === "/location") {
			const p = asRecord(body) ?? {};
			const directory =
				(p["directory"] as string | undefined) ??
				(p["worktree"] as string | undefined) ??
				dir;
			return {
				directory,
				project: {
					id: (p["projectID"] as string | undefined) ?? "project",
					directory,
					canonical: directory,
				},
			};
		}

		if (path === "/agent") {
			return { location: loc, data: asArray(body).map((a) => agentV2(a)) };
		}

		if (path === "/provider") {
			const p = asRecord(body);
			const all = Array.isArray(body) ? body : asArray(p?.["all"]);
			this.deriveModels(all);
			return { location: loc, data: all.map((pr) => providerV2(pr)) };
		}

		if (path === "/model") {
			return { location: loc, data: asArray(body) };
		}

		if (path === "/model/default") {
			return { data: (asRecord(body)?.["data"] ?? body ?? null) as unknown };
		}

		if (path === "/command" || path === "/skill") {
			return { location: loc, data: asArray(body) };
		}

		if (path === "/permission") {
			return { location: loc, data: asArray(body).map((p) => permissionV2(p)) };
		}

		if (path === "/question") {
			return { location: loc, data: asArray(body).map((q) => formV2(q)) };
		}

		if (path === "/config" || path === "/project") {
			return Array.isArray(body) ? body : [];
		}

		if (path === "/pty") {
			return { location: loc, data: asArray(body) };
		}

		if (path === "/session" && method === "GET") {
			return {
				data: asArray(body).map((s) => sessionV2(s)),
				cursor: { previous: null, next: null },
			};
		}

		if (path === "/session" && method === "POST") {
			return { data: sessionV2(body) };
		}

		if (/^\/session\/[^/]+$/.test(path)) {
			return { data: sessionV2(body) };
		}

		if (/^\/session\/[^/]+\/message$/.test(path)) {
			return {
				data: asArray(body)
					.map((m) => messageV2(m))
					.filter((m): m is Json => m !== null),
				cursor: { previous: null, next: null },
			};
		}

		if (/^\/session\/[^/]+\/message\/[^/]+$/.test(path)) {
			const msg = messageV2(body);
			return { data: msg };
		}

		if (/^\/session\/[^/]+\/diff$/.test(path)) {
			return { data: asArray(body) };
		}

		return body;
	}

	/** Build v2 model catalog from the recorded v1 provider payload. */
	private deriveModels(providers: unknown[]): void {
		if (this.derivedModels.length > 0) return;
		const models: Json[] = [];
		let first: Json | null = null;
		for (const rawProvider of providers) {
			const provider = asRecord(rawProvider) ?? {};
			const providerID =
				(provider["id"] as string | undefined) ??
				(provider["name"] as string | undefined) ??
				"provider";
			const providerModels = asRecord(provider["models"]) ?? {};
			for (const [modelId, rawModel] of Object.entries(providerModels)) {
				const model = modelV2(providerID, modelId, rawModel);
				models.push(model);
				first ??= model;
			}
		}
		this.derivedModels = models;
		this.derivedDefaultModel = first;
	}

	/** Pre-derive the model catalog from the recording's /provider response. */
	private deriveModelsFromRecording(): void {
		for (const ix of this.recording.interactions) {
			if (
				ix.kind === "rest" &&
				ix.method === "GET" &&
				/(^|\/)provider$/.test(ix.path)
			) {
				const body = ix.responseBody;
				const record = asRecord(body);
				const all = Array.isArray(body) ? body : asArray(record?.["all"]);
				this.deriveModels(all);
				if (this.derivedModels.length > 0) return;
			}
		}
	}

	/** Synthetic responses for v2 endpoints not present in recordings. */
	private syntheticFallback(
		method: string,
		basePath: string,
		_rawBody: string | undefined,
	): { status: number; body?: unknown } | null {
		const dir = this.cwd;
		const loc = { directory: dir };

		if (method === "GET" && basePath === "/location") {
			return {
				status: 200,
				body: {
					directory: dir,
					project: { id: "project", directory: dir, canonical: dir },
				},
			};
		}
		if (method === "GET" && basePath === "/model") {
			return { status: 200, body: { location: loc, data: this.derivedModels } };
		}
		if (method === "GET" && basePath === "/model/default") {
			return { status: 200, body: { data: this.derivedDefaultModel } };
		}
		if (method === "GET" && basePath === "/config") {
			return { status: 200, body: [] };
		}
		if (method === "GET" && basePath === "/project") {
			return {
				status: 200,
				body: [
					{
						id: "project",
						canonical: dir,
						name: "project",
						time: { created: 0, updated: 0 },
						sandboxes: [],
					},
				],
			};
		}
		if (method === "GET" && basePath === "/skill") {
			return { status: 200, body: { location: loc, data: [] } };
		}
		if (method === "GET" && basePath === "/info") {
			return {
				status: 200,
				body: {
					version: "2.0.24",
					pid: process.pid,
					urls: [],
					paths: { tmp: "/tmp" },
				},
			};
		}
		if (method === "GET" && basePath === "/permission/request") {
			return { status: 200, body: { location: loc, data: [] } };
		}
		if (method === "GET" && basePath === "/form") {
			return { status: 200, body: { location: loc, data: [] } };
		}
		if (method === "GET" && basePath === "/command") {
			return { status: 200, body: { location: loc, data: [] } };
		}
		if (method === "GET" && basePath === "/fs/list") {
			return {
				status: 200,
				body: {
					location: loc,
					data: [
						{ path: "package.json", type: "file" },
						{ path: "tsconfig.json", type: "file" },
						{ path: "src", type: "directory" },
						{ path: "test", type: "directory" },
					],
				},
			};
		}
		if (method === "GET" && basePath.startsWith("/fs/read/")) {
			return { status: 200, body: "" };
		}
		if (method === "POST" && /^\/session\/[^/]+\/interrupt$/.test(basePath)) {
			return { status: 200, body: { interrupted: true } };
		}
		if (
			method === "POST" &&
			/^\/session\/[^/]+\/(model|agent)$/.test(basePath)
		) {
			return { status: 200, body: {} };
		}
		if (method === "POST" && /^\/session\/[^/]+\/compact$/.test(basePath)) {
			return { status: 200, body: { data: {} } };
		}
		if (method === "GET" && /^\/session\/[^/]+\/diff$/.test(basePath)) {
			return { status: 200, body: { data: [] } };
		}
		if (method === "POST" && /^\/session\/[^/]+\/fork$/.test(basePath)) {
			const id = `ses_fork${String(++this.sessionCounter).padStart(3, "0")}`;
			return { status: 200, body: { data: sessionV2({ id }) } };
		}
		if (
			method === "POST" &&
			/^\/session\/[^/]+\/permission\/[^/]+\/reply$/.test(basePath)
		) {
			return { status: 200, body: {} };
		}
		if (
			method === "POST" &&
			/^\/session\/[^/]+\/form\/[^/]+\/reply$/.test(basePath)
		) {
			return { status: 200, body: {} };
		}
		if (
			method === "DELETE" &&
			/^\/session\/[^/]+\/form\/[^/]+$/.test(basePath)
		) {
			return { status: 204 };
		}
		return null;
	}

	/** Emit the SSE segment associated with the Nth prompt. */
	private firePromptSegment(basePath: string): void {
		this.promptsFired++;
		const sseClientCount = this.sseClients.size;
		const promptMatch = /\/session\/([^/]+)\/(?:prompt|prompt_async)$/.exec(
			basePath,
		);
		const actualSessionId = promptMatch?.[1];
		const recordedSessionId =
			this.recordedPromptSessionIds[this.promptsFired - 1];
		const sessionIdMap =
			actualSessionId &&
			recordedSessionId &&
			actualSessionId !== recordedSessionId
				? { from: recordedSessionId, to: actualSessionId }
				: undefined;

		if (this.promptsFired === 1) {
			const combined = [
				...(this.sseSegments[0] ?? []),
				...(this.sseSegments[1] ?? []),
			];
			this.diag(
				"prompt",
				`#${this.promptsFired} combined=${combined.length} sseClients=${sseClientCount}`,
			);
			this.emitEvents(combined, sessionIdMap);
		} else {
			const segment = this.sseSegments[this.promptsFired] ?? [];
			this.diag(
				"prompt",
				`#${this.promptsFired} segment=${segment.length} sseClients=${sseClientCount}`,
			);
			this.emitEvents(segment, sessionIdMap);
		}
	}

	// ─── SSE handling ────────────────────────────────────────────────────────

	private handleSse(res: ServerResponse): void {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});

		// Flush headers so the client's body reader starts streaming.
		// SSE comments (lines starting with ':') are the v2 idle keepalive.
		res.write(": ok\n\n");

		const interval = setInterval(() => {
			if (!res.writableEnded) {
				res.write(": heartbeat\n\n");
			}
		}, 15_000);
		this.keepaliveIntervals.add(interval);

		this.sseClients.add(res);
		this.diag("sse_connect", `clients=${this.sseClients.size}`);

		res.on("close", () => {
			this.sseClients.delete(res);
			this.diag("sse_disconnect", `clients=${this.sseClients.size}`);
			clearInterval(interval);
			this.keepaliveIntervals.delete(interval);
		});
	}

	/**
	 * Inject SSE events directly into all connected SSE clients.
	 * Accepts v1 or v2 event names/shapes; the v1→v2 adapter normalizes.
	 */
	public injectSSEEvents(
		events: Array<{ type: string; properties: Record<string, unknown> }>,
	): void {
		this.emitEvents(
			events.map((e) => ({
				type: e.type,
				properties: e.properties,
				delayMs: 0,
			})),
		);
	}

	/**
	 * Rewrite session IDs in SSE event properties (v1 shape).
	 */
	private rewriteSessionIds(
		properties: Record<string, unknown>,
		map: { from: string; to: string },
	): Record<string, unknown> {
		const props = structuredClone(properties);
		if (props["sessionID"] === map.from) props["sessionID"] = map.to;
		const part = props["part"] as Record<string, unknown> | undefined;
		if (part && part["sessionID"] === map.from) part["sessionID"] = map.to;
		const info = props["info"] as Record<string, unknown> | undefined;
		if (info) {
			if (info["id"] === map.from) info["id"] = map.to;
			if (info["sessionID"] === map.from) info["sessionID"] = map.to;
		}
		return props;
	}

	/**
	 * Translate a recorded v1 SSE event into a v2 event `{ type, data }`, or
	 * null when the event has no v2 equivalent (and should be dropped).
	 */
	private translateSseEvent(
		type: string,
		props: Record<string, unknown>,
	): { type: string; data: Record<string, unknown> } | null {
		const sessionID = props["sessionID"] as string | undefined;

		switch (type) {
			case "server.connected":
				return { type: "server.connected", data: {} };
			case "server.heartbeat":
				return null;

			case "session.idle":
				return {
					type: "session.idle",
					data: { sessionID, outcome: "succeeded" },
				};

			case "session.status": {
				const status = asRecord(props["status"]);
				if (status?.["type"] === "idle") return null;
				return { type: "session.active", data: { sessionID } };
			}

			case "session.created": {
				const info = asRecord(props["info"]) ?? {};
				return { type: "session.created", data: sessionV2(info) };
			}

			case "session.updated": {
				const info = asRecord(props["info"]) ?? {};
				const data: Record<string, unknown> = {
					sessionID: info["id"],
					id: info["id"],
				};
				if (info["title"] !== undefined) data["title"] = info["title"];
				if (info["parentID"] !== undefined) data["parentID"] = info["parentID"];
				if (info["directory"] !== undefined) {
					data["location"] = { directory: info["directory"] };
				}
				return { type: "session.updated", data };
			}

			case "session.diff":
				return null;

			case "message.part.delta": {
				const partId = props["partID"] as string | undefined;
				const partType = partId ? this.partTypes.get(partId) : undefined;
				const delta = String(props["delta"] ?? "");
				if (partType === "reasoning") {
					return {
						type: "session.reasoning.delta",
						data: {
							sessionID,
							assistantMessageID: props["messageID"],
							delta,
						},
					};
				}
				return {
					type: "session.text.delta",
					data: {
						sessionID,
						assistantMessageID: props["messageID"],
						delta,
					},
				};
			}

			case "message.part.updated": {
				const part = asRecord(props["part"]);
				if (!part) return null;
				const pid =
					(part["id"] as string | undefined) ??
					(props["partID"] as string | undefined);
				const partType = part["type"] as string | undefined;
				if (pid && partType) this.partTypes.set(pid, partType);
				const sid = (part["sessionID"] as string | undefined) ?? sessionID;
				const mid = part["messageID"] as string | undefined;

				if (partType === "text") {
					return {
						type: "session.text.started",
						data: { sessionID: sid, assistantMessageID: mid },
					};
				}
				if (partType === "reasoning") {
					return {
						type: "session.reasoning.started",
						data: { sessionID: sid, assistantMessageID: mid },
					};
				}
				if (partType === "step-start") {
					return {
						type: "session.step.started",
						data: { sessionID: sid, assistantMessageID: mid },
					};
				}
				if (partType === "step-finish") {
					const tokens = asRecord(part["tokens"]) ?? {};
					const cache = asRecord(tokens["cache"]);
					return {
						type: "session.step.ended",
						data: {
							sessionID: sid,
							assistantMessageID: mid,
							tokens: {
								input: tokens["input"] ?? 0,
								output: tokens["output"] ?? 0,
								...(tokens["reasoning"] !== undefined && {
									reasoning: tokens["reasoning"],
								}),
								...(cache && {
									cache: {
										read: cache["read"] ?? 0,
										write: cache["write"] ?? 0,
									},
								}),
							},
							cost: part["cost"] ?? 0,
						},
					};
				}
				if (partType === "tool") {
					const state = asRecord(part["state"]) ?? {};
					const id = (part["callID"] as string | undefined) ?? pid ?? "";
					const name = (part["tool"] as string | undefined) ?? "";
					const status = state["status"] as string | undefined;
					if (status === "pending") {
						return {
							type: "session.tool.input.started",
							data: { sessionID: sid, assistantMessageID: mid, id, name },
						};
					}
					if (status === "running") {
						return {
							type: "session.tool.called",
							data: {
								sessionID: sid,
								assistantMessageID: mid,
								id,
								name,
								input: state["input"],
							},
						};
					}
					if (status === "completed") {
						return {
							type: "session.tool.success",
							data: {
								sessionID: sid,
								assistantMessageID: mid,
								id,
								content: [
									{ type: "text", text: String(state["output"] ?? "") },
								],
								...(state["metadata"] !== undefined && {
									metadata: state["metadata"],
								}),
							},
						};
					}
					if (status === "error") {
						const err = state["error"];
						const message =
							typeof err === "string"
								? err
								: ((asRecord(err)?.["message"] as string | undefined) ??
									"Tool failed");
						return {
							type: "session.tool.failed",
							data: {
								sessionID: sid,
								assistantMessageID: mid,
								id,
								error: { message },
							},
						};
					}
					return null;
				}
				return null;
			}

			case "message.updated": {
				const info = asRecord(props["info"]) ?? {};
				if (info["error"] !== undefined) {
					return {
						type: "session.error",
						data: {
							sessionID: info["sessionID"],
							error: info["error"],
						},
					};
				}
				return null;
			}

			case "permission.asked":
				return {
					type: "permission.asked",
					data: {
						id: props["id"],
						sessionID,
						action: props["permission"] ?? props["action"],
						resources: asArray(props["patterns"] ?? props["resources"]),
						save: asArray(props["always"] ?? props["save"]),
						metadata: props["metadata"] ?? {},
					},
				};

			case "permission.replied":
				return {
					type: "permission.replied",
					data: {
						requestID: props["requestID"],
						sessionID,
					},
				};

			case "file.edited":
			case "file.watcher.updated":
				return { type: "filesystem.changed", data: { file: props["file"] } };

			case "lsp.updated":
			case "lsp.client.diagnostics":
				return null;

			default:
				return { type, data: props };
		}
	}

	private emitEvents(
		events: SseEvent[],
		sessionIdMap?: { from: string; to: string },
	): void {
		if (events.length === 0) return;
		this.diag(
			"emit_start",
			`count=${events.length} sseClients=${this.sseClients.size}`,
		);

		void (async () => {
			let emitCount = 0;
			for (const event of events) {
				const delay = Math.min(event.delayMs, 5);
				if (delay > 0) {
					await new Promise<void>((r) => setTimeout(r, delay));
				}

				const properties = sessionIdMap
					? this.rewriteSessionIds(event.properties, sessionIdMap)
					: event.properties;

				const translated = this.translateSseEvent(event.type, properties);
				if (!translated) continue;
				const sessionId = translated.data["sessionID"];
				if (typeof sessionId === "string") {
					if (translated.type === "session.active")
						this.replayedActivity.set(sessionId, true);
					else if (translated.type === "session.idle")
						this.replayedActivity.set(sessionId, false);
				}

				const envelope = {
					id: `evt_mock${String(++this.eventCounter).padStart(6, "0")}`,
					created: Date.now(),
					type: translated.type,
					location: { directory: this.cwd },
					data: translated.data,
				};
				const frame = `data: ${JSON.stringify(envelope)}\n\n`;

				for (const client of this.sseClients) {
					if (!client.writableEnded) client.write(frame);
				}
				emitCount++;
			}
			this.diag("emit_done", `emitted=${emitCount}/${events.length}`);
		})();
	}

	// ─── PTY WebSocket handling ──────────────────────────────────────────────

	private handleUpgrade(
		req: IncomingMessage,
		socket: import("node:stream").Duplex,
		head: Buffer,
		wss: WebSocketServer,
	): void {
		const urlPath = req.url ?? "";
		const ptyMatch = /\/(?:pty|persistent-pty)\/([^/]+)\/connect/.exec(urlPath);

		if (!ptyMatch?.[1]) {
			socket.destroy();
			return;
		}

		const ptyId = ptyMatch[1];
		const queue = this.ptyQueues.get(ptyId);

		if (!queue || queue.length === 0) {
			wss.handleUpgrade(req, socket, head, (ws) => {
				if (ws.readyState === WebSocket.OPEN) {
					ws.send(
						JSON.stringify({
							type: "attached",
							attachmentID: `mock-${ptyId}`,
							inputProtocol: 1,
							role: "controller",
						}),
					);
					ws.send("$ ");
				}
				ws.on("message", (data: Buffer, isBinary: boolean) => {
					if (ws.readyState === WebSocket.OPEN) {
						if (isBinary && data.length >= 5 && data[0] === 1)
							ws.send(data.subarray(5).toString());
						else if (!isBinary) ws.send(data.toString());
					}
				});
			});
			return;
		}

		const openIdx = queue.findIndex((ix) => ix.kind === "pty-open");
		if (openIdx < 0) {
			wss.handleUpgrade(req, socket, head, (ws) => {
				ws.on("message", (data: Buffer, isBinary: boolean) => {
					if (ws.readyState === WebSocket.OPEN) {
						if (isBinary && data.length >= 5 && data[0] === 1)
							ws.send(data.subarray(5).toString());
						else if (!isBinary) ws.send(data.toString());
					}
				});
			});
			return;
		}
		queue.splice(openIdx, 1);

		wss.handleUpgrade(req, socket, head, (ws) => {
			void this.replayPtyOutput(ptyId, ws);

			ws.on("message", (_data, isBinary) => {
				if (isBinary) return;
				const currentQueue = this.ptyQueues.get(ptyId);
				if (!currentQueue) return;
				const nextInput = currentQueue.findIndex(
					(ix) => ix.kind === "pty-input",
				);
				if (nextInput >= 0) currentQueue.splice(nextInput, 1);
			});
		});
	}

	private async replayPtyOutput(ptyId: string, ws: WebSocket): Promise<void> {
		const queue = this.ptyQueues.get(ptyId);
		if (!queue) return;

		while (queue.length > 0) {
			const next = queue[0];
			if (!next) break;

			if (next.kind === "pty-output") {
				queue.shift();
				const delay = Math.min(next.delayMs, 5);
				if (delay > 0) await new Promise<void>((r) => setTimeout(r, delay));
				if (ws.readyState === WebSocket.OPEN) ws.send(next.data);
			} else if (next.kind === "pty-close") {
				queue.shift();
				const delay = Math.min(next.delayMs, 5);
				if (delay > 0) await new Promise<void>((r) => setTimeout(r, delay));
				if (ws.readyState === WebSocket.OPEN) {
					const code =
						next.code === 1005 || next.code === 1006 ? 1000 : next.code;
					ws.close(code, next.reason);
				}
				return;
			} else if (next.kind === "pty-input") {
				await new Promise<void>((r) => setTimeout(r, 10));
				if (queue[0] === next) break;
			} else {
				queue.shift();
			}
		}
	}

	// ─── Cleanup helpers ─────────────────────────────────────────────────────

	private cleanupSseClients(): void {
		for (const interval of this.keepaliveIntervals) {
			clearInterval(interval);
		}
		this.keepaliveIntervals.clear();

		for (const client of this.sseClients) {
			if (!client.writableEnded) client.end();
		}
		this.sseClients.clear();
	}

	private readBody(req: IncomingMessage): Promise<string | undefined> {
		return new Promise((resolve) => {
			const chunks: Buffer[] = [];
			req.on("data", (chunk: Buffer) => chunks.push(chunk));
			req.on("end", () => {
				if (chunks.length === 0) resolve(undefined);
				else resolve(Buffer.concat(chunks).toString());
			});
			req.on("error", () => resolve(undefined));
		});
	}
}
