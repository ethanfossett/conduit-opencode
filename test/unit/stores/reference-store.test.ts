// ─── Reference store ─────────────────────────────────────────────────────────

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearReferenceState,
	filterReferences,
	findMentionRange,
	findReferenceByMention,
	handleReferenceList,
	referenceAttachment,
	referenceFileUri,
	referenceMentionAttachment,
	referenceState,
	requestReferences,
} from "../../../src/lib/frontend/stores/reference.svelte.js";
import type { ReferenceInfo } from "../../../src/lib/shared-types.js";

const OPENCODE_REF: ReferenceInfo = {
	name: "opencode",
	path: "/home/me/repos/opencode",
	description: "Core repo",
	source: { type: "git", repository: "sst/opencode", branch: "main" },
};

const DOCS_REF: ReferenceInfo = {
	name: "docs",
	path: "/home/me/notes/docs",
	source: { type: "local", path: "/home/me/notes/docs" },
};

const REFS: ReferenceInfo[] = [OPENCODE_REF, DOCS_REF];

beforeEach(() => {
	clearReferenceState();
});

describe("handleReferenceList", () => {
	it("stores references and marks loaded", () => {
		handleReferenceList({ type: "reference_list", references: REFS });
		expect(referenceState.references).toHaveLength(2);
		expect(referenceState.loaded).toBe(true);
	});

	it("filters out malformed entries", () => {
		handleReferenceList({
			type: "reference_list",
			references: [null, { name: 42 }, OPENCODE_REF] as never,
		});
		expect(referenceState.references).toHaveLength(1);
	});
});

describe("filterReferences", () => {
	it("returns the first 20 for an empty query", () => {
		expect(filterReferences(REFS, "")).toEqual(REFS);
	});

	it("matches name, path, and description", () => {
		expect(filterReferences(REFS, "open").map((r) => r.name)).toEqual([
			"opencode",
		]);
		expect(filterReferences(REFS, "notes").map((r) => r.name)).toEqual([
			"docs",
		]);
		expect(filterReferences(REFS, "core").map((r) => r.name)).toEqual([
			"opencode",
		]);
	});

	it("returns nothing for a non-match", () => {
		expect(filterReferences(REFS, "zzzz")).toEqual([]);
	});
});

describe("findReferenceByMention", () => {
	it("matches by name first", () => {
		expect(findReferenceByMention(REFS, "docs")?.path).toBe(
			"/home/me/notes/docs",
		);
	});

	it("falls back to an exact path match", () => {
		expect(findReferenceByMention(REFS, "/home/me/repos/opencode")?.name).toBe(
			"opencode",
		);
	});

	it("returns undefined for unknown mentions", () => {
		expect(findReferenceByMention(REFS, "nope")).toBeUndefined();
		expect(findReferenceByMention(REFS, "")).toBeUndefined();
	});
});

describe("file URIs", () => {
	it("builds a file: URI from an absolute path", () => {
		expect(referenceFileUri(OPENCODE_REF)).toBe(
			"file:///home/me/repos/opencode",
		);
	});

	it("encodes spaces and reserved characters", () => {
		const ref: ReferenceInfo = {
			name: "spaced",
			path: "/home/me/my docs/a#b?c",
			source: { type: "local", path: "/home/me/my docs/a#b?c" },
		};
		expect(referenceFileUri(ref)).toBe("file:///home/me/my%20docs/a%23b%3Fc");
	});

	it("builds an attachment with the display name", () => {
		expect(referenceAttachment(DOCS_REF)).toEqual({
			uri: "file:///home/me/notes/docs",
			name: "docs",
		});
	});

	it("finds mention ranges and advances the cursor", () => {
		const text = "look at @docs and @docs again";
		const first = findMentionRange(text, "docs");
		expect(first).toEqual({ start: 8, end: 13, text: "@docs", nextIndex: 13 });
		const second = findMentionRange(text, "docs", first?.nextIndex);
		expect(second?.start).toBe(18);
		expect(findMentionRange(text, "nope")).toBeUndefined();
	});

	it("attaches the mention range when the token is present", () => {
		const text = "see @opencode for details";
		const { attachment, nextIndex } = referenceMentionAttachment(
			OPENCODE_REF,
			text,
		);
		expect(attachment).toEqual({
			uri: "file:///home/me/repos/opencode",
			name: "opencode",
			mention: { start: 4, end: 13, text: "@opencode" },
		});
		expect(nextIndex).toBe(13);
	});

	it("omits the mention when the token is absent", () => {
		const { attachment } = referenceMentionAttachment(DOCS_REF, "no mention");
		expect(attachment).toEqual({
			uri: "file:///home/me/notes/docs",
			name: "docs",
		});
	});
});

describe("requestReferences", () => {
	it("sends get_references", () => {
		const send = vi.fn();
		requestReferences(send);
		expect(send).toHaveBeenCalledWith({ type: "get_references" });
	});
});
