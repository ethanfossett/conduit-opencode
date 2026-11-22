// ─── OpenCode v2 Event Type Guards ───────────────────────────────────────────
// Typed interfaces and runtime type guard functions for the OpenCode v2 SSE
// event stream. The v2 SSE envelope is normalised by `parseSSEDataAuto` into
// `{ type, properties }` where `properties` is the envelope's `data` object, so
// every guard below narrows on `.type` and inspects `.properties`.
//
// These guards replace the removed v1 guards (message.part.*, question.asked,
// session.status, file.edited, …).

import type { BaseOpenCodeEvent } from "../types.js";

// ─── Helper ──────────────────────────────────────────────────────────────────

function hasProps(
	event: unknown,
): event is { type: string; properties: Record<string, unknown> } {
	return (
		typeof event === "object" &&
		event !== null &&
		"type" in event &&
		typeof (event as Record<string, unknown>)["type"] === "string" &&
		"properties" in event &&
		typeof (event as Record<string, unknown>)["properties"] === "object" &&
		(event as Record<string, unknown>)["properties"] !== null
	);
}

// ─── Shared data shapes ──────────────────────────────────────────────────────

export interface StructuredError {
	type?: string;
	message?: string;
	status?: number;
	response?: unknown;
	[key: string]: unknown;
}

export interface TokenUsage {
	input?: number;
	output?: number;
	reasoning?: number;
	cache?: { read?: number; write?: number };
}

export interface ToolContent {
	type?: string;
	text?: string;
	uri?: string;
	mime?: string;
	name?: string | null;
	[key: string]: unknown;
}

export interface FormField {
	key?: string;
	type?: string;
	title?: string;
	description?: string;
	required?: boolean;
	options?: Array<{
		value?: unknown;
		label?: string;
		description?: string;
		[key: string]: unknown;
	}>;
	custom?: boolean;
	[key: string]: unknown;
}

export interface FormInfo {
	id: string;
	sessionID?: string;
	title?: string;
	metadata?: Record<string, unknown>;
	fields?: Record<string, FormField> | FormField[];
	[key: string]: unknown;
}

export interface PtyInfoData {
	id: string;
	title?: string;
	command?: string;
	args?: string[];
	cwd?: string;
	status?: string;
	pid?: number;
	exitCode?: number;
	[key: string]: unknown;
}

export interface ShellInfo {
	id?: string;
	command?: string;
	[key: string]: unknown;
}

// ─── Server ──────────────────────────────────────────────────────────────────

export interface ServerConnectedEvent extends BaseOpenCodeEvent {
	type: "server.connected";
	properties: Record<string, unknown>;
}

export function isServerConnectedEvent(
	event: unknown,
): event is ServerConnectedEvent {
	return hasProps(event) && event.type === "server.connected";
}

// ─── Session execution ───────────────────────────────────────────────────────

export interface SessionExecutionStartedEvent extends BaseOpenCodeEvent {
	type: "session.execution.started";
	properties: { sessionID?: string; [key: string]: unknown };
}

export interface SessionExecutionSucceededEvent extends BaseOpenCodeEvent {
	type: "session.execution.succeeded";
	properties: { sessionID?: string; [key: string]: unknown };
}

export interface SessionExecutionFailedEvent extends BaseOpenCodeEvent {
	type: "session.execution.failed";
	properties: {
		sessionID?: string;
		error: StructuredError;
		[key: string]: unknown;
	};
}

export interface SessionExecutionInterruptedEvent extends BaseOpenCodeEvent {
	type: "session.execution.interrupted";
	properties: {
		sessionID?: string;
		reason?: string;
		[key: string]: unknown;
	};
}

export function isSessionExecutionFailedEvent(
	event: unknown,
): event is SessionExecutionFailedEvent {
	if (!hasProps(event) || event.type !== "session.execution.failed")
		return false;
	const p = event.properties;
	return typeof p["error"] === "object" && p["error"] !== null;
}

export function isSessionExecutionInterruptedEvent(
	event: unknown,
): event is SessionExecutionInterruptedEvent {
	return hasProps(event) && event.type === "session.execution.interrupted";
}

