// ─── File Attach Utilities ───────────────────────────────────────────────────
// Parse @references from text and build XML-wrapped messages.

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FileAttachment {
	path: string;
	type: "file" | "directory" | "binary";
	content?: string;
}

// ─── Parse @references ──────────────────────────────────────────────────────

/** CSS at-rules are prose/code, not implicit project-file attachments. */
const CSS_AT_RULES = new Set([
	"media",
	"supports",
	"container",
	"layer",
	"import",
	"charset",
	"namespace",
	"keyframes",
	"-webkit-keyframes",
	"font-face",
	"font-feature-values",
	"font-palette-values",
	"page",
	"counter-style",
	"property",
	"scope",
	"starting-style",
	"document",
	"tailwind",
	"apply",
	"theme",
	"source",
	"config",
	"plugin",
	"utility",
	"variant",
	"custom-variant",
	"reference",
	"screen",
]);

/** Mask Markdown code before recognizing mentions. Code is sent verbatim to
 * OpenCode; a pasted example must never trigger reads of its @tokens. */
function outsideCode(text: string): string {
	let fence: { character: string; length: number } | undefined;
	const prose = text
		.split("\n")
		.map((line) => {
			const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
			if (fence) {
				if (
					marker?.[1]?.[0] === fence.character &&
					marker[1].length >= fence.length &&
					line.slice(marker[0].length).trim() === ""
				)
					fence = undefined;
				return "";
			}
			if (marker?.[1]) {
				fence = { character: marker[1][0] ?? "`", length: marker[1].length };
				return "";
			}
			return line;
		})
		.join("\n");
	return prose.replace(/(`+)[\s\S]*?\1(?!`)/g, " ");
}

function isCssReference(reference: string): boolean {
	const [head = "", ...selectors] = reference
		.replace(/[),;:.!?]+$/, "")
		.split("/");
	const rule = head.match(/^([\w-]+)(?:[(:{]|$)/)?.[1]?.toLowerCase();
	if (!rule || !CSS_AT_RULES.has(rule)) return false;
	// Preserve real paths like @media/styles.css and @media/icons/.
	// Also recognize selector shorthand such as @media/.loraRow/.advanced.
	return (
		selectors.length === 0 ||
		selectors.every((part) => /^[.#][\w-]+$/.test(part))
	);
}

/** Extract @file references from prose, excluding Markdown code, email-like
 * patterns, and CSS at-rules. The original message is never modified. */
export function parseAtReferences(
	text: string,
	knownMentions: Iterable<string> = [],
): string[] {
	const known = new Set(knownMentions);
	const matches = outsideCode(text).matchAll(/(?:^|(?<=\s))@(\S+)/g);
	return [
		...new Set(
			[...matches]
				.map((match) => match[1] ?? "")
				.filter(
					(reference) =>
						reference && (known.has(reference) || !isCssReference(reference)),
				),
		),
	];
}

// ─── Build XML message ──────────────────────────────────────────────────────

/**
 * Build an XML-wrapped message with file attachments.
 * Returns plain text if no attachments are provided.
 */
export function buildAttachedMessage(
	text: string,
	attachments: FileAttachment[],
): string {
	if (attachments.length === 0) return text;

	const fileParts = attachments
		.map((a) => {
			if (a.type === "binary") {
				return `<file path="${a.path}" binary="true" />`;
			}
			if (a.type === "directory") {
				return `<directory path="${a.path}">\n${a.content}\n</directory>`;
			}
			return `<file path="${a.path}">\n${a.content}\n</file>`;
		})
		.join("\n");

	return `<attached-files>\n${fileParts}\n</attached-files>\n\n<user-message>\n${text}\n</user-message>`;
}
