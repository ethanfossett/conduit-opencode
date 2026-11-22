import { afterEach, describe, expect, it, vi } from "vitest";
import {
	clearAcceptedDraft,
	draftKey,
	loadDraft,
	saveDraft,
} from "../../../src/lib/frontend/utils/drafts.js";

afterEach(() => vi.unstubAllGlobals());
describe("durable text drafts", () => {
	it("isolates project/session pairs including separators", () => {
		expect(draftKey("a:b", "c")).not.toBe(draftKey("a", "b:c"));
		expect(draftKey("a", "same")).not.toBe(draftKey("b", "same"));
	});
	it("reads saved text after a reload and clears sent drafts", () => {
		const values = new Map([[draftKey("p", "reload"), "survives reload"]]);
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => values.get(key),
			setItem: (key: string, text: string) => values.set(key, text),
			removeItem: (key: string) => values.delete(key),
		});
		expect(loadDraft(draftKey("p", "reload"))).toBe("survives reload");
		expect(saveDraft(draftKey("p", "reload"), "")).toBe(true);
		expect(values.size).toBe(0);
	});
	it("keeps edits in memory when browser storage is full", () => {
		vi.stubGlobal("localStorage", {
			getItem: () => {
				throw new Error("denied");
			},
			setItem: () => {
				throw new Error("quota");
			},
		});
		const key = draftKey("p", "quota");
		expect(saveDraft(key, "do not lose me")).toBe(false);
		expect(loadDraft(key)).toBe("do not lose me");
	});
});

it("clears an accepted draft after leaving the chat while preserving newer edits", () => {
	const key = draftKey("p", "late-acceptance");
	saveDraft(key, "sent snapshot");
	clearAcceptedDraft(key, "sent snapshot");
	expect(loadDraft(key)).toBe("");
	saveDraft(key, "a newer draft");
	clearAcceptedDraft(key, "sent snapshot");
	expect(loadDraft(key)).toBe("a newer draft");
});
