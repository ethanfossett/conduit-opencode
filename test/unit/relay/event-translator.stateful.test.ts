// ─── State-Machine Model Test: v2 Event Translator ──────────────────────────
//
// Exercises the stateful translator's part tracking under arbitrary
// interleavings of v2 tool / reasoning lifecycle events, reset, and
// rebuild-from-history. Invariants verified after each command:
//   - seenParts size matches the model
//   - No duplicate lifecycle events (tool_start/thinking_start)

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createTranslator } from "../../../src/lib/relay/event-translator.js";
import type {
	OpenCodeEvent,
	PartType,
	ToolStatus,
} from "../../../src/lib/types.js";

const SEED = 42;
const NUM_RUNS = 100;

interface PartInfo {
	type: PartType;
	status?: ToolStatus;
}

interface ModelState {
	seenParts: Map<string, PartInfo>;
}

interface RealState {
	translator: ReturnType<typeof createTranslator>;
}

function assertSize(model: ModelState, real: RealState): void {
	const realSize = real.translator.getSeenParts()?.size ?? 0;
	if (realSize !== model.seenParts.size) {
		throw new Error(
			`seenParts size mismatch: model=${model.seenParts.size}, real=${realSize}`,
		);
	}
}

class StartToolCommand implements fc.Command<ModelState, RealState> {
	constructor(
		readonly id: string,
		readonly tool: string,
	) {}

	check(model: Readonly<ModelState>): boolean {
		return !model.seenParts.has(this.id) && this.id.length > 0;
	}

	run(model: ModelState, real: RealState): void {
		const event: OpenCodeEvent = {
			type: "session.tool.input.started",
			properties: { id: this.id, name: this.tool },
		};
		const result = real.translator.translate(event);
		model.seenParts.set(this.id, { type: "tool", status: "pending" });
		if (result.ok && result.messages.length === 1) {
			// biome-ignore lint/style/noNonNullAssertion: length-checked
			expect(result.messages[0]!.type).toBe("tool_start");
		}
		assertSize(model, real);
	}

	toString(): string {
		return `StartTool(${this.id})`;
	}
}

class UpdateToolCommand implements fc.Command<ModelState, RealState> {
	constructor(
		readonly id: string,
		readonly status: ToolStatus,
	) {}

	check(model: Readonly<ModelState>): boolean {
		const part = model.seenParts.get(this.id);
		return (
			part !== undefined && part.type === "tool" && this.status !== "pending"
		);
	}

	run(model: ModelState, real: RealState): void {
		const typeByStatus: Record<string, string> = {
			running: "session.tool.called",
			completed: "session.tool.success",
			error: "session.tool.failed",
		};
		const event: OpenCodeEvent = {
			type: typeByStatus[this.status] as string,
			properties: { id: this.id, name: "read" },
		};
		const result = real.translator.translate(event);
		model.seenParts.set(this.id, { type: "tool", status: this.status });

		if (result.ok && result.messages.length === 1) {
			// biome-ignore lint/style/noNonNullAssertion: length-checked
			const msg = result.messages[0]!;
			if (msg.type === "tool_start") {
				throw new Error(`Duplicate tool_start for ${this.id}`);
			}
			if (this.status === "running" && msg.type !== "tool_executing") {
				throw new Error(`Expected tool_executing, got ${msg.type}`);
			}
			if (
				(this.status === "completed" || this.status === "error") &&
				msg.type !== "tool_result"
			) {
				throw new Error(`Expected tool_result, got ${msg.type}`);
			}
		}
		assertSize(model, real);
	}

	toString(): string {
		return `UpdateTool(${this.id}, ${this.status})`;
	}
}

class StartReasoningCommand implements fc.Command<ModelState, RealState> {
	constructor(
		readonly messageId: string,
		readonly ordinal: number,
	) {}

	check(model: Readonly<ModelState>): boolean {
		return !model.seenParts.has(`${this.messageId}:${this.ordinal}`);
	}

