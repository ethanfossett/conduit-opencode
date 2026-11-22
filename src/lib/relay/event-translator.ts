// ─── Event Translator (v2) ──────────────────────────────────────────────────
// Translates OpenCode v2 SSE events → relay WebSocket messages.
// Stateful: tracks seen parts for lifecycle detection / FIFO eviction.

import type { PermissionId } from "../shared-types.js";
import type {
	AskUserQuestion,
	OpenCodeEvent,
	PartType,
	RelayMessage,
	TodoItem,
	TodoStatus,
	ToolName,
	ToolStatus,
} from "../types.js";
import type { KnownOpenCodeEventType } from "./opencode-events.js";
import {
	type FormField,
	isFileChangedEvent,
	isFormCreatedEvent,
	isInstallationUpdateEvent,
	isPermissionAskedEvent,
	isPtyCreatedEvent,
	isPtyDeletedEvent,
	isPtyEvent,
	isPtyExitedEvent,
	isSessionErrorEvent,
	isSessionExecutionFailedEvent,
	isSessionIdleEvent,
	isSessionReasoningDeltaEvent,
	isSessionReasoningEndedEvent,
	isSessionReasoningStartedEvent,
	isSessionStepEndedEvent,
	isSessionTextDeltaEvent,
	isSessionTextEndedEvent,
	isSessionToolCalledEvent,
	isSessionToolFailedEvent,
	isSessionToolInputStartedEvent,
	isSessionToolProgressEvent,
	isSessionToolSuccessEvent,
	isTodoUpdatedEvent,
	type StructuredError,
	type ToolContent,
} from "./opencode-events.js";

// ─── Compile-time exhaustiveness assertion ──────────────────────────────────
// If a new event type is added to KnownOpenCodeEvent but not handled here,
// _MissingTypes will be non-never and this file will fail to compile.

type _HandledByTranslator =
	| "session.text.delta"
	| "session.text.ended"
	| "session.reasoning.started"
	| "session.reasoning.delta"
	| "session.reasoning.ended"
	| "session.tool.input.started"
	| "session.tool.called"
	| "session.tool.progress"
	| "session.tool.success"
	| "session.tool.failed"
	| "session.step.ended"
	| "session.execution.failed"
	| "session.idle"
	| "session.error"
	| "permission.asked"
	| "form.created"
	| "pty.created"
	| "pty.exited"
	| "pty.deleted"
	| "filesystem.changed"
	| "installation.update-available"
	| "todo.updated";

type _HandledByBridge =
	| "permission.replied"
	| "form.replied"
	| "form.cancelled";

type _IgnoredByTranslator =
	| "server.connected"
	| "session.execution.started"
	| "session.execution.succeeded"
	| "session.execution.interrupted"
	| "session.step.started"
	| "session.step.failed"
	| "session.text.started"
	| "session.tool.input.delta"
	| "session.tool.input.ended"
	| "session.skill.activated"
	| "session.compaction.started"
	| "session.compaction.delta"
	| "session.compaction.ended"
	| "session.compaction.failed"
	| "session.shell.started"
	| "session.shell.ended"
	| "session.updated"
	| "session.created"
	| "session.renamed"
	| "session.deleted"
	| "session.moved"
	| "session.active"
	| "pty.updated"
	| "provider.updated"
	| "model.updated"
	| "integration.updated"
	| "credential.switched"
	| "agent.updated"
	| "command.updated"
	| "skill.updated"
	| "reference.updated";

type _MissingTypes = Exclude<
	KnownOpenCodeEventType,
	_HandledByTranslator | _HandledByBridge | _IgnoredByTranslator
>;
type _AssertAllHandled = _MissingTypes extends never
	? true
	: { error: "Unhandled event type(s)"; types: _MissingTypes };
const _exhaustiveCheck: _AssertAllHandled = true;

// ─── Tool name mapping ──────────────────────────────────────────────────────

/** Maximum number of tracked parts before FIFO eviction kicks in. */
const SEEN_PARTS_MAX = 10_000;
/** Number of oldest entries to evict when the cap is reached. */
const SEEN_PARTS_EVICT_COUNT = 2_000;

