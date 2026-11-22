// ─── Metamorphic Tests: v2 Event Translator ─────────────────────────────────
//
// M1: Two fresh translators produce identical results (determinism)
// M2: Independent events for DIFFERENT part ids commute
// M3: Reset followed by same event sequence produces identical output
// M4: Interleaving unknown events doesn't affect known event outputs
// M5: mapToolName applied twice is same as applied once

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { TranslateResult } from "../../../src/lib/relay/event-translator.js";
import {
	createTranslator,
	mapToolName,
} from "../../../src/lib/relay/event-translator.js";
import type { OpenCodeEvent } from "../../../src/lib/types.js";

const SEED = 42;
const NUM_RUNS = 200;

function collectResults(events: OpenCodeEvent[]): TranslateResult[] {
	const translator = createTranslator();
	return events.map((e) => translator.translate(e));
}

function makeToolEvent(id: string, tool: string): OpenCodeEvent {
	return {
		type: "session.tool.input.started",
		properties: { id, name: tool },
	};
}

function makeReasoningEvent(messageId: string, ordinal: number): OpenCodeEvent {
	return {
		type: "session.reasoning.started",
		properties: { assistantMessageID: messageId, ordinal },
	};
}

function makeDeltaEvent(text: string): OpenCodeEvent {
	return {
		type: "session.text.delta",
		properties: { delta: text },
	};
}

describe("v2 Event Translator Metamorphic PBT", () => {
	describe("M1: Two fresh translators produce identical results (determinism)", () => {
		it("property: same event sequence → same output sequence", () => {
			const arbEventSeq = fc.array(
				fc.oneof(
					fc
						.tuple(fc.uuid(), fc.constantFrom("bash", "read", "edit"))
						.map(([id, tool]) => makeToolEvent(id, tool)),
					fc.tuple(fc.uuid()).map(([id]) => makeReasoningEvent(id, 0)),
					fc
						.string({ minLength: 1, maxLength: 50 })
						.map((text) => makeDeltaEvent(text)),
					fc.constant({
						type: "session.idle",
						properties: { outcome: "succeeded" },
					} as OpenCodeEvent),
					fc.constant({
						type: "session.idle",
						properties: { outcome: "failed" },
					} as OpenCodeEvent),
				),
				{ minLength: 1, maxLength: 15 },
			);

			fc.assert(
				fc.property(arbEventSeq, (events) => {
					expect(collectResults(events)).toEqual(collectResults(events));
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	describe("M2: Independent events for different ids commute", () => {
		it("property: two independent tool starts — either order yields same seenParts size", () => {
			fc.assert(
				fc.property(
					fc.uuid(),
					fc.uuid(),
					fc.constantFrom("bash", "read", "edit"),
					fc.constantFrom("write", "glob", "grep"),
					(idA, idB, toolA, toolB) => {
						fc.pre(idA !== idB);

						const eventA = makeToolEvent(idA, toolA);
						const eventB = makeToolEvent(idB, toolB);

						const t1 = createTranslator();
						t1.translate(eventA);
						t1.translate(eventB);

						const t2 = createTranslator();
						t2.translate(eventB);
						t2.translate(eventA);

						expect(t1.getSeenParts()?.size ?? 0).toBe(
							t2.getSeenParts()?.size ?? 0,
						);
						expect(t1.getSeenParts()?.size ?? 0).toBe(2);
						expect(t1.getSeenParts()?.has(idA)).toBe(true);
						expect(t1.getSeenParts()?.has(idB)).toBe(true);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	describe("M3: Reset then replay produces identical output to fresh translator", () => {
		it("property: translate, reset, translate === fresh translate", () => {
			const arbEvents = fc.array(
				fc
					.tuple(fc.uuid(), fc.constantFrom("bash", "read"))
					.map(([id, tool]) => makeToolEvent(id, tool)),
				{ minLength: 1, maxLength: 10 },
			);

			fc.assert(
				fc.property(arbEvents, (events) => {
					const fresh = createTranslator();
					const freshResults = events.map((e) => fresh.translate(e));

					const resetT = createTranslator();
					for (const e of events) resetT.translate(e);
					resetT.reset();
					const resetResults = events.map((e) => resetT.translate(e));

					expect(resetResults).toEqual(freshResults);
					expect(resetT.getSeenParts()?.size ?? 0).toBe(
						fresh.getSeenParts()?.size ?? 0,
					);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	describe("M4: Interleaving unknown events doesn't affect known event outputs", () => {
		it("property: known events produce same output with/without unknown events", () => {
			const arbKnownEvents = fc.array(
				fc.oneof(
					fc
						.tuple(fc.uuid(), fc.constantFrom("bash", "read"))
						.map(([id, tool]) => makeToolEvent(id, tool)),
					fc.uuid().map((id) => makeReasoningEvent(id, 0)),
				),
				{ minLength: 1, maxLength: 8 },
			);

			const arbUnknownEvents = fc.array(
				fc.constant({
					type: "some.unknown.event",
					properties: { data: "ignored" },
				} as OpenCodeEvent),
				{ minLength: 1, maxLength: 5 },
			);

			fc.assert(
				fc.property(
					arbKnownEvents,
					arbUnknownEvents,
					(knownEvents, unknownEvents) => {
						const clean = createTranslator();
						const cleanResults = knownEvents.map((e) => clean.translate(e));

						const dirty = createTranslator();
						const dirtyResults: ReturnType<typeof dirty.translate>[] = [];
						for (let i = 0; i < knownEvents.length; i++) {
							if (i < unknownEvents.length) {
								// biome-ignore lint/style/noNonNullAssertion: length-checked
								dirty.translate(unknownEvents[i]!);
							}
							// biome-ignore lint/style/noNonNullAssertion: length-checked
							dirtyResults.push(dirty.translate(knownEvents[i]!));
						}

						expect(dirtyResults).toEqual(cleanResults);
						expect(dirty.getSeenParts()?.size ?? 0).toBe(
							clean.getSeenParts()?.size ?? 0,
						);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	describe("M5: mapToolName stability", () => {
		it("property: applying mapToolName twice is safe", () => {
			const allTools = fc.oneof(
				fc.constantFrom(
					"read",
					"edit",
					"write",
					"bash",
					"glob",
					"grep",
					"webfetch",
					"websearch",
					"todowrite",
					"todoread",
					"question",
					"lsp",
					"patch",
					"skill",
					"list",
				),
				fc.string({ minLength: 1, maxLength: 20 }),
			);

			fc.assert(
				fc.property(allTools, (name) => {
					const once = mapToolName(name);
					const twice = mapToolName(once);
					if (once !== name) {
						expect(twice).toBe(once);
					}
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});
});