	run(model: ModelState, real: RealState): void {
		const event: OpenCodeEvent = {
			type: "session.reasoning.started",
			properties: {
				assistantMessageID: this.messageId,
				ordinal: this.ordinal,
			},
		};
		const result = real.translator.translate(event);
		model.seenParts.set(`${this.messageId}:${this.ordinal}`, {
			type: "reasoning",
		});
		if (result.ok && result.messages.length === 1) {
			// biome-ignore lint/style/noNonNullAssertion: length-checked
			expect(result.messages[0]!.type).toBe("thinking_start");
		}
		assertSize(model, real);
	}

	toString(): string {
		return `StartReasoning(${this.messageId}:${this.ordinal})`;
	}
}

class ResetCommand implements fc.Command<ModelState, RealState> {
	check(_model: Readonly<ModelState>): boolean {
		return true;
	}

	run(model: ModelState, real: RealState): void {
		model.seenParts.clear();
		real.translator.reset();
		if ((real.translator.getSeenParts()?.size ?? 0) !== 0) {
			throw new Error("seenParts not empty after reset");
		}
	}

	toString(): string {
		return "Reset()";
	}
}

class RebuildFromHistoryCommand implements fc.Command<ModelState, RealState> {
	constructor(
		readonly parts: Array<{ id: string; type: PartType; status?: ToolStatus }>,
	) {}

	check(_model: Readonly<ModelState>): boolean {
		return true;
	}

	run(model: ModelState, real: RealState): void {
		model.seenParts.clear();
		for (const p of this.parts) {
			if (p.id.length > 0) {
				model.seenParts.set(p.id, {
					type: p.type,
					...(p.status != null && { status: p.status }),
				});
			}
		}
		real.translator.rebuildStateFromHistory("__default__", [
			{
				parts: this.parts
					.filter((p) => p.id.length > 0)
					.map((p) => ({
						id: p.id,
						type: p.type,
						...(p.status != null && { state: { status: p.status } }),
					})),
			},
		]);
		assertSize(model, real);
	}

	toString(): string {
		return `RebuildFromHistory(${this.parts.length} parts)`;
	}
}

// ─── Arbitraries ────────────────────────────────────────────────────────────

const arbPartID = fc.oneof(
	{ weight: 5, arbitrary: fc.uuid() },
	{ weight: 3, arbitrary: fc.stringMatching(/^p[0-9]{1,6}$/) },
);

const arbTool = fc.constantFrom(
	"bash",
	"read",
	"edit",
	"write",
	"glob",
	"grep",
);

const arbToolStatus: fc.Arbitrary<ToolStatus> = fc.constantFrom(
	"pending",
	"running",
	"completed",
	"error",
);

const allCommands = fc.commands(
	[
		fc
			.tuple(arbPartID, arbTool)
			.map(([id, tool]) => new StartToolCommand(id, tool)),
		fc
			.tuple(arbPartID, arbToolStatus)
			.map(([id, status]) => new UpdateToolCommand(id, status)),
		fc
			.tuple(arbPartID, fc.nat({ max: 5 }))
			.map(([mid, ord]) => new StartReasoningCommand(mid, ord)),
		fc.constant(new ResetCommand()),
		fc
			.array(
				fc
					.record({
						id: arbPartID,
						type: fc.constantFrom(
							"tool" as PartType,
							"reasoning" as PartType,
							"text" as PartType,
						),
						status: fc.oneof(fc.constant(undefined), arbToolStatus),
					})
					.map(({ id, type, status }) => ({
						id,
						type,
						...(status != null && { status }),
					})),
				{ minLength: 0, maxLength: 8 },
			)
			.map((parts) => new RebuildFromHistoryCommand(parts)),
	],
	{ maxCommands: 40 },
);

describe("v2 Event Translator State Machine PBT", () => {
	it("arbitrary command sequences maintain model/real seenParts consistency", () => {
		fc.assert(
			fc.property(allCommands, (cmds) => {
				const model: ModelState = { seenParts: new Map() };
				const real: RealState = { translator: createTranslator() };
				fc.modelRun(() => ({ model, real }), cmds);
			}),
			{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
		);
	});
});