/**
 * Tracked state for a single streamed part (tool / reasoning / text).
 * `name` is only meaningful for tool parts — it lets `session.tool.called`
 * (which carries no name in v2) recover the tool name captured earlier by
 * `session.tool.input.started`.
 */
export interface SeenPart {
	type: PartType;
	status?: ToolStatus;
	name?: string;
}

const TOOL_NAME_MAP: Record<string, ToolName> = {
	read: "Read",
	edit: "Edit",
	write: "Write",
	bash: "Bash",
	glob: "Glob",
	grep: "Grep",
	webfetch: "WebFetch",
	websearch: "WebSearch",
	todowrite: "TodoWrite",
	todoread: "TodoRead",
	question: "AskUserQuestion",
	task: "Task",
	lsp: "LSP",
	skill: "Skill",
};

/** Map lowercase OpenCode tool name → PascalCase frontend name */
export function mapToolName(name: string): string {
	return TOOL_NAME_MAP[name] ?? name;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Collapse a v2 tool `content` array into a display string. */
export function flattenToolContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as ToolContent[])
		.map((c) => {
			if (typeof c === "string") return c;
			if (c && typeof c === "object") {
				if (typeof c.text === "string") return c.text;
				if (typeof c.name === "string") return `[file: ${c.name}]`;
				if (typeof c.uri === "string") return `[file: ${c.uri}]`;
			}
			return "";
		})
		.filter((s) => s.length > 0)
		.join("\n");
}

/** Build the optional `{ messageId }` spread from an assistant message ID. */
function mid(
	value: string | undefined,
): { messageId?: string } | Record<string, never> {
	return value != null ? { messageId: value } : {};
}

/** Read an optional string field off an event's properties. */
function str(props: Record<string, unknown>, key: string): string | undefined {
	const value = props[key];
	return typeof value === "string" ? value : undefined;
}

// ─── Individual translators (v2) ────────────────────────────────────────────

/** Translate `session.text.delta` → `delta` */
export function translateTextDelta(event: OpenCodeEvent): RelayMessage | null {
	if (!isSessionTextDeltaEvent(event)) return null;
	const props = event.properties;
	return {
		type: "delta",
		text: props.delta,
		...mid(props.assistantMessageID),
	};
}

/**
 * Translate `session.text.ended` → `delta` carrying the block's complete text.
 *
 * v2 emits incremental `session.text.delta` frames plus a single
 * `session.text.ended` frame that carries the full text of the block. If the
 * relay (or a client) starts observing after the deltas were already emitted
 * — a late join, an SSE gap, or a stopped poller — `session.text.ended` is the
 * only remaining carrier of the assistant's reply. The stateful translator
 * decides whether emitting it here would duplicate already-seen deltas; this
 * pure function just performs the mapping.
 */
export function translateTextEnded(event: OpenCodeEvent): RelayMessage | null {
	if (!isSessionTextEndedEvent(event)) return null;
	const props = event.properties;
	const text = typeof props.text === "string" ? props.text : undefined;
	if (!text || text.length === 0) return null;
	return {
		type: "delta",
		text,
		...mid(props.assistantMessageID),
	};
}

/** Translate `session.reasoning.started` → `thinking_start` */
export function translateReasoningStarted(
	event: OpenCodeEvent,
): RelayMessage | null {
	if (!isSessionReasoningStartedEvent(event)) return null;
	return {
		type: "thinking_start",
		...mid(event.properties.assistantMessageID),
	};
}

/** Translate `session.reasoning.delta` → `thinking_delta` */
export function translateReasoningDelta(
	event: OpenCodeEvent,
): RelayMessage | null {
	if (!isSessionReasoningDeltaEvent(event)) return null;
	const props = event.properties;
	return {
		type: "thinking_delta",
		text: props.delta,
		...mid(props.assistantMessageID),
	};
}

/** Translate `session.reasoning.ended` → `thinking_stop` */
export function translateReasoningEnded(
	event: OpenCodeEvent,
): RelayMessage | null {
	if (!isSessionReasoningEndedEvent(event)) return null;
	return {
		type: "thinking_stop",
		...mid(event.properties.assistantMessageID),
	};
}

