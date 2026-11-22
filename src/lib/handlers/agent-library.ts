// ─── Agent Library Handlers ──────────────────────────────────────────────────
// Manage the local agent library (list/save/delete/import/export) and apply or
// remove agents on the current project's overlay. Library files live in
// <configDir>/agents/; defaults are bundled with the app. Editing the library
// never touches OpenCode configs — only apply/remove do, and reversibly.

import {
	applyAgentsToProject,
	listAppliedAgents,
	removeAgentsFromProject,
} from "../agents/apply.js";
import { listDefaultAgents } from "../agents/defaults.js";
import {
	deleteLibraryAgent,
	exportAgentBundle,
	importAgentBundle,
	listLibraryAgents,
	readLibraryAgent,
	saveLibraryAgent,
} from "../agents/library.js";
import type { AgentDefinition, LibraryAgent } from "../agents/types.js";
import { DEFAULT_CONFIG_DIR } from "../env.js";
import type { PayloadMap } from "./payloads.js";
import type { HandlerDeps } from "./types.js";

function agentConfigDir(deps: HandlerDeps): string {
	return deps.config.configDir ?? DEFAULT_CONFIG_DIR;
}

function projectDir(deps: HandlerDeps): string {
	return deps.config.projectDir;
}

/** Library + defaults (library wins on name collisions) + applied names. */
export async function handleListAgentLibrary(
	deps: HandlerDeps,
	clientId: string,
	_payload: PayloadMap["list_agent_library"],
): Promise<void> {
	const dir = agentConfigDir(deps);
	const [library, defaults, applied] = await Promise.all([
		listLibraryAgents(dir, deps.log),
		listDefaultAgents(deps.log),
		listAppliedAgents(projectDir(deps)),
	]);
	const byName = new Map<string, LibraryAgent>();
	for (const agent of defaults) byName.set(agent.name, agent);
	for (const agent of library) byName.set(agent.name, agent);
	const agents = [...byName.values()].sort((a, b) =>
		a.name.localeCompare(b.name),
	);
	deps.wsHandler.sendTo(clientId, { type: "agent_library", agents, applied });
}

export async function handleSaveAgent(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["save_agent"],
): Promise<void> {
	const ok = await saveLibraryAgent(
		agentConfigDir(deps),
		payload.name,
		payload.definition as AgentDefinition,
	);
	if (!ok) throw new Error("invalid agent name or definition");
	deps.wsHandler.sendTo(clientId, { type: "agent_saved", name: payload.name });
}

export async function handleDeleteAgent(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["delete_agent"],
): Promise<void> {
	const deleted = await deleteLibraryAgent(agentConfigDir(deps), payload.name);
	deps.wsHandler.sendTo(clientId, {
		type: "agent_deleted",
		name: payload.name,
		deleted,
	});
}

export async function handleImportAgents(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["import_agents"],
): Promise<void> {
	const options: { overwrite?: boolean } = {};
	if (payload.overwrite !== undefined) options.overwrite = payload.overwrite;
	const result = await importAgentBundle(
		agentConfigDir(deps),
		payload.bundle,
		options,
		deps.log,
	);
	deps.wsHandler.sendTo(clientId, { type: "agent_import_result", ...result });
}

export async function handleExportAgents(
	deps: HandlerDeps,
	clientId: string,
	_payload: PayloadMap["export_agents"],
): Promise<void> {
	const bundle = await exportAgentBundle(agentConfigDir(deps), deps.log);
	deps.wsHandler.sendTo(clientId, { type: "agent_export", bundle });
}

/** Resolve a name from the library first, then the bundled defaults. */
async function resolveAgents(
	deps: HandlerDeps,
	names: string[],
): Promise<Array<{ name: string; definition: AgentDefinition }>> {
	const dir = agentConfigDir(deps);
	const defaults = await listDefaultAgents(deps.log);
	const resolved: Array<{ name: string; definition: AgentDefinition }> = [];
	const missing: string[] = [];
	for (const name of names) {
		const fromLibrary = await readLibraryAgent(dir, name);
		if (fromLibrary) {
			resolved.push({ name, definition: fromLibrary.definition });
			continue;
		}
		const fromDefaults = defaults.find((a) => a.name === name);
		if (fromDefaults) {
			resolved.push({ name, definition: fromDefaults.definition });
			continue;
		}
		missing.push(name);
	}
	if (missing.length > 0) {
		throw new Error(`unknown agent(s): ${missing.join(", ")}`);
	}
	return resolved;
}

export async function handleApplyAgents(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["apply_agents"],
): Promise<void> {
	const agents = await resolveAgents(deps, payload.names);
	const applied = await applyAgentsToProject(
		projectDir(deps),
		agents,
		deps.log,
	);
	deps.wsHandler.sendTo(clientId, { type: "agents_applied", names: applied });
}

export async function handleRemoveAppliedAgents(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["remove_applied_agents"],
): Promise<void> {
	const removed = await removeAgentsFromProject(
		projectDir(deps),
		payload.names,
		deps.log,
	);
	deps.wsHandler.sendTo(clientId, {
		type: "agents_removed",
		names: payload.names,
		removed,
	});
}
