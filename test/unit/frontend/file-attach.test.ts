// ─── File Attach Utility Tests ───────────────────────────────────────────────
import { describe, expect, it } from "vitest";
import {
	buildAttachedMessage,
	parseAtReferences,
} from "../../../src/lib/frontend/utils/file-attach.js";

// ─── parseAtReferences ──────────────────────────────────────────────────────

describe("parseAtReferences", () => {
	it("returns empty array for text without @ references", () => {
		expect(parseAtReferences("hello world")).toEqual([]);
	});

	it("extracts a single file reference", () => {
		expect(parseAtReferences("explain @src/auth.ts please")).toEqual([
			"src/auth.ts",
		]);
	});

	it("extracts multiple file references", () => {
		expect(parseAtReferences("compare @src/old.ts and @src/new.ts")).toEqual([
			"src/old.ts",
			"src/new.ts",
		]);
	});

	it("extracts directory references", () => {
		expect(parseAtReferences("list @src/utils/")).toEqual(["src/utils/"]);
	});

	it("handles @ at start of text", () => {
		expect(parseAtReferences("@file.ts")).toEqual(["file.ts"]);
	});

	it("ignores email-like patterns", () => {
		expect(parseAtReferences("contact user@example.com")).toEqual([]);
	});
});

// ─── buildAttachedMessage ───────────────────────────────────────────────────

describe("buildAttachedMessage", () => {
	it("returns original text when no attachments", () => {
		expect(buildAttachedMessage("hello", [])).toBe("hello");
	});

	it("wraps text with file attachments in XML", () => {
		const result = buildAttachedMessage("explain @src/auth.ts", [
			{ path: "src/auth.ts", type: "file", content: "const x = 1;" },
		]);
		expect(result).toContain("<attached-files>");
		expect(result).toContain('<file path="src/auth.ts">');
		expect(result).toContain("const x = 1;");
		expect(result).toContain("</file>");
		expect(result).toContain("</attached-files>");
		expect(result).toContain("<user-message>");
		expect(result).toContain("explain @src/auth.ts");
		expect(result).toContain("</user-message>");
	});

	it("wraps directory attachments", () => {
		const result = buildAttachedMessage("list @src/", [
			{ path: "src/", type: "directory", content: "auth.ts (1.2KB, file)" },
		]);
		expect(result).toContain('<directory path="src/">');
		expect(result).toContain("auth.ts (1.2KB, file)");
		expect(result).toContain("</directory>");
	});

	it("handles binary files", () => {
		const result = buildAttachedMessage("show @img.png", [
			{ path: "img.png", type: "binary" },
		]);
		expect(result).toContain('<file path="img.png" binary="true" />');
	});

	it("handles multiple attachments", () => {
		const result = buildAttachedMessage("compare @a.ts and @b.ts", [
			{ path: "a.ts", type: "file", content: "aaa" },
			{ path: "b.ts", type: "file", content: "bbb" },
		]);
		expect(result).toContain('<file path="a.ts">');
		expect(result).toContain('<file path="b.ts">');
	});
});

describe("code and CSS are not file mentions", () => {
	it("does not read the reported CSS selector shorthand as a file", () => {
		expect(parseAtReferences("Fix @media/.loraRow/.advanced please")).toEqual(
			[],
		);
		expect(parseAtReferences("Fix @media/.loraRow/.advanced.")).toEqual([]);
	});
	it("ignores CSS at-rules while retaining real paths under media", () => {
		expect(
			parseAtReferences(
				"@media (max-width: 600px) { .loraRow .advanced {} } @supports(display:grid) @apply rounded @media/styles.css @media/icons/",
			),
		).toEqual(["media/styles.css", "media/icons/"]);
	});
	it("ignores fenced CSS and inline code, preserving mentions in surrounding prose", () => {
		const text =
			"Read @src/style.css\n```css\n@import url(theme.css);\n@media/.loraRow/.advanced\n@src/not-a-real-file.ts\n```\nExplain `@example.ts` and compare @src/other.css";
		expect(parseAtReferences(text)).toEqual(["src/style.css", "src/other.css"]);
	});
	it("ignores tilde fences and unfinished pasted code fences", () => {
		expect(
			parseAtReferences(
				"~~~css\n@fake.css\n~~~\n@real.css\n```\n@still-code.css",
			),
		).toEqual(["real.css"]);
	});
	it("preserves dotfiles and deduplicates repeated explicit mentions", () => {
		expect(parseAtReferences("@.gitignore @src/auth.ts @src/auth.ts")).toEqual([
			".gitignore",
			"src/auth.ts",
		]);
	});
});

it("preserves explicitly known files and reference names that overlap CSS keywords", () => {
	expect(
		parseAtReferences("@media @media/.loraRow/.advanced", [
			"media",
			"media/.loraRow/.advanced",
		]),
	).toEqual(["media", "media/.loraRow/.advanced"]);
});