/** Translate `session.tool.input.started` → `tool_start` */
export function translateToolInputStarted(
	event: OpenCodeEvent,
): RelayMessage | null {
	if (!isSessionToolInputStartedEvent(event)) return null;
	const props = event.properties;
	return {
		type: "tool_start",
		id: props.id,
		name: mapToolName(props.name ?? ""),
		...mid(props.assistantMessageID),
	};
}

/** Translate `session.tool.called` → `tool_executing` */
export function translateToolCalled(event: OpenCodeEvent): RelayMessage | null {
	if (!isSessionToolCalledEvent(event)) return null;
	const props = event.properties;
	const metadata =
		typeof props["metadata"] === "object" && props["metadata"] !== null
			? (props["metadata"] as Record<string, unknown>)
			: undefined;
	return {
		type: "tool_executing",
		id: props.id,
		name: mapToolName(str(props, "name") ?? ""),
		input: props.input as Record<string, unknown> | undefined,
		...(metadata != null && { metadata }),
		...mid(props.assistantMessageID),
	};
}

/** Translate `session.tool.progress` → `tool_executing` */
export function translateToolProgress(
	event: OpenCodeEvent,
): RelayMessage | null {
	if (!isSessionToolProgressEvent(event)) return null;
	const props = event.properties;
	const metadata =
		props.metadata != null && typeof props.metadata === "object"
			? props.metadata
			: undefined;
	return {
		type: "tool_executing",
		id: props.id,
		name: mapToolName(str(props, "name") ?? ""),
		input: undefined,
		...(metadata != null && { metadata }),
		...mid(props.assistantMessageID),
	};
}

/** Translate `session.tool.success` → `tool_result` (is_error=false) */
export function translateToolSuccess(
	event: OpenCodeEvent,
): RelayMessage | null {
	if (!isSessionToolSuccessEvent(event)) return null;
	const props = event.properties;
	return {
		type: "tool_result",
		id: props.id,
		content: flattenToolContent(props.content),
		is_error: false,
		...mid(props.assistantMessageID),
	};
}

/** Translate `session.tool.failed` → `tool_result` (is_error=true) */
export function translateToolFailed(event: OpenCodeEvent): RelayMessage | null {
	if (!isSessionToolFailedEvent(event)) return null;
	const props = event.properties;
	const content =
		flattenToolContent(props.content) ||
		props.error?.message ||
		"Unknown error";
	return {
		type: "tool_result",
		id: props.id,
		content,
		is_error: true,
		...mid(props.assistantMessageID),
	};
}

/** Translate `session.step.ended` → `result` */
export function translateStepEnded(
	event: OpenCodeEvent,
	_sessionId?: string,
): RelayMessage | null {
	if (!isSessionStepEndedEvent(event)) return null;
	const props = event.properties;
	const cache = props.tokens?.cache;
	return {
		type: "result",
		usage: {
			input: props.tokens?.input ?? 0,
			output: props.tokens?.output ?? 0,
			cache_read: cache?.read ?? 0,
			cache_creation: cache?.write ?? 0,
		},
		cost: props.cost ?? 0,
		duration: 0,
		sessionId: props.sessionID ?? _sessionId ?? "",
		...mid(props.assistantMessageID),
	};
}

/** Translate `session.execution.failed` → `error` */
export function translateExecutionFailed(
	event: OpenCodeEvent,
): RelayMessage | null {
	if (!isSessionExecutionFailedEvent(event)) return null;
	return {
		type: "error",
		code: "EXECUTION_FAILED",
		message: event.properties.error.message ?? "Execution failed",
	};
}

/** Translate `session.idle` → `done` (succeeded) or `error` */
export function translateIdle(event: OpenCodeEvent): RelayMessage | null {
	if (!isSessionIdleEvent(event)) return null;
	const outcome = event.properties.outcome;
	if (outcome === "succeeded") {
		return { type: "done", code: 0 };
	}
	if (outcome === "interrupted") {
		return {
			type: "error",
			code: "INTERRUPTED",
			message: "Session interrupted",
		};
	}
	return {
		type: "error",
		code: "EXECUTION_FAILED",
		message: outcome ? `Session ${outcome}` : "Session failed",
	};
}