// ─── Session step ────────────────────────────────────────────────────────────

export interface SessionStepStartedEvent extends BaseOpenCodeEvent {
	type: "session.step.started";
	properties: {
		sessionID?: string;
		assistantMessageID?: string;
		model?: { providerID?: string; id?: string };
		agent?: string;
		[key: string]: unknown;
	};
}

export interface SessionStepEndedEvent extends BaseOpenCodeEvent {
	type: "session.step.ended";
	properties: {
		sessionID?: string;
		assistantMessageID?: string;
		tokens?: TokenUsage;
		cost?: number;
		[key: string]: unknown;
	};
}

export interface SessionStepFailedEvent extends BaseOpenCodeEvent {
	type: "session.step.failed";
	properties: {
		sessionID?: string;
		assistantMessageID?: string;
		error?: StructuredError;
		[key: string]: unknown;
	};
}

export function isSessionStepEndedEvent(
	event: unknown,
): event is SessionStepEndedEvent {
	return hasProps(event) && event.type === "session.step.ended";
}

// ─── Session text ────────────────────────────────────────────────────────────

export interface SessionTextStartedEvent extends BaseOpenCodeEvent {
	type: "session.text.started";
	properties: {
		sessionID?: string;
		assistantMessageID?: string;
		ordinal?: number;
		[key: string]: unknown;
	};
}

export interface SessionTextDeltaEvent extends BaseOpenCodeEvent {
	type: "session.text.delta";
	properties: {
		sessionID?: string;
		assistantMessageID?: string;
		ordinal?: number;
		delta: string;
		[key: string]: unknown;
	};
}

export interface SessionTextEndedEvent extends BaseOpenCodeEvent {
	type: "session.text.ended";
	properties: {
		sessionID?: string;
		assistantMessageID?: string;
		ordinal?: number;
		text?: string;
		[key: string]: unknown;
	};
}

export function isSessionTextDeltaEvent(
	event: unknown,
): event is SessionTextDeltaEvent {
	if (!hasProps(event) || event.type !== "session.text.delta") return false;
	return typeof event.properties["delta"] === "string";
}

export function isSessionTextEndedEvent(
	event: unknown,
): event is SessionTextEndedEvent {
	return hasProps(event) && event.type === "session.text.ended";
}

// ─── Session reasoning ───────────────────────────────────────────────────────

export interface SessionReasoningStartedEvent extends BaseOpenCodeEvent {
	type: "session.reasoning.started";
	properties: {
		sessionID?: string;
		assistantMessageID?: string;
		ordinal?: number;
		[key: string]: unknown;
	};
}

export interface SessionReasoningDeltaEvent extends BaseOpenCodeEvent {
	type: "session.reasoning.delta";
	properties: {
		sessionID?: string;
		assistantMessageID?: string;
		ordinal?: number;
		delta: string;
		[key: string]: unknown;
	};
}

export interface SessionReasoningEndedEvent extends BaseOpenCodeEvent {
	type: "session.reasoning.ended";
	properties: {
		sessionID?: string;
		assistantMessageID?: string;
		ordinal?: number;
		text?: string;
		[key: string]: unknown;
	};
}

export function isSessionReasoningStartedEvent(
	event: unknown,
): event is SessionReasoningStartedEvent {
	return hasProps(event) && event.type === "session.reasoning.started";
}

export function isSessionReasoningDeltaEvent(
	event: unknown,
): event is SessionReasoningDeltaEvent {
	if (!hasProps(event) || event.type !== "session.reasoning.delta")
		return false;
	return typeof event.properties["delta"] === "string";
}

export function isSessionReasoningEndedEvent(
	event: unknown,
): event is SessionReasoningEndedEvent {
	return hasProps(event) && event.type === "session.reasoning.ended";
}

// ─── Session tools ───────────────────────────────────────────────────────────

export interface SessionToolInputStartedEvent extends BaseOpenCodeEvent {
	type: "session.tool.input.started";
	properties: {
		sessionID?: string;
		assistantMessageID?: string;
		id: string;
		name?: string;
		[key: string]: unknown;
	};
}

