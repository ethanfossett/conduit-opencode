/** Load the full language catalog only when a code block actually needs it. */
let pending: Promise<typeof import("highlight.js")> | undefined;
export async function loadHighlighter() {
	pending ??= import("highlight.js").catch((error: unknown) => {
		pending = undefined;
		throw error;
	});
	const { default: highlighter } = await pending;
	highlighter.registerAliases(["svelte", "vue"], { languageName: "xml" });
	return highlighter;
}