/** Translate `session.error` → `error` */
export function translateSessionError(
	event: OpenCodeEvent,
): RelayMessage | null {
	if (!isSessionErrorEvent(event)) return null;
	const err: StructuredError | undefined = event.properties.error;
	return {
		type: "error",
		code: (err?.type as string | undefined) ?? "SESSION_ERROR",
		message: err?.message ?? "An error occurred",
	};
}

/** Translate `permission.asked` event */
export function translatePermission(
	event: OpenCodeEvent,
	sessionId?: string,
): RelayMessage | null {
	if (!isPermissionAskedEvent(event)) return null;
	const props = event.properties;
	const sid = props.sessionID ?? sessionId;
	if (!sid) return null;

	return {
		type: "permission_request",
		sessionId: sid,
		requestId: props.id as PermissionId,
		toolName: props.action ?? "",
		toolInput: {
			patterns: props.resources ?? [],
			metadata: props.metadata ?? {},
		},
		always: props.save ?? [],
		toolUseId: props.id,
	};
}

/** Normalise a form's fields (object or array) into an array. */
function normalizeFormFields(
	fields: FormField[] | Record<string, FormField> | undefined,
): FormField[] {
	if (!fields) return [];
	if (Array.isArray(fields)) return fields;
	return Object.entries(fields).map(([key, value]) => ({ key, ...value }));
}

/** Translate a v2 form field → AskUserQuestion */
export function mapFormField(field: FormField): AskUserQuestion {
	const header = field.title ?? field.key ?? "";
	const options = (field.options ?? []).map((o) => {
		const label = o.label ?? String(o.value ?? "");
		return o.description != null
			? { label, description: o.description }
			: { label };
	});
	return {
		question: header,
		header,
		options,
		multiSelect: field.type === "multiselect",
		custom: field.custom ?? true,
	};
}

/** Translate `form.created` event → `ask_user` */
export function translateForm(event: OpenCodeEvent): RelayMessage | null {
	if (!isFormCreatedEvent(event)) return null;
	const form = event.properties.form;
	if (!form || typeof form.id !== "string") return null;

	const questions: AskUserQuestion[] = normalizeFormFields(form.fields).map(
		mapFormField,
	);

	return {
		type: "ask_user",
		toolId: form.id,
		questions,
		toolUseId: form.id,
	};
}

/** Translate pty.* events */
export function translatePtyEvent(event: OpenCodeEvent): RelayMessage | null {
	if (!isPtyEvent(event)) return null;

	if (isPtyCreatedEvent(event)) {
		const info = event.properties.info;
		return {
			type: "pty_created",
			pty: {
				id: String(info?.id ?? ""),
				title: String(info?.title ?? ""),
				command: String(info?.command ?? ""),
				cwd: String(info?.cwd ?? ""),
				status: info?.status === "exited" ? "exited" : "running",
				pid: Number(info?.pid ?? 0),
			},
		};
	}

	if (isPtyExitedEvent(event)) {
		const props = event.properties;
		return {
			type: "pty_exited",
			ptyId: String(props.id ?? ""),
			exitCode: Number(props.exitCode ?? 0),
		};
	}

	if (isPtyDeletedEvent(event)) {
		const props = event.properties;
		return {
			type: "pty_deleted",
			ptyId: String(props.id ?? ""),
		};
	}

	return null;
}

/** Translate `filesystem.changed` → `file_changed` */
export function translateFileChanged(
	event: OpenCodeEvent,
): RelayMessage | null {
	if (!isFileChangedEvent(event)) return null;
	const file = event.properties.file;
	if (typeof file !== "string" || file.length === 0) return null;
	return { type: "file_changed", path: file, changeType: "external" };
}

/** Translate `installation.update-available` → `update_available` */
export function translateInstallationUpdate(
	event: OpenCodeEvent,
): RelayMessage | null {
	if (!isInstallationUpdateEvent(event)) return null;
	const version = event.properties.version;
	return {
		type: "update_available",
		...(version != null && { version }),
	};
}