export interface SessionToolInputDeltaEvent extends BaseOpenCodeEvent {
	type: "session.tool.input.delta";
	properties: {
		sessionID?: string;
		assistantMessageID?: string;
		id: string;
		delta?: string;
		[key: string]: unknown;
	};
}

export interface SessionToolInputEndedEvent extends BaseOpenCodeEvent {
	type: "session.tool.input.ended";
	properties: {
		sessionID?: string;
		assistantMessageID?: string;
		id: string;
		text?: string;
		[key: string]: unknown;
	};
}

export interface SessionToolCalledEvent extends BaseOpenCodeEvent {
	type: "session.tool.called";
	properties: {
		sessionID?: string;
		assistantMessageID?: string;
		id: string;
		input?: unknown;
		executed?: boolean;
		state?: unknown;
		[key: string]: unknown;
	};
}

export interface SessionToolProgressEvent extends BaseOpenCodeEvent {
	type: "session.tool.progress";
	properties: {
		sessionID?: string;
		assistantMessageID?: string;
		id: string;
		metadata?: Record<string, unknown>;
		[key: string]: unknown;
	};
}

export interface SessionToolSuccessEvent extends BaseOpenCodeEvent {
	type: "session.tool.success";
	properties: {
		sessionID?: string;
		assistantMessageID?: string;
		id: string;
		executed?: boolean;
		resultState?: unknown;
		metadata?: Record<string, unknown>;
		content?: ToolContent[];
		error?: StructuredError;
		[key: string]: unknown;
	};
}

export interface SessionToolFailedEvent extends BaseOpenCodeEvent {
	type: "session.tool.failed";
	properties: {
		sessionID?: string;
		assistantMessageID?: string;
		id: string;
		executed?: boolean;
		resultState?: unknown;
		metadata?: Record<string, unknown>;
		content?: ToolContent[];
		error?: StructuredError;
		[key: string]: unknown;
	};
}

export function isSessionToolInputStartedEvent(
	event: unknown,
): event is SessionToolInputStartedEvent {
	if (!hasProps(event) || event.type !== "session.tool.input.started") {
		return false;
	}
	return typeof event.properties["id"] === "string";
}

export function isSessionToolCalledEvent(
	event: unknown,
): event is SessionToolCalledEvent {
	if (!hasProps(event) || event.type !== "session.tool.called") return false;
	return typeof event.properties["id"] === "string";
}

export function isSessionToolProgressEvent(
	event: unknown,
): event is SessionToolProgressEvent {
	if (!hasProps(event) || event.type !== "session.tool.progress") return false;
	return typeof event.properties["id"] === "string";
}

export function isSessionToolSuccessEvent(
	event: unknown,
): event is SessionToolSuccessEvent {
	if (!hasProps(event) || event.type !== "session.tool.success") return false;
	return typeof event.properties["id"] === "string";
}

export function isSessionToolFailedEvent(
	event: unknown,
): event is SessionToolFailedEvent {
	if (!hasProps(event) || event.type !== "session.tool.failed") return false;
	return typeof event.properties["id"] === "string";
}

// ─── Session skill ───────────────────────────────────────────────────────────

export interface SessionSkillActivatedEvent extends BaseOpenCodeEvent {
	type: "session.skill.activated";
	properties: { sessionID?: string; name?: string; [key: string]: unknown };
}

// ─── Session compaction ──────────────────────────────────────────────────────

export interface SessionCompactionStartedEvent extends BaseOpenCodeEvent {
	type: "session.compaction.started";
	properties: { sessionID?: string; [key: string]: unknown };
}

export interface SessionCompactionDeltaEvent extends BaseOpenCodeEvent {
	type: "session.compaction.delta";
	properties: { sessionID?: string; text?: string; [key: string]: unknown };
}

export interface SessionCompactionEndedEvent extends BaseOpenCodeEvent {
	type: "session.compaction.ended";
	properties: { sessionID?: string; text?: string; [key: string]: unknown };
}

export interface SessionCompactionFailedEvent extends BaseOpenCodeEvent {
	type: "session.compaction.failed";
	properties: {
		sessionID?: string;
		error?: StructuredError;
		[key: string]: unknown;
	};
}

