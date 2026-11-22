// ─── Apply agents to a project ───────────────────────────────────────────────
// Explicit, reversible: merges selected agents into the project's
// .opencode/opencode.json (the same overlay Conduit uses for other settings)
// and removes exactly those agents again. The library itself is never touched.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "../logger.js";
import type { AgentDefinition } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function overlayFile(projectDir: string): string {
	return join(projectDir, ".opencode", "opencode.json");
}

async function readOverlay(
	projectDir: string,
): Promise<Record<string, unknown>> {
	try {
		const parsed = JSON.parse(await readFile(overlayFile(projectDir), "utf-8"));
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

async function writeOverlay(
	projectDir: string,
	overlay: Record<string, unknown>,
): Promise<void> {
	await mkdir(join(projectDir, ".opencode"), { recursive: true });
	await writeFile(
		overlayFile(projectDir),
		`${JSON.stringify(overlay, null, 2)}\n`,
	);
}

/** Agents currently written into the project overlay. */
export async function listAppliedAgents(projectDir: string): Promise<string[]> {
	const overlay = await readOverlay(projectDir);
	const agent = overlay["agent"];
	return isRecord(agent) ? Object.keys(agent).sort() : [];
}

/**
 * Write the given agents into the project overlay, replacing each agent
 * definition wholesale (so removed fields don't linger) while preserving all
 * other overlay content. Returns the applied names.
 */
export async function applyAgentsToProject(
	projectDir: string,
	agents: Array<{ name: string; definition: AgentDefinition }>,
	log?: Logger,
): Promise<string[]> {
	const overlay = await readOverlay(projectDir);
	const current = isRecord(overlay["agent"]) ? { ...overlay["agent"] } : {};
	for (const agent of agents) {
		current[agent.name] = agent.definition;
	}
	overlay["agent"] = current;
	await writeOverlay(projectDir, overlay);
	log?.info(
		`[agents] applied ${agents.map((a) => a.name).join(", ")} to ${projectDir}`,
	);
	return agents.map((a) => a.name);
}

/** Remove the given agents from the project overlay. Returns removed names. */
export async function removeAgentsFromProject(
	projectDir: string,
	names: string[],
	log?: Logger,
): Promise<string[]> {
	const overlay = await readOverlay(projectDir);
	const agent = overlay["agent"];
	if (!isRecord(agent)) return [];
	const removed: string[] = [];
	for (const name of names) {
		if (Object.hasOwn(agent, name)) {
			delete agent[name];
			removed.push(name);
		}
	}
	if (removed.length === 0) return [];
	if (Object.keys(agent).length === 0) {
		delete overlay["agent"];
	} else {
		overlay["agent"] = agent;
	}
	await writeOverlay(projectDir, overlay);
	log?.info(`[agents] removed ${removed.join(", ")} from ${projectDir}`);
	return removed;
}