/** Translate `todo.updated` → `todo_state` */
export function translateTodoUpdated(
	event: OpenCodeEvent,
): RelayMessage | null {
	if (!isTodoUpdatedEvent(event)) return null;
	const items: TodoItem[] = (event.properties.todos ?? []).map((t, i) => ({
		id: `todo-${i}`,
		subject: t.content ?? "",
		status: (t.status as TodoStatus) ?? "pending",
	}));
	return { type: "todo_state", items };
}

// ─── TranslateResult discriminated union ────────────────────────────────────

export type TranslateResult =
	| { ok: true; messages: RelayMessage[] }
	| { ok: false; reason: string };

/** Optional context passed to the translator (e.g. session scope). */
export interface TranslateContext {
	sessionId?: string | undefined;
}

/** Wrap a sub-translator return value into a TranslateResult */
function wrapResult(
	result: RelayMessage | RelayMessage[] | null,
	fallbackReason: string,
): TranslateResult {
	if (!result) return { ok: false, reason: fallbackReason };
	return { ok: true, messages: Array.isArray(result) ? result : [result] };
}

// ─── Stateful translator ────────────────────────────────────────────────────

export interface Translator {
	translate(event: OpenCodeEvent, context?: TranslateContext): TranslateResult;
	/** Clear tracked parts. If sessionId provided, only that session. If omitted, all sessions. */
	reset(sessionId?: string): void;
	/** Get tracked parts for a session (or the default/fallback session if no sessionId). */
	getSeenParts(sessionId?: string): ReadonlyMap<string, SeenPart> | undefined;
	/** Rebuild part tracking from REST history for a specific session. */
	rebuildStateFromHistory(
		sessionId: string,
		messages: Array<{
			parts?: Array<{
				id: string;
				type: PartType;
				state?: { status?: ToolStatus };
				/** Tool name (REST `part.tool`) — lets tool.called recover it. */
				name?: string;
			}>;
		}>,
	): void;
}

