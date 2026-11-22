import { describe, expect, it } from "vitest";
import { createTranslator } from "../../../src/lib/relay/event-translator.js";
import type { KnownOpenCodeEventType } from "../../../src/lib/relay/opencode-events.js";

const KNOWN_EVENT_TYPES: KnownOpenCodeEventType[] = [
	"server.connected",
	"session.execution.started",
	"session.execution.succeeded",
	"session.execution.failed",
	"session.execution.interrupted",
	"session.step.started",
	"session.step.ended",
	"session.step.failed",
	"session.text.started",
	"session.text.delta",
	"session.text.ended",
	"session.reasoning.started",
	"session.reasoning.delta",
	"session.reasoning.ended",
	"session.tool.input.started",
	"session.tool.input.delta",
	"session.tool.input.ended",
	"session.tool.called",
	"session.tool.progress",
	"session.tool.success",
	"session.tool.failed",
	"session.skill.activated",
	"session.compaction.started",
	"session.compaction.delta",
	"session.compaction.ended",
	"session.compaction.failed",
	"session.shell.started",
	"session.shell.ended",
	"session.idle",
	"session.error",
	"session.updated",
	"permission.asked",
	"permission.replied",
	"form.created",
	"form.replied",
	"form.cancelled",
	"pty.created",
	"pty.updated",
	"pty.exited",
	"pty.deleted",
	"filesystem.changed",
	"installation.update-available",
	"todo.updated",
	"provider.updated",
	"model.updated",
	"integration.updated",
	"credential.switched",
	"agent.updated",
	"command.updated",
	"skill.updated",
	"reference.updated",
];

describe("Event Type Safety", () => {
	it("translator handles or explicitly skips every known event type", () => {
		const translator = createTranslator();
		for (const eventType of KNOWN_EVENT_TYPES) {
			const result = translator.translate({ type: eventType, properties: {} });
			if (!result.ok) {
				expect(result.reason, `"${eventType}" returned unhandled`).not.toMatch(
					/^unhandled event type/,
				);
			}
		}
	});

	it("unknown event types fall through to catch-all", () => {
		const translator = createTranslator();
		const result = translator.translate({
			type: "future.unknown",
			properties: {},
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("unhandled event type");
	});
});