export type SessionCompactionEvent =
	| SessionCompactionStartedEvent
	| SessionCompactionDeltaEvent
	| SessionCompactionEndedEvent
	| SessionCompactionFailedEvent;

export function isSessionCompactionEvent(
	event: unknown,
): event is SessionCompactionEvent {
	if (!hasProps(event)) return false;
	return event.type.startsWith("session.compaction.");
}

// ─── Session shell ───────────────────────────────────────────────────────────

export interface SessionShellStartedEvent extends BaseOpenCodeEvent {
	type: "session.shell.started";
	properties: {
		sessionID?: string;
		shell?: ShellInfo;
		[key: string]: unknown;
	};
}

export interface SessionShellEndedEvent extends BaseOpenCodeEvent {
	type: "session.shell.ended";
	properties: {
		sessionID?: string;
		shell?: ShellInfo;
		output?: string;
		[key: string]: unknown;
	};
}

// ─── Session lifecycle ───────────────────────────────────────────────────────

export interface SessionIdleEvent extends BaseOpenCodeEvent {
	type: "session.idle";
	properties: {
		sessionID?: string;
		outcome?: "succeeded" | "failed" | "interrupted" | string;
		[key: string]: unknown;
	};
}

export interface SessionErrorEvent extends BaseOpenCodeEvent {
	type: "session.error";
	properties: {
		sessionID?: string;
		error?: StructuredError;
		[key: string]: unknown;
	};
}

export function isSessionIdleEvent(event: unknown): event is SessionIdleEvent {
	return hasProps(event) && event.type === "session.idle";
}

export function isSessionErrorEvent(
	event: unknown,
): event is SessionErrorEvent {
	return hasProps(event) && event.type === "session.error";
}

export interface SessionUpdatedEvent extends BaseOpenCodeEvent {
	type: "session.updated";
	properties: {
		sessionID?: string;
		id?: string;
		parentID?: string;
		title?: string;
		[key: string]: unknown;
	};
}

export function isSessionUpdatedEvent(
	event: unknown,
): event is SessionUpdatedEvent {
	return hasProps(event) && event.type === "session.updated";
}

// ─── Session lifecycle (created/renamed/deleted/moved/active) ────────────────
// These fire when the OpenCode TUI (or another client) mutates the session
// list. Conduit refreshes its browser session list in response (see
// sse-wiring.ts); the translator intentionally emits no relay message for them.

export interface SessionCreatedEvent extends BaseOpenCodeEvent {
	type: "session.created";
	properties: {
		sessionID?: string;
		parentID?: string;
		projectID?: string;
		location?: unknown;
		subpath?: string;
		slug?: string;
		title?: string;
		agent?: string;
		[key: string]: unknown;
	};
}

export interface SessionRenamedEvent extends BaseOpenCodeEvent {
	type: "session.renamed";
	properties: {
		sessionID?: string;
		title?: string;
		[key: string]: unknown;
	};
}

export interface SessionDeletedEvent extends BaseOpenCodeEvent {
	type: "session.deleted";
	properties: {
		sessionID?: string;
		[key: string]: unknown;
	};
}

export interface SessionMovedEvent extends BaseOpenCodeEvent {
	type: "session.moved";
	properties: {
		sessionID?: string;
		location?: unknown;
		projectID?: string;
		subpath?: string;
		[key: string]: unknown;
	};
}

export interface SessionActiveEvent extends BaseOpenCodeEvent {
	type: "session.active";
	properties: {
		sessionID?: string;
		[key: string]: unknown;
	};
}

export function isSessionCreatedEvent(
	event: unknown,
): event is SessionCreatedEvent {
	return hasProps(event) && event.type === "session.created";
}

export function isSessionRenamedEvent(
	event: unknown,
): event is SessionRenamedEvent {
	return hasProps(event) && event.type === "session.renamed";
}

export function isSessionDeletedEvent(
	event: unknown,
): event is SessionDeletedEvent {
	return hasProps(event) && event.type === "session.deleted";
}

export function isSessionMovedEvent(
	event: unknown,
): event is SessionMovedEvent {
	return hasProps(event) && event.type === "session.moved";
}

