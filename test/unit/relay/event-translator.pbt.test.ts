// ─── Property-Based Tests: v2 Event Translator ──────────────────────────────
//
// Properties tested:
// P1: mapToolName is idempotent for known tools and identity for unknown
// P2: All known tools map to PascalCase
// P3: translateTextDelta never throws, returns delta or null
// P4: Tool lifecycle: input.started→tool_start, called/progress→tool_executing,
//     success→tool_result(ok), failed→tool_result(err)
// P5: Reasoning lifecycle: started→thinking_start, delta→thinking_delta,
//     ended→thinking_stop
// P6: Unknown event types produce ok:false (never throw)
// P7: session.idle mapping: succeeded→done, failed/interrupted→error
// P8: Permission event translation preserves all field mappings
// P9: form.created maps fields (multiselect → multiSelect)
// P10: Stateful translator tracks tool ids; reset/rebuild behave
// P11: step.ended only emits result with non-negative usage
// P13: translatePtyEvent handles pty.created/exited/deleted/unknown
// P14: translateFileChanged handles filesystem.changed
// P16: seenParts FIFO eviction

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	createTranslator,
	mapToolName,
	translateExecutionFailed,
	translateFileChanged,
	translateIdle,
	translatePermission,
	translatePtyEvent,
	translateReasoningDelta,
	translateReasoningEnded,
	translateReasoningStarted,
	translateStepEnded,
	translateTextDelta,
	translateToolCalled,
	translateToolFailed,
	translateToolInputStarted,
	translateToolProgress,
	translateToolSuccess,
} from "../../../src/lib/relay/event-translator.js";
import type {
	OpenCodeEvent,
	PartType,
	RelayMessage,
} from "../../../src/lib/types.js";
import {
	anyToolName,
	edgeCaseString,
	idString,
	knownToolName,
	unknownToolName,
} from "../../helpers/arbitraries.js";

const SEED = 42;
const NUM_RUNS = 200;

// ─── Shared generators ──────────────────────────────────────────────────────

const unknownEvent = fc
	.record({
		type: fc.oneof(
			{ weight: 3, arbitrary: fc.string({ minLength: 1, maxLength: 30 }) },
			{ weight: 1, arbitrary: fc.constant("some.random.event") },
			{ weight: 1, arbitrary: fc.constant("") },
		),
		properties: fc.dictionary(
			fc.string({ minLength: 1, maxLength: 10 }),
			fc.jsonValue(),
		),
	})
	.filter(
		(e) =>
			!e.type.startsWith("session.") &&
			!e.type.startsWith("permission.") &&
			!e.type.startsWith("form.") &&
			!e.type.startsWith("pty.") &&
			!e.type.startsWith("filesystem.") &&
			!e.type.startsWith("installation.") &&
			!e.type.startsWith("todo.") &&
			!e.type.startsWith("server.") &&
			e.type !== "some.random.event" &&
			e.type !== "",
	) as fc.Arbitrary<OpenCodeEvent>;

