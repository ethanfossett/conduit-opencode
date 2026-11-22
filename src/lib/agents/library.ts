// ─── Agent Library (local, file-per-agent) ──────────────────────────────────
// Agents live in <configDir>/agents/<name>.json as plain JSON files, so they
// are trivially backupable/removable. Nothing here touches OpenCode configs;
// applying to a project is a separate, explicit step (see apply.ts).

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "../logger.js";
import {
	AGENT_NAME_RE,
	type AgentBundle,
	type AgentDefinition,
	isValidAgentName,
	type LibraryAgent,
	type NamedAgent,
	splitNamedAgent,
} from "./types.js";

/** Per-agent file size ceiling — definitions are prompts, not payloads. */
const MAX_AGENT_FILE_BYTES = 512 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Directory holding this Conduit instance's agent library. */
export function agentsDir(configDir: string): string {
	return join(configDir, "agents");
}

function agentPath(configDir: string, name: string): string {
	return join(agentsDir(configDir), `${name}.json`);
}

/** Read every valid agent file; invalid files are skipped with a warning. */
export async function listLibraryAgents(
	configDir: string,
	log?: Logger,
): Promise<LibraryAgent[]> {
	const dir = agentsDir(configDir);
	let files: string[];
	try {
		files = await readdir(dir);
	} catch {
		return [];
	}
	const agents: LibraryAgent[] = [];
	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		const name = file.slice(0, -5);
		if (!isValidAgentName(name)) {
			log?.warn(`[agents] ignoring file with invalid name: ${file}`);
			continue;
		}
		try {
			const raw = JSON.parse(await readFile(join(dir, file), "utf-8"));
			if (!isRecord(raw)) throw new Error("not an object");
			const split = splitNamedAgent(raw);
			if (!split) throw new Error("missing or invalid name");
			agents.push({
				name: split.name,
				source: "library",
				definition: split.definition,
			});
		} catch (err) {
			log?.warn(`[agents] skipping invalid agent file ${file}: ${err}`);
		}
	}
	agents.sort((a, b) => a.name.localeCompare(b.name));
	return agents;
}

/** Read one library agent, or null when absent/invalid. */
export async function readLibraryAgent(
	configDir: string,
	name: string,
): Promise<LibraryAgent | null> {
	if (!isValidAgentName(name)) return null;
	try {
		const raw = JSON.parse(await readFile(agentPath(configDir, name), "utf-8"));
		if (!isRecord(raw)) return null;
		const split = splitNamedAgent(raw);
		return split
			? { name: split.name, source: "library", definition: split.definition }
			: null;
	} catch {
		return null;
	}
}

/** Create/overwrite a library agent. Returns false for invalid names. */
export async function saveLibraryAgent(
	configDir: string,
	name: string,
	definition: AgentDefinition,
): Promise<boolean> {
	if (!isValidAgentName(name) || !isRecord(definition)) return false;
	const body = `${JSON.stringify({ name, ...definition }, null, 2)}\n`;
	if (Buffer.byteLength(body, "utf-8") > MAX_AGENT_FILE_BYTES) {
		throw new Error(
			`agent "${name}" exceeds the ${MAX_AGENT_FILE_BYTES} byte limit`,
		);
	}
	await mkdir(agentsDir(configDir), { recursive: true });
	await writeFile(agentPath(configDir, name), body);
	return true;
}

/** Remove a library agent. Returns whether a file existed. */
export async function deleteLibraryAgent(
	configDir: string,
	name: string,
): Promise<boolean> {
	if (!isValidAgentName(name)) return false;
	try {
		await rm(agentPath(configDir, name));
		return true;
	} catch {
		return false;
	}
}

/** Bundle every library agent for export. */
export async function exportAgentBundle(
	configDir: string,
	log?: Logger,
): Promise<AgentBundle> {
	const agents = await listLibraryAgents(configDir, log);
	return {
		version: 1,
		agents: agents.map((a) => ({ name: a.name, ...a.definition })),
	};
}

/**
 * Import a bundle produced by exportAgentBundle (or hand-written in the same
 * shape). Existing agents are kept unless `overwrite` is set.
 */
export async function importAgentBundle(
	configDir: string,
	input: unknown,
	options?: { overwrite?: boolean },
	log?: Logger,
): Promise<{ imported: string[]; skipped: string[]; invalid: string[] }> {
	const imported: string[] = [];
	const skipped: string[] = [];
	const invalid: string[] = [];

	if (!isRecord(input) || !Array.isArray(input["agents"])) {
		return {
			imported,
			skipped,
			invalid: ["<bundle: expected { agents: [...] }>"],
		};
	}

	const entries = input["agents"] as unknown[];
	for (const entry of entries) {
		if (!isRecord(entry)) {
			invalid.push("<entry: not an object>");
			continue;
		}
		const split = splitNamedAgent(entry);
		if (!split) {
			invalid.push(
				typeof entry["name"] === "string" ? String(entry["name"]) : "<entry>",
			);
			continue;
		}
		const existing = await readLibraryAgent(configDir, split.name);
		if (existing && !options?.overwrite) {
			skipped.push(split.name);
			continue;
		}
		try {
			await saveLibraryAgent(configDir, split.name, split.definition);
			imported.push(split.name);
			log?.info(`[agents] imported ${split.name}`);
		} catch (err) {
			log?.warn(`[agents] failed to import ${split.name}: ${err}`);
			invalid.push(split.name);
		}
	}

	return { imported, skipped, invalid };
}

export { AGENT_NAME_RE, isValidAgentName };
export type { AgentBundle, AgentDefinition, LibraryAgent, NamedAgent };