export function isSessionActiveEvent(
	event: unknown,
): event is SessionActiveEvent {
	return hasProps(event) && event.type === "session.active";
}

// ─── Permission ──────────────────────────────────────────────────────────────

export interface PermissionAskedEvent extends BaseOpenCodeEvent {
	type: "permission.asked";
	properties: {
		id: string;
		sessionID?: string;
		action?: string;
		resources?: string[];
		save?: string[];
		metadata?: Record<string, unknown>;
		source?: unknown;
		message?: string;
		[key: string]: unknown;
	};
}

export interface PermissionRepliedEvent extends BaseOpenCodeEvent {
	type: "permission.replied";
	properties: {
		requestID: string;
		sessionID?: string;
		[key: string]: unknown;
	};
}

export function isPermissionAskedEvent(
	event: unknown,
): event is PermissionAskedEvent {
	if (!hasProps(event) || event.type !== "permission.asked") return false;
	return typeof event.properties["id"] === "string";
}

export function isPermissionRepliedEvent(
	event: unknown,
): event is PermissionRepliedEvent {
	if (!hasProps(event) || event.type !== "permission.replied") return false;
	return typeof event.properties["requestID"] === "string";
}

// ─── Forms (v2 questions) ────────────────────────────────────────────────────

export interface FormCreatedEvent extends BaseOpenCodeEvent {
	type: "form.created";
	properties: { form: FormInfo; [key: string]: unknown };
}

export interface FormRepliedEvent extends BaseOpenCodeEvent {
	type: "form.replied";
	properties: { id: string; [key: string]: unknown };
}

export interface FormCancelledEvent extends BaseOpenCodeEvent {
	type: "form.cancelled";
	properties: { id: string; [key: string]: unknown };
}

export function isFormCreatedEvent(event: unknown): event is FormCreatedEvent {
	if (!hasProps(event) || event.type !== "form.created") return false;
	const form = event.properties["form"];
	return typeof form === "object" && form !== null;
}

export function isFormRepliedEvent(event: unknown): event is FormRepliedEvent {
	if (!hasProps(event) || event.type !== "form.replied") return false;
	return typeof event.properties["id"] === "string";
}

export function isFormCancelledEvent(
	event: unknown,
): event is FormCancelledEvent {
	if (!hasProps(event) || event.type !== "form.cancelled") return false;
	return typeof event.properties["id"] === "string";
}

// ─── PTY ─────────────────────────────────────────────────────────────────────

export interface PtyCreatedEvent extends BaseOpenCodeEvent {
	type: "pty.created";
	properties: { info: PtyInfoData; [key: string]: unknown };
}

export interface PtyUpdatedEvent extends BaseOpenCodeEvent {
	type: "pty.updated";
	properties: { info?: PtyInfoData; id?: string; [key: string]: unknown };
}

export interface PtyExitedEvent extends BaseOpenCodeEvent {
	type: "pty.exited";
	properties: { id?: string; exitCode?: number; [key: string]: unknown };
}

export interface PtyDeletedEvent extends BaseOpenCodeEvent {
	type: "pty.deleted";
	properties: { id?: string; [key: string]: unknown };
}

export type PtyEvent =
	| PtyCreatedEvent
	| PtyUpdatedEvent
	| PtyExitedEvent
	| PtyDeletedEvent;

export function isPtyEvent(event: unknown): event is PtyEvent {
	if (!hasProps(event)) return false;
	return event.type.startsWith("pty.");
}

export function isPtyCreatedEvent(event: unknown): event is PtyCreatedEvent {
	return hasProps(event) && event.type === "pty.created";
}

export function isPtyExitedEvent(event: unknown): event is PtyExitedEvent {
	return hasProps(event) && event.type === "pty.exited";
}

export function isPtyDeletedEvent(event: unknown): event is PtyDeletedEvent {
	return hasProps(event) && event.type === "pty.deleted";
}

// ─── Filesystem ──────────────────────────────────────────────────────────────

export interface FileChangedEvent extends BaseOpenCodeEvent {
	type: "filesystem.changed";
	properties: { file?: string; [key: string]: unknown };
}

