// ─── Type Guard Tests (v2) ───────────────────────────────────────────────────
// Verifies that the v2 OpenCode SSE event guards narrow correctly.

import { describe, expect, it } from "vitest";
import {
	extractSessionId,
	hasSessionID,
	isFileChangedEvent,
	isFormCancelledEvent,
	isFormCreatedEvent,
	isFormRepliedEvent,
	isInstallationUpdateEvent,
	isPermissionAskedEvent,
	isPermissionRepliedEvent,
	isPtyCreatedEvent,
	isPtyDeletedEvent,
	isPtyEvent,
	isPtyExitedEvent,
	isServerConnectedEvent,
	isSessionCompactionEvent,
	isSessionErrorEvent,
	isSessionExecutionFailedEvent,
	isSessionExecutionInterruptedEvent,
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
	isSessionUpdatedEvent,
	isTodoUpdatedEvent,
} from "../../../src/lib/relay/opencode-events.js";

// ─── Table-driven positive/negative checks ───────────────────────────────────

type Guard = (event: unknown) => boolean;
const guardCase = (
	name: string,
	guard: Guard,
	valid: Record<string, unknown>,
	extraInvalid: Record<string, unknown>[] = [],
) => {
	describe(name, () => {
		it("returns true for a valid event", () => {
			expect(guard(valid)).toBe(true);
		});
		it("returns false for a wrong event type", () => {
			expect(guard({ type: "some.other.event", properties: {} })).toBe(false);
		});
		it("returns false for a non-object", () => {
			expect(guard(null)).toBe(false);
			expect(guard("string")).toBe(false);
			expect(guard(42)).toBe(false);
		});
		it("returns false for missing properties", () => {
			expect(guard({ type: (valid as { type: string }).type })).toBe(false);
		});
		for (const [i, invalid] of extraInvalid.entries()) {
			it(`returns false for invalid variant #${i}`, () => {
				expect(guard(invalid)).toBe(false);
			});
		}
	});
};

guardCase("isServerConnectedEvent", isServerConnectedEvent, {
	type: "server.connected",
	properties: {},
});

guardCase(
	"isSessionExecutionFailedEvent",
	isSessionExecutionFailedEvent,
	{ type: "session.execution.failed", properties: { error: { message: "x" } } },
	[{ type: "session.execution.failed", properties: { error: null } }],
);

guardCase(
	"isSessionExecutionInterruptedEvent",
	isSessionExecutionInterruptedEvent,
	{ type: "session.execution.interrupted", properties: { reason: "stop" } },
);

guardCase("isSessionStepEndedEvent", isSessionStepEndedEvent, {
	type: "session.step.ended",
	properties: { sessionID: "s1", tokens: { input: 1 } },
});

guardCase("isSessionIdleEvent", isSessionIdleEvent, {
	type: "session.idle",
	properties: { sessionID: "s1", outcome: "succeeded" },
});

guardCase("isSessionErrorEvent", isSessionErrorEvent, {
	type: "session.error",
	properties: { error: { message: "boom" } },
});

guardCase("isSessionUpdatedEvent", isSessionUpdatedEvent, {
	type: "session.updated",
	properties: { sessionID: "s1" },
});

guardCase(
	"isSessionTextDeltaEvent",
	isSessionTextDeltaEvent,
	{ type: "session.text.delta", properties: { delta: "hi" } },
	[{ type: "session.text.delta", properties: { delta: 42 } }],
);

guardCase("isSessionTextEndedEvent", isSessionTextEndedEvent, {
	type: "session.text.ended",
	properties: { text: "done" },
});

guardCase("isSessionReasoningStartedEvent", isSessionReasoningStartedEvent, {
	type: "session.reasoning.started",
	properties: { ordinal: 0 },
});

guardCase(
	"isSessionReasoningDeltaEvent",
	isSessionReasoningDeltaEvent,
	{ type: "session.reasoning.delta", properties: { delta: "think" } },
	[{ type: "session.reasoning.delta", properties: {} }],
);

guardCase("isSessionReasoningEndedEvent", isSessionReasoningEndedEvent, {
	type: "session.reasoning.ended",
	properties: { text: "done" },
});

guardCase(
	"isSessionToolInputStartedEvent",
	isSessionToolInputStartedEvent,
	{
		type: "session.tool.input.started",
		properties: { id: "t1", name: "bash" },
	},
	[{ type: "session.tool.input.started", properties: {} }],
);

guardCase(
	"isSessionToolCalledEvent",
	isSessionToolCalledEvent,
	{ type: "session.tool.called", properties: { id: "t1", input: {} } },
	[{ type: "session.tool.called", properties: {} }],
);