export function createTranslator(): Translator {
	const DEFAULT_SESSION = "__default__";
	const sessionParts = new Map<string, Map<string, SeenPart>>();

	/**
	 * Per-session set of `messageId:ordinal` keys for which at least one
	 * `session.text.delta` frame was observed. Used to de-duplicate
	 * `session.text.ended`, which carries the block's full text: if we already
	 * streamed the deltas we must NOT re-emit the text, but if we never saw
	 * them (late join / SSE gap / stopped poller) the ended frame is the only
	 * remaining carrier of the reply.
	 */
	const sessionTextDeltasSeen = new Map<string, Set<string>>();

	function getOrCreateSessionParts(
		sessionId: string | undefined,
	): Map<string, SeenPart> {
		const key = sessionId ?? DEFAULT_SESSION;
		let parts = sessionParts.get(key);
		if (!parts) {
			parts = new Map();
			sessionParts.set(key, parts);
		}
		return parts;
	}

	function getOrCreateTextDeltaSet(sessionId: string | undefined): Set<string> {
		const key = sessionId ?? DEFAULT_SESSION;
		let seen = sessionTextDeltasSeen.get(key);
		if (!seen) {
			seen = new Set();
			sessionTextDeltasSeen.set(key, seen);
		}
		return seen;
	}

	function track(
		seenParts: Map<string, SeenPart>,
		id: string,
		type: PartType,
		status?: ToolStatus,
		name?: string,
	): void {
		const existing = seenParts.get(id);
		// Preserve a previously-recorded name unless the caller provides one
		// (tool.input.started carries the name; tool.called does not).
		const resolvedName = name ?? existing?.name;
		seenParts.set(id, {
			type,
			...(status != null && { status }),
			...(resolvedName != null && { name: resolvedName }),
		});
		evictOldestIfNeeded(seenParts);
	}

	return {
		translate(
			event: OpenCodeEvent,
			context?: TranslateContext,
		): TranslateResult {
			const eventType = event.type;
			const seenParts = getOrCreateSessionParts(context?.sessionId);
			const props = event.properties;

			// ── Streaming text ─────────────────────────────────────────────
			if (eventType === "session.text.delta") {
				const id = ordinalKey(props);
				if (id) {
					const seen = getOrCreateTextDeltaSet(context?.sessionId);
					seen.add(id);
					evictOldestFromSet(seen);
				}
				return wrapResult(
					translateTextDelta(event),
					"text delta: invalid event",
				);
			}
			if (eventType === "session.text.started") {
				const id = ordinalKey(props);
				if (id) track(seenParts, id, "text");
				return { ok: false, reason: "text started: no message emitted" };
			}
			if (eventType === "session.text.ended") {
				const id = ordinalKey(props);
				const textDeltas = getOrCreateTextDeltaSet(context?.sessionId);
				const alreadyStreamed = id != null && textDeltas.has(id);

				if (alreadyStreamed) {
					// Deltas observed — emitting the full text would duplicate.
					// Consume the flag so a replayed/repeated ended event does
					// not linger.
					if (id != null) textDeltas.delete(id);
					return {
						ok: false,
						reason: "text ended: deltas already streamed",
					};
				}

				const message = translateTextEnded(event);
				if (!message) {
					return {
						ok: false,
						reason: "text ended: no message emitted (empty text)",
					};
				}
				// Record so a duplicate/retried ended event doesn't double up.
				if (id != null) {
					textDeltas.add(id);
					evictOldestFromSet(textDeltas);
				}
				return { ok: true, messages: [message] };
			}

			// ── Reasoning ──────────────────────────────────────────────────
			if (eventType === "session.reasoning.started") {
				const id = ordinalKey(props);
				if (id) track(seenParts, id, "reasoning");
				return wrapResult(
					translateReasoningStarted(event),
					"reasoning started: invalid event",
				);
			}
			if (eventType === "session.reasoning.delta") {
				return wrapResult(
					translateReasoningDelta(event),
					"reasoning delta: invalid event",
				);
			}
			if (eventType === "session.reasoning.ended") {
				return wrapResult(
					translateReasoningEnded(event),
					"reasoning ended: invalid event",
				);
			}

			// ── Tools ──────────────────────────────────────────────────────
			if (eventType === "session.tool.input.started") {
				let toolId: string | undefined;
				let rawName: string | undefined;
				if (isSessionToolInputStartedEvent(event)) {
					toolId = event.properties.id;
					rawName =
						str(event.properties, "name") ?? str(event.properties, "tool");
					// tool.input.started is the ONLY v2 frame that carries the
					// tool name; remember it so the name-less tool.called frame
					// can recover it (the observed v2 behaviour).
					track(seenParts, toolId, "tool", "pending", rawName);
				}
				return applyTrackedToolName(
					wrapResult(
						translateToolInputStarted(event),
						"tool input started: invalid event",
					),
					seenParts,
					toolId,
				);
			}
			if (eventType === "session.tool.called") {
				let toolId: string | undefined;
				let rawName: string | undefined;
				if (isSessionToolCalledEvent(event)) {
					toolId = event.properties.id;
					rawName =
						str(event.properties, "name") ?? str(event.properties, "tool");
					track(seenParts, toolId, "tool", "running", rawName);
				}
				return applyTrackedToolName(
					wrapResult(translateToolCalled(event), "tool called: invalid event"),
					seenParts,
					toolId,
				);
			}
			if (eventType === "session.tool.progress") {
				const toolId = isSessionToolProgressEvent(event)
					? event.properties.id
					: undefined;
				return applyTrackedToolName(
					wrapResult(
						translateToolProgress(event),
						"tool progress: invalid event",
					),
					seenParts,
					toolId,
				);
			}
			if (eventType === "session.tool.success") {
				if (isSessionToolSuccessEvent(event)) {
					track(seenParts, event.properties.id, "tool", "completed");
				}
				return wrapResult(
					translateToolSuccess(event),
					"tool success: invalid event",
				);
			}
			if (eventType === "session.tool.failed") {
				if (isSessionToolFailedEvent(event)) {
					track(seenParts, event.properties.id, "tool", "error");
				}
				return wrapResult(
					translateToolFailed(event),
					"tool failed: invalid event",
				);
			}

			// ── Step / execution ───────────────────────────────────────────
			if (eventType === "session.step.ended") {
				return wrapResult(
					translateStepEnded(event),
					"step ended: invalid event",
				);
			}
			if (eventType === "session.execution.failed") {
				return wrapResult(
					translateExecutionFailed(event),
					"execution failed: invalid event",
				);
			}

			// ── Session lifecycle ──────────────────────────────────────────
			if (eventType === "session.idle") {
				return wrapResult(translateIdle(event), "idle: invalid event");
			}
			if (eventType === "session.error") {
				return wrapResult(
					translateSessionError(event),
					"session error: invalid event",
				);
			}

			// ── Permission / form ──────────────────────────────────────────
			if (eventType === "permission.asked") {
				return wrapResult(
					translatePermission(event, context?.sessionId),
					"permission asked: invalid event or no sessionId",
				);
			}
			if (eventType === "form.created") {
				return wrapResult(translateForm(event), "form created: invalid form");
			}

			// ── PTY ────────────────────────────────────────────────────────
			if (eventType.startsWith("pty.")) {
				return wrapResult(
					translatePtyEvent(event),
					"pty event: unhandled pty event type",
				);
			}

			// ── Filesystem ─────────────────────────────────────────────────
			if (eventType === "filesystem.changed") {
				return wrapResult(
					translateFileChanged(event),
					"filesystem changed: invalid event",
				);
			}

			// ── Installation / todo ────────────────────────────────────────
			if (eventType === "installation.update-available") {
				return wrapResult(
					translateInstallationUpdate(event),
					"installation update: invalid event",
				);
			}
			if (eventType === "todo.updated") {
				return wrapResult(
					translateTodoUpdated(event),
					"todo updated: invalid event",
				);
			}

			// ── Known event types handled by bridge / SSE wiring ───────────
			if (
				eventType === "permission.replied" ||
				eventType === "form.replied" ||
				eventType === "form.cancelled"
			) {
				return { ok: false, reason: `${eventType} handled by bridge` };
			}

			// ── Catalog refresh / informational events (intentionally ignored) ──
			if (
				eventType === "server.connected" ||
				eventType === "session.execution.started" ||
				eventType === "session.execution.succeeded" ||
				eventType === "session.execution.interrupted" ||
				eventType === "session.step.started" ||
				eventType === "session.step.failed" ||
				eventType === "session.tool.input.delta" ||
				eventType === "session.tool.input.ended" ||
				eventType === "session.skill.activated" ||
				eventType.startsWith("session.compaction.") ||
				eventType.startsWith("session.shell.") ||
				eventType === "session.updated" ||
				eventType === "session.created" ||
				eventType === "session.renamed" ||
				eventType === "session.deleted" ||
				eventType === "session.moved" ||
				eventType === "session.active" ||
				eventType === "pty.updated" ||
				eventType === "provider.updated" ||
				eventType === "model.updated" ||
				eventType === "integration.updated" ||
				eventType === "credential.switched" ||
				eventType === "agent.updated" ||
				eventType === "command.updated" ||
				eventType === "skill.updated" ||
				eventType === "reference.updated"
			) {
				return { ok: false, reason: `${eventType} ignored by translator` };
			}

			// Unknown event type
			return {
				ok: false,
				reason: `unhandled event type: ${eventType}`,
			};
		},

		reset(sessionId?: string) {
			if (sessionId != null) {
				sessionParts.delete(sessionId);
				sessionTextDeltasSeen.delete(sessionId);
			} else {
				sessionParts.clear();
				sessionTextDeltasSeen.clear();
			}
		},

		getSeenParts(sessionId?: string) {
			return sessionParts.get(sessionId ?? DEFAULT_SESSION);
		},

		rebuildStateFromHistory(
			sessionId: string,
			messages: Array<{
				parts?: Array<{
					id: string;
					type: PartType;
					state?: { status?: ToolStatus };
					name?: string;
				}>;
			}>,
		) {
			const parts = getOrCreateSessionParts(sessionId);
			parts.clear();
			for (const msg of messages) {
				for (const part of msg.parts ?? []) {
					parts.set(part.id, {
						type: part.type,
						...(part.state?.status != null && { status: part.state.status }),
						...(part.name != null && { name: part.name }),
					});
				}
			}
		},
	};
}

