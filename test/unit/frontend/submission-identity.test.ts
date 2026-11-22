import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	forgetSubmission,
	hasUnconfirmedSubmission,
	rememberSubmission,
	submissionFingerprint,
} from "../../../src/lib/frontend/utils/submission-identity.js";

let values: Map<string, string>;
beforeEach(() => {
	values = new Map();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
		removeItem: (key: string) => values.delete(key),
		key: (index: number) => [...values.keys()][index] ?? null,
		get length() {
			return values.size;
		},
	});
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

it("fingerprints include project, session and attachment bytes without storing them", async () => {
	const payload = {
		sessionId: "s1",
		text: "private prompt",
		files: [{ uri: "data:text/plain,private-bytes" }],
	};
	const digest = await submissionFingerprint("project-a", payload);
	expect(digest).toHaveLength(64);
	expect(await submissionFingerprint("project-b", payload)).not.toBe(digest);
	expect(
		await submissionFingerprint("project-a", { ...payload, text: "changed" }),
	).not.toBe(digest);
	rememberSubmission(digest, "id-a", { scope: "project-a", sessionId: "s1" });
	expect(JSON.stringify([...values])).not.toContain("private");
});
it("recovers an unconfirmed identity from disk after a module reload", async () => {
	rememberSubmission("reload", "original-id", { scope: "p", sessionId: "s" });
	vi.resetModules();
	const reloaded = await import(
		"../../../src/lib/frontend/utils/submission-identity.js"
	);
	expect(
		reloaded.rememberSubmission("reload", "replacement-id").requestId,
	).toBe("original-id");
	expect(reloaded.hasUnconfirmedSubmission("p", "s")).toBe(true);
	expect(reloaded.hasUnconfirmedSubmission("different-project", "s")).toBe(
		false,
	);
	reloaded.forgetSubmission("reload");
	expect(reloaded.hasUnconfirmedSubmission("p", "s")).toBe(false);
});
it("expires old records without pretending relay deduplication lasts forever", () => {
	vi.useFakeTimers();
	rememberSubmission("expired", "old-id", { scope: "p", sessionId: "expired" });
	vi.advanceTimersByTime(10 * 60_000);
	expect(hasUnconfirmedSubmission("p", "expired")).toBe(false);
	expect(rememberSubmission("expired", "fresh-id").requestId).toBe("fresh-id");
	forgetSubmission("expired");
});