guardCase(
	"isSessionToolProgressEvent",
	isSessionToolProgressEvent,
	{ type: "session.tool.progress", properties: { id: "t1" } },
	[{ type: "session.tool.progress", properties: {} }],
);

guardCase(
	"isSessionToolSuccessEvent",
	isSessionToolSuccessEvent,
	{ type: "session.tool.success", properties: { id: "t1" } },
	[{ type: "session.tool.success", properties: {} }],
);

guardCase(
	"isSessionToolFailedEvent",
	isSessionToolFailedEvent,
	{ type: "session.tool.failed", properties: { id: "t1" } },
	[{ type: "session.tool.failed", properties: {} }],
);

guardCase("isPermissionAskedEvent", isPermissionAskedEvent, {
	type: "permission.asked",
	properties: { id: "per_1", action: "bash", resources: ["*"] },
});

guardCase(
	"isPermissionRepliedEvent",
	isPermissionRepliedEvent,
	{ type: "permission.replied", properties: { requestID: "per_1" } },
	[{ type: "permission.replied", properties: {} }],
);

guardCase(
	"isFormCreatedEvent",
	isFormCreatedEvent,
	{ type: "form.created", properties: { form: { id: "frm_1", fields: {} } } },
	[{ type: "form.created", properties: {} }],
);

guardCase(
	"isFormRepliedEvent",
	isFormRepliedEvent,
	{ type: "form.replied", properties: { id: "frm_1" } },
	[{ type: "form.replied", properties: {} }],
);

guardCase(
	"isFormCancelledEvent",
	isFormCancelledEvent,
	{ type: "form.cancelled", properties: { id: "frm_1" } },
	[{ type: "form.cancelled", properties: {} }],
);

guardCase("isPtyCreatedEvent", isPtyCreatedEvent, {
	type: "pty.created",
	properties: { info: { id: "pty1" } },
});

guardCase("isPtyExitedEvent", isPtyExitedEvent, {
	type: "pty.exited",
	properties: { id: "pty1", exitCode: 0 },
});

guardCase("isPtyDeletedEvent", isPtyDeletedEvent, {
	type: "pty.deleted",
	properties: { id: "pty1" },
});

guardCase("isFileChangedEvent", isFileChangedEvent, {
	type: "filesystem.changed",
	properties: { file: "/a.ts" },
});

guardCase("isInstallationUpdateEvent", isInstallationUpdateEvent, {
	type: "installation.update-available",
	properties: { version: "2.0.0" },
});

guardCase("isTodoUpdatedEvent", isTodoUpdatedEvent, {
	type: "todo.updated",
	properties: { todos: [] },
});

// ─── Composite guards ────────────────────────────────────────────────────────

describe("isPtyEvent", () => {
	it("accepts pty.* event types", () => {
		expect(isPtyEvent({ type: "pty.created", properties: {} })).toBe(true);
		expect(isPtyEvent({ type: "pty.exited", properties: {} })).toBe(true);
		expect(isPtyEvent({ type: "pty.deleted", properties: {} })).toBe(true);
		expect(isPtyEvent({ type: "pty.updated", properties: {} })).toBe(true);
	});
	it("rejects non-pty events", () => {
		expect(isPtyEvent({ type: "session.idle", properties: {} })).toBe(false);
		expect(isPtyEvent(null)).toBe(false);
	});
});

describe("isSessionCompactionEvent", () => {
	it("accepts all compaction sub-types", () => {
		for (const type of [
			"session.compaction.started",
			"session.compaction.delta",
			"session.compaction.ended",
			"session.compaction.failed",
		]) {
			expect(isSessionCompactionEvent({ type, properties: {} })).toBe(true);
		}
	});
	it("rejects non-compaction events", () => {
		expect(
			isSessionCompactionEvent({ type: "session.idle", properties: {} }),
		).toBe(false);
	});
});

// ─── Session ID helpers ──────────────────────────────────────────────────────

describe("hasSessionID", () => {
	it("returns true when sessionID is present", () => {
		expect(hasSessionID({ sessionID: "s1" })).toBe(true);
	});
	it("returns false when sessionID is empty or missing", () => {
		expect(hasSessionID({ sessionID: "" })).toBe(false);
		expect(hasSessionID({})).toBe(false);
		expect(hasSessionID({ sessionID: 42 })).toBe(false);
	});
});

describe("extractSessionId", () => {
	it("extracts a top-level sessionID", () => {
		expect(extractSessionId({ properties: { sessionID: "s1" } })).toBe("s1");
	});
	it("returns undefined when absent", () => {
		expect(extractSessionId({ properties: {} })).toBeUndefined();
	});
});