/**
 * Fill in an empty tool name on a translated `tool_start`/`tool_executing`
 * message using the name previously captured from `session.tool.input.started`.
 *
 * v2's `session.tool.called` frame carries no `name`, so the naive translation
 * produced `name: ""`; the name is only available on the earlier
 * `session.tool.input.started` frame. Reuse the translator's tracked state.
 */
function applyTrackedToolName(
	result: TranslateResult,
	seenParts: Map<string, SeenPart>,
	toolId: string | undefined,
): TranslateResult {
	if (!result.ok || toolId == null) return result;
	const known = seenParts.get(toolId)?.name;
	if (!known) return result;
	let mutated = false;
	const messages = result.messages.map((m) => {
		if (
			(m.type === "tool_start" || m.type === "tool_executing") &&
			m.name === ""
		) {
			mutated = true;
			return { ...m, name: mapToolName(known) };
		}
		return m;
	});
	return mutated ? { ok: true, messages } : result;
}

/** Build a stable tracking key from a message id + ordinal. */
function ordinalKey(props: Record<string, unknown>): string | undefined {
	const messageId = str(props, "assistantMessageID");
	const ordinal = props["ordinal"];
	if (messageId == null && ordinal == null) return undefined;
	return `${messageId ?? "?"}:${String(ordinal ?? "?")}`;
}

