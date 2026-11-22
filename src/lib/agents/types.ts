// ─── Agent library types ─────────────────────────────────────────────────────

/**
 * An OpenCode agent definition. Known fields are typed for the UI; the index
 * signature passes through anything newer OpenCode supports.
 */
export interface AgentDefinition {
	description?: string;
	mode?: string;
	model?: string;
	variant?: string;
	color?: string;
	steps?: number;
	prompt?: string;
	permission?: unknown;
	[key: string]: unknown;
}

/** One agent as stored in a file: definition plus its name. */
export interface NamedAgent extends AgentDefinition {
	name: string;
}

/** An agent surfaced to clients with where it comes from. */
export interface LibraryAgent {
	name: string;
	source: "library" | "default";
	definition: AgentDefinition;
}

/** Portable export/import format (versioned). */
export interface AgentBundle {
	version: 1;
	agents: NamedAgent[];
}

/** Agent names: lowercase letters, digits and dashes, 1–64 chars. */
export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidAgentName(name: unknown): name is string {
	return typeof name === "string" && AGENT_NAME_RE.test(name);
}

/** Split a `{name, ...definition}` record into name + definition. */
export function splitNamedAgent(record: Record<string, unknown>): {
	name: string;
	definition: AgentDefinition;
} | null {
	const { name, ...definition } = record;
	if (!isValidAgentName(name)) return null;
	return { name, definition: definition as AgentDefinition };
}