describe("v2 Event Translator PBT", () => {
	// ─── P1/P2: mapToolName ────────────────────────────────────────────────

	describe("P1/P2: mapToolName (AC3)", () => {
		const TOOL_MAP: Record<string, string> = {
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

		it("known tools map to PascalCase", () => {
			fc.assert(
				fc.property(knownToolName, (name) => {
					expect(mapToolName(name)).toBe(TOOL_MAP[name]);
					const mapped = mapToolName(name);
					// biome-ignore lint/style/noNonNullAssertion: guarded by length check
					expect(mapped[0]).toBe(mapped[0]!.toUpperCase());
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("unknown tools pass through unchanged", () => {
			fc.assert(
				fc.property(unknownToolName, (name) => {
					expect(mapToolName(name)).toBe(name);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P3: text delta ────────────────────────────────────────────────────

	describe("P3: translateTextDelta (AC1, AC6)", () => {
		it("valid delta → delta message", () => {
			fc.assert(
				fc.property(edgeCaseString, edgeCaseString, (delta, messageId) => {
					const event: OpenCodeEvent = {
						type: "session.text.delta",
						properties: { delta, assistantMessageID: messageId },
					};
					const result = translateTextDelta(event);
					expect(result).toEqual({
						type: "delta",
						text: delta,
						messageId,
					});
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("wrong event type → null", () => {
			const event: OpenCodeEvent = {
				type: "session.reasoning.delta",
				properties: { delta: "x" },
			};
			expect(translateTextDelta(event)).toBeNull();
		});
	});

	// ─── P4: tool lifecycle ────────────────────────────────────────────────

	describe("P4: Tool lifecycle (AC2)", () => {
		it("input.started → tool_start with mapped name", () => {
			fc.assert(
				fc.property(idString, anyToolName, (id, tool) => {
					const result = translateToolInputStarted({
						type: "session.tool.input.started",
						properties: { id, name: tool },
					});
					expect(result?.type).toBe("tool_start");
					if (result?.type === "tool_start") {
						expect(result.id).toBe(id);
						expect(result.name).toBe(mapToolName(tool));
					}
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("called → tool_executing", () => {
			const result = translateToolCalled({
				type: "session.tool.called",
				properties: { id: "t1", name: "bash", input: { cmd: "ls" } },
			});
			expect(result?.type).toBe("tool_executing");
			if (result?.type === "tool_executing") {
				expect(result.input).toEqual({ cmd: "ls" });
			}
		});

		it("progress → tool_executing forwarding metadata", () => {
			const meta = { sessionId: "ses_abc" };
			const result = translateToolProgress({
				type: "session.tool.progress",
				properties: { id: "t1", name: "task", metadata: meta },
			});
			expect(result?.type).toBe("tool_executing");
			if (result?.type === "tool_executing") {
				expect(result.metadata).toEqual(meta);
			}
		});

		it("success → tool_result is_error=false and flattens content", () => {
			fc.assert(
				fc.property(edgeCaseString, (text) => {
					const result = translateToolSuccess({
						type: "session.tool.success",
						properties: { id: "t1", content: [{ type: "text", text }] },
					});
					expect(result?.type).toBe("tool_result");
					if (result?.type === "tool_result") {
						expect(result.content).toBe(text);
						expect(result.is_error).toBe(false);
					}
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("failed → tool_result is_error=true", () => {
			fc.assert(
				fc.property(
					edgeCaseString.filter((s) => s.length > 0),
					(msg) => {
						const result = translateToolFailed({
							type: "session.tool.failed",
							properties: { id: "t1", error: { message: msg } },
						});
						expect(result?.type).toBe("tool_result");
						if (result?.type === "tool_result") {
							expect(result.is_error).toBe(true);
							expect(result.content).toBe(msg);
						}
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("non-tool events return null from tool translators", () => {
			const nonTool: PartType[] = ["text", "reasoning", "file"];
			void nonTool;
			const event: OpenCodeEvent = {
				type: "session.idle",
				properties: { outcome: "succeeded" },
			};
			expect(translateToolInputStarted(event)).toBeNull();
			expect(translateToolCalled(event)).toBeNull();
			expect(translateToolProgress(event)).toBeNull();
			expect(translateToolSuccess(event)).toBeNull();
			expect(translateToolFailed(event)).toBeNull();
		});
	});

	// ─── P5: reasoning lifecycle ───────────────────────────────────────────

	describe("P5: Reasoning lifecycle (AC6)", () => {
		it("started → thinking_start, delta → thinking_delta, ended → thinking_stop", () => {
			expect(
				translateReasoningStarted({
					type: "session.reasoning.started",
					properties: { assistantMessageID: "m1" },
				}),
			).toEqual({ type: "thinking_start", messageId: "m1" });

			fc.assert(
				fc.property(edgeCaseString, (delta) => {
					expect(
						translateReasoningDelta({
							type: "session.reasoning.delta",
							properties: { delta, assistantMessageID: "m1" },
						}),
					).toEqual({ type: "thinking_delta", text: delta, messageId: "m1" });
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);

			expect(
				translateReasoningEnded({
					type: "session.reasoning.ended",
					properties: { assistantMessageID: "m1" },
				}),
			).toEqual({ type: "thinking_stop", messageId: "m1" });
		});

		it("non-reasoning events return null", () => {
			const event: OpenCodeEvent = {
				type: "session.text.delta",
				properties: { delta: "x" },
			};
			expect(translateReasoningStarted(event)).toBeNull();
			expect(translateReasoningDelta(event)).toBeNull();
			expect(translateReasoningEnded(event)).toBeNull();
		});
	});

	// ─── P6: unknown events ────────────────────────────────────────────────

	describe("P6: Unknown event types produce ok:false (AC13)", () => {
		it("never throws and returns ok:false", () => {
			fc.assert(
				fc.property(unknownEvent, (event) => {
					const translator = createTranslator();
					const result = translator.translate(event);
					expect(result.ok).toBe(false);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P7: idle mapping ──────────────────────────────────────────────────

	describe("P7: session.idle mapping (AC8)", () => {
		it("succeeded → done, interrupted → error, other → error", () => {
			expect(
				translateIdle({
					type: "session.idle",
					properties: { outcome: "succeeded" },
				}),
			).toMatchObject({ type: "done", code: 0 });

			expect(
				translateIdle({
					type: "session.idle",
					properties: { outcome: "interrupted" },
				}),
			).toMatchObject({ type: "error", code: "INTERRUPTED" });

			expect(
				translateIdle({
					type: "session.idle",
					properties: { outcome: "failed" },
				}),
			).toMatchObject({ type: "error", code: "EXECUTION_FAILED" });
		});
	});

	// ─── P8: permission ────────────────────────────────────────────────────

	describe("P8: permission.asked translation preserves fields (AC4)", () => {
		it("maps id/action/resources/save/metadata and sessionID", () => {
			const result = translatePermission({
				type: "permission.asked",
				properties: {
					id: "per_1",
					sessionID: "s1",
					action: "bash",
					resources: ["rm -rf"],
					save: ["rm -rf"],
					metadata: { key: "value" },
				},
			});
			expect(result).toMatchObject({
				type: "permission_request",
				sessionId: "s1",
				requestId: "per_1",
				toolName: "bash",
				toolInput: { patterns: ["rm -rf"], metadata: { key: "value" } },
				always: ["rm -rf"],
				toolUseId: "per_1",
			});
		});

		it("no sessionID (and no context) → null", () => {
			const result = translatePermission({
				type: "permission.asked",
				properties: { id: "per_1", action: "bash" },
			});
			expect(result).toBeNull();
		});

		it("context sessionId is used as fallback", () => {
			const result = translatePermission(
				{
					type: "permission.asked",
					properties: { id: "per_1", action: "bash" },
				},
				"s-context",
			);
			expect(result?.type).toBe("permission_request");
			if (result?.type === "permission_request") {
				expect(result.sessionId).toBe("s-context");
			}
		});
	});

	// ─── P13: pty events ───────────────────────────────────────────────────

	describe("P13: translatePtyEvent", () => {
		it("pty.created returns pty_created with info fields", () => {
			const result = translatePtyEvent({
				type: "pty.created",
				properties: {
					info: {
						id: "pty-1",
						title: "bash",
						command: "/bin/bash",
						cwd: "/home/user",
						status: "running",
						pid: 12345,
					},
				},
			});
			expect(result?.type).toBe("pty_created");
			if (result?.type === "pty_created") {
				expect(result.pty).toEqual({
					id: "pty-1",
					title: "bash",
					command: "/bin/bash",
					cwd: "/home/user",
					status: "running",
					pid: 12345,
				});
			}
		});

		it("pty.exited returns pty_exited (exitCode defaults to 0)", () => {
			expect(
				translatePtyEvent({
					type: "pty.exited",
					properties: { id: "pty-2", exitCode: 1 },
				}),
			).toMatchObject({ type: "pty_exited", ptyId: "pty-2", exitCode: 1 });
			expect(
				translatePtyEvent({
					type: "pty.exited",
					properties: { id: "pty-3" },
				}),
			).toMatchObject({ type: "pty_exited", ptyId: "pty-3", exitCode: 0 });
		});

		it("pty.deleted returns pty_deleted", () => {
			expect(
				translatePtyEvent({
					type: "pty.deleted",
					properties: { id: "pty-4" },
				}),
			).toMatchObject({ type: "pty_deleted", ptyId: "pty-4" });
		});

		it("property: arbitrary pty properties never throw", () => {
			fc.assert(
				fc.property(
					fc.constantFrom(
						"pty.created",
						"pty.exited",
						"pty.deleted",
						"pty.updated",
					),
					fc.dictionary(
						fc.string({ minLength: 1, maxLength: 10 }),
						fc.jsonValue(),
					),
					(eventType, props) => {
						const result = translatePtyEvent({
							type: eventType,
							properties: props,
						});
						if (result !== null) {
							expect(["pty_created", "pty_exited", "pty_deleted"]).toContain(
								result.type,
							);
						}
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P14: filesystem.changed ───────────────────────────────────────────

	describe("P14: translateFileChanged", () => {
		it("returns file_changed with changeType 'external'", () => {
			const result = translateFileChanged({
				type: "filesystem.changed",
				properties: { file: "/src/main.ts" },
			});
			expect(result).toEqual({
				type: "file_changed",
				path: "/src/main.ts",
				changeType: "external",
			});
		});

		it("missing file → null", () => {
			expect(
				translateFileChanged({ type: "filesystem.changed", properties: {} }),
			).toBeNull();
		});
	});

	// ─── P11: step.ended → result ──────────────────────────────────────────

	describe("P11: step.ended produces result with non-negative usage", () => {
		it("property: usage values are non-negative", () => {
			fc.assert(
				fc.property(
					fc.nat({ max: 100_000 }),
					fc.nat({ max: 100_000 }),
					(input, output) => {
						const result = translateStepEnded({
							type: "session.step.ended",
							properties: {
								sessionID: "s1",
								tokens: { input, output, cache: { read: 0, write: 0 } },
								cost: 0,
							},
						});
						expect(result?.type).toBe("result");
						if (result?.type === "result") {
							expect(result.usage.input).toBeGreaterThanOrEqual(0);
							expect(result.usage.output).toBeGreaterThanOrEqual(0);
						}
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("execution.failed → error EXECUTION_FAILED", () => {
			expect(
				translateExecutionFailed({
					type: "session.execution.failed",
					properties: { error: { message: "boom" } },
				}),
			).toMatchObject({
				type: "error",
				code: "EXECUTION_FAILED",
				message: "boom",
			});
		});
	});

	// ─── P10: stateful tracking ────────────────────────────────────────────

	describe("P10: Stateful translator tracks tool parts (AC14, AC15)", () => {
		it("same tool id seen twice does not duplicate tracking", () => {
			const translator = createTranslator();
			translator.translate({
				type: "session.tool.input.started",
				properties: { id: "t1", name: "read" },
			});
			expect(translator.getSeenParts()?.has("t1")).toBe(true);
			translator.translate({
				type: "session.tool.called",
				properties: { id: "t1", name: "read" },
			});
			expect(translator.getSeenParts()?.size).toBe(1);
		});

		it("reset clears tracking", () => {
			const translator = createTranslator();
			translator.translate({
				type: "session.tool.input.started",
				properties: { id: "t1", name: "read" },
			});
			translator.reset();
			expect(translator.getSeenParts()?.size ?? 0).toBe(0);
		});

		it("rebuildStateFromHistory marks all parts as seen per session", () => {
			fc.assert(
				fc.property(
					fc.array(
						fc.record({
							parts: fc.array(
								fc.record({
									id: idString.filter((s) => s.length > 0),
									type: fc.constantFrom(
										"tool" as PartType,
										"reasoning" as PartType,
										"text" as PartType,
									),
								}),
								{ minLength: 0, maxLength: 5 },
							),
						}),
						{ minLength: 0, maxLength: 5 },
					),
					(messages) => {
						const translator = createTranslator();
						translator.rebuildStateFromHistory("test-session", messages);
						const uniquePartIDs = new Set(
							messages.flatMap((m) => (m.parts ?? []).map((p) => p.id)),
						);
						expect(translator.getSeenParts("test-session")?.size ?? 0).toBe(
							uniquePartIDs.size,
						);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P16: FIFO eviction ────────────────────────────────────────────────

	describe("P16: seenParts FIFO eviction", () => {
		it("evicts oldest entries when exceeding the cap", () => {
			const translator = createTranslator();
			const seenParts = translator.getSeenParts() as Map<
				string,
				{ type: string }
			>;
			void seenParts;
			// Trigger creation of the default session map
			translator.translate({
				type: "session.text.started",
				properties: { assistantMessageID: "m", ordinal: 0 },
			});
			const parts = translator.getSeenParts() as Map<string, { type: string }>;
			parts.clear();
			for (let i = 0; i < 10_000; i++) {
				parts.set(`part-${i}`, { type: "tool" });
			}
			translator.translate({
				type: "session.tool.input.started",
				properties: { id: "part-10000", name: "read" },
			});
			expect(parts.size).toBeLessThanOrEqual(8_001);
			expect(parts.has("part-10000")).toBe(true);
			expect(parts.has("part-0")).toBe(false);
		});

		it("does not evict under the cap", () => {
			const translator = createTranslator();
			translator.translate({
				type: "session.text.started",
				properties: { assistantMessageID: "m", ordinal: 0 },
			});
			const parts = translator.getSeenParts() as Map<string, { type: string }>;
			parts.clear();
			for (let i = 0; i < 100; i++) parts.set(`part-${i}`, { type: "tool" });
			translator.translate({
				type: "session.tool.input.started",
				properties: { id: "part-100", name: "read" },
			});
			expect(parts.size).toBe(101);
			expect(parts.has("part-0")).toBe(true);
		});
	});

	// ─── Per-session scoping ───────────────────────────────────────────────

	describe("Per-session scoping", () => {
		it("reset(sessionId) only clears that session", () => {
			const translator = createTranslator();
			translator.translate(
				{
					type: "session.tool.input.started",
					properties: { id: "a", name: "read" },
				},
				{ sessionId: "ses-A" },
			);
			translator.translate(
				{
					type: "session.tool.input.started",
					properties: { id: "b", name: "read" },
				},
				{ sessionId: "ses-B" },
			);
			translator.reset("ses-A");
			expect(translator.getSeenParts("ses-B")?.has("b")).toBe(true);
			expect(translator.getSeenParts("ses-A")?.size ?? 0).toBe(0);
		});
	});

	// ─── RelayMessage type sanity ──────────────────────────────────────────

	it("relay messages produced are valid RelayMessage shapes", () => {
		const msgs: (RelayMessage | null)[] = [
			translateTextDelta({
				type: "session.text.delta",
				properties: { delta: "x" },
			}),
			translateIdle({
				type: "session.idle",
				properties: { outcome: "succeeded" },
			}),
		];
		for (const m of msgs) {
			if (m) expect(typeof m.type).toBe("string");
		}
	});
});