export function isFileChangedEvent(event: unknown): event is FileChangedEvent {
	return hasProps(event) && event.type === "filesystem.changed";
}

// ─── Installation ────────────────────────────────────────────────────────────

export interface InstallationUpdateEvent extends BaseOpenCodeEvent {
	type: "installation.update-available";
	properties: { version?: string; [key: string]: unknown };
}

export function isInstallationUpdateEvent(
	event: unknown,
): event is InstallationUpdateEvent {
	return hasProps(event) && event.type === "installation.update-available";
}

// ─── Todo ────────────────────────────────────────────────────────────────────

export interface TodoUpdatedEvent extends BaseOpenCodeEvent {
	type: "todo.updated";
	properties: {
		sessionID?: string;
		todos?: Array<{
			content?: string;
			status?: string;
			priority?: string;
			[key: string]: unknown;
		}>;
		[key: string]: unknown;
	};
}

export function isTodoUpdatedEvent(event: unknown): event is TodoUpdatedEvent {
	return hasProps(event) && event.type === "todo.updated";
}

// ─── Ignored catalog-refresh events ──────────────────────────────────────────

export type CatalogRefreshEventType =
	| "provider.updated"
	| "model.updated"
	| "integration.updated"
	| "credential.switched"
	| "agent.updated"
	| "command.updated"
	| "skill.updated"
	| "reference.updated";

export interface CatalogRefreshEvent extends BaseOpenCodeEvent {
	type: CatalogRefreshEventType;
	properties: Record<string, unknown>;
}

// ─── Session ID extraction helpers ───────────────────────────────────────────

/** Check if event properties has a top-level sessionID string */
export function hasSessionID(
	props: Record<string, unknown>,
): props is { sessionID: string } & Record<string, unknown> {
	return typeof props["sessionID"] === "string" && props["sessionID"] !== "";
}

/** Extract the sessionID from an event's top-level properties. */
export function extractSessionId(event: {
	properties: Record<string, unknown>;
}): string | undefined {
	if (hasSessionID(event.properties)) return event.properties.sessionID;
	return undefined;
}

// ─── Composed Event Union ────────────────────────────────────────────────────
// Every typed v2 event in a single union so downstream can narrow on `.type`.

export type KnownOpenCodeEvent =
	| ServerConnectedEvent
	| SessionExecutionStartedEvent
	| SessionExecutionSucceededEvent
	| SessionExecutionFailedEvent
	| SessionExecutionInterruptedEvent
	| SessionStepStartedEvent
	| SessionStepEndedEvent
	| SessionStepFailedEvent
	| SessionTextStartedEvent
	| SessionTextDeltaEvent
	| SessionTextEndedEvent
	| SessionReasoningStartedEvent
	| SessionReasoningDeltaEvent
	| SessionReasoningEndedEvent
	| SessionToolInputStartedEvent
	| SessionToolInputDeltaEvent
	| SessionToolInputEndedEvent
	| SessionToolCalledEvent
	| SessionToolProgressEvent
	| SessionToolSuccessEvent
	| SessionToolFailedEvent
	| SessionSkillActivatedEvent
	| SessionCompactionStartedEvent
	| SessionCompactionDeltaEvent
	| SessionCompactionEndedEvent
	| SessionCompactionFailedEvent
	| SessionShellStartedEvent
	| SessionShellEndedEvent
	| SessionIdleEvent
	| SessionErrorEvent
	| SessionUpdatedEvent
	| SessionCreatedEvent
	| SessionRenamedEvent
	| SessionDeletedEvent
	| SessionMovedEvent
	| SessionActiveEvent
	| PermissionAskedEvent
	| PermissionRepliedEvent
	| FormCreatedEvent
	| FormRepliedEvent
	| FormCancelledEvent
	| PtyCreatedEvent
	| PtyUpdatedEvent
	| PtyExitedEvent
	| PtyDeletedEvent
	| FileChangedEvent
	| InstallationUpdateEvent
	| TodoUpdatedEvent
	| CatalogRefreshEvent;

export type KnownOpenCodeEventType = KnownOpenCodeEvent["type"];