/**
 * Rebuild translator state from REST API messages.
 * Fetches messages for the given session and populates the translator's
 * seenParts map so it knows which parts already exist (prevents duplicate
 * tool_start/thinking_start on session switch or SSE reconnection).
 */
export async function rebuildTranslatorFromHistory<
	M extends {
		parts?: Array<{ id: string; type: string; [key: string]: unknown }>;
	},
>(
	translator: Translator,
	getMessages: (sessionId: string) => Promise<M[]>,
	sessionId: string,
	log: { warn(...args: unknown[]): void },
): Promise<M[] | undefined> {
	try {
		const messages = await getMessages(sessionId);
		const parts = messages.map((m) => {
			const rawParts = (m as { parts?: unknown[] }).parts as
				| Array<{
						id: string;
						type: PartType;
						state?: { status?: ToolStatus };
						tool?: unknown;
				  }>
				| undefined;
			if (rawParts == null) return {};
			return {
				parts: rawParts.map((p) => ({
					id: p.id,
					type: p.type,
					...(p.state != null ? { state: p.state } : {}),
					...(typeof p.tool === "string" && p.tool.length > 0
						? { name: p.tool }
						: {}),
				})),
			};
		});
		translator.rebuildStateFromHistory(sessionId, parts);
		return messages;
	} catch (err) {
		log.warn(
			`rebuildStateFromHistory failed for ${sessionId}: ${err instanceof Error ? err.message : err}`,
		);
		return undefined;
	}
}

/**
 * FIFO eviction: if seenParts exceeds the max cap, delete the oldest entries.
 * Map preserves insertion order, so iterating keys() yields oldest first.
 */
function evictOldestIfNeeded(seenParts: Map<string, SeenPart>): void {
	if (seenParts.size <= SEEN_PARTS_MAX) return;
	let evicted = 0;
	for (const key of seenParts.keys()) {
		if (evicted >= SEEN_PARTS_EVICT_COUNT) break;
		seenParts.delete(key);
		evicted++;
	}
}

/**
 * FIFO eviction for the per-session text-delta key set. Set preserves insertion
 * order, so iterating keys() yields oldest first.
 */
function evictOldestFromSet(seen: Set<string>): void {
	if (seen.size <= SEEN_PARTS_MAX) return;
	let evicted = 0;
	for (const key of seen.keys()) {
		if (evicted >= SEEN_PARTS_EVICT_COUNT) break;
		seen.delete(key);
		evicted++;
	}
}
