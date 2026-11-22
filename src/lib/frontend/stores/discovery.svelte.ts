// ─── Discovery Store ─────────────────────────────────────────────────────────
// Agents, models, providers, and commands.

import type {
	AgentInfo,
	CommandInfo,
	ModelInfo,
	ProviderGroup,
	ProviderInfo,
	RelayMessage,
	SkillInfo,
} from "../types.js";
import { sessionState } from "./session.svelte.js";
import { showToast } from "./ui.svelte.js";

// ─── State ──────────────────────────────────────────────────────────────────

export const discoveryState = $state({
	agents: [] as AgentInfo[],
	activeAgentId: null as string | null,
	/** Custom system prompt for the current chat (empty string = none). */
	systemPrompt: "" as string,
	providers: [] as ProviderInfo[],
	currentModelId: "" as string,
	currentProviderId: "" as string,
	commands: [] as CommandInfo[],
	commandsFetched: false,
	skills: [] as SkillInfo[],
	skillsFetched: false,
	defaultModelId: "" as string,
	defaultProviderId: "" as string,
	subagentModelId: "" as string,
	subagentProviderId: "" as string,
	subagentVariant: "" as string,
	lockedPrimeVariant: null as string | null,
	lockedSubagentVariant: null as string | null,
	modelDefaultVariant: null as string | null,
	currentVariant: "" as string,
	availableVariants: [] as string[],
});

// ─── Derived getters ────────────────────────────────────────────────────────
// Components should wrap in $derived() for reactive caching.

/** Get the currently active agent. */
export function getActiveAgent(): AgentInfo | undefined {
	return discoveryState.agents.find(
		(a) => a.id === discoveryState.activeAgentId,
	);
}

/** Get all models from all providers, flattened. */
export function getAllModels(): ModelInfo[] {
	return discoveryState.providers.flatMap((p) => p.models);
}

/** Get the currently active model. */
export function getActiveModel(): ModelInfo | undefined {
	return getAllModels().find((m) => m.id === discoveryState.currentModelId);
}

/** Get models grouped by provider for dropdown rendering. */
export function getProviderGroups(): ProviderGroup[] {
	return discoveryState.providers
		.filter((p) => p.models.length > 0)
		.map((p) => ({ provider: p, models: p.models }));
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

/** Format agent label for display. */
export function formatAgentLabel(agent: AgentInfo): string {
	return agent.name || agent.id;
}

/** Build tooltip text for an agent. */
export function buildAgentTooltip(agent: AgentInfo): string {
	return agent.description || agent.name || agent.id;
}

/** Format model name for display. */
export function formatModelName(model: ModelInfo): string {
	return model.name || model.id;
}

/** Check if a provider is configured. */
export function isProviderConfigured(provider: ProviderInfo): boolean {
	return provider.configured;
}

/** Filter commands by query (case-insensitive prefix match on name). */
export function filterCommands(
	commands: CommandInfo[],
	query: string,
): CommandInfo[] {
	if (!query) return commands;
	const lower = query.toLowerCase();
	return commands.filter((c) => c.name.toLowerCase().startsWith(lower));
}

export interface SlashQuery {
	query: string;
	start: number;
	end: number;
}

/** Extract slash command query from input text at cursor position. */
export function extractSlashQuery(
	text: string,
	cursorPos: number,
): SlashQuery | null {
	// Look backwards from cursor for a '/' at the start of the line or after whitespace
	const before = text.slice(0, cursorPos);
	const match = before.match(/(?:^|[\s\n])\/(\S*)$/);
	if (!match) return null;

	const query = match[1] ?? "";
	const matchStart = before.length - match[0].length;
	const slashStart = match[0].startsWith("/") ? matchStart : matchStart + 1;

	return { query, start: slashStart, end: cursorPos };
}

// ─── Message handlers ───────────────────────────────────────────────────────

export function handleAgentList(
	msg: Extract<RelayMessage, { type: "agent_list" }>,
): void {
	const { agents, activeAgentId } = msg;
	if (Array.isArray(agents)) {
		discoveryState.agents = agents;
	}
	if (activeAgentId) {
		discoveryState.activeAgentId = activeAgentId;
	}
}

export function handleModelList(
	msg: Extract<RelayMessage, { type: "model_list" }>,
): void {
	const { providers } = msg;
	if (Array.isArray(providers)) {
		discoveryState.providers = providers;
	}
}

/** Session-scoped messages may only update the currently viewed chat. */
function forCurrentSession(msg: { sessionId?: string }): boolean {
	return (
		!msg.sessionId ||
		!sessionState.currentId ||
		msg.sessionId === sessionState.currentId
	);
}

export function handleModelInfo(
	msg: Extract<RelayMessage, { type: "model_info" }>,
): void {
	if (!forCurrentSession(msg)) return;
	const { model, provider } = msg;
	if (model) discoveryState.currentModelId = model;
	if (provider) discoveryState.currentProviderId = provider;
}

export function handleCommandList(
	msg: Extract<RelayMessage, { type: "command_list" }>,
): void {
	const { commands } = msg;
	if (Array.isArray(commands)) {
		discoveryState.commands = commands;
		discoveryState.commandsFetched = true;
	}
}

export function handleSkillList(
	msg: Extract<RelayMessage, { type: "skill_list" }>,
): void {
	const { skills } = msg;
	if (Array.isArray(skills)) {
		discoveryState.skills = skills;
		discoveryState.skillsFetched = true;
	}
}

export function handleDefaultModelInfo(
	msg: Extract<RelayMessage, { type: "default_model_info" }>,
): void {
	discoveryState.defaultModelId = msg.model ?? "";
	discoveryState.defaultProviderId = msg.provider ?? "";
	if (msg.subagentModel) {
		discoveryState.subagentModelId = msg.subagentModel;
		discoveryState.subagentProviderId = msg.subagentProvider ?? "";
		discoveryState.subagentVariant = msg.subagentVariant ?? "";
	}
}

// ─── Actions ────────────────────────────────────────────────────────────────

export function setActiveAgent(agentId: string): void {
	discoveryState.activeAgentId = agentId;
}

export function setActiveModel(modelId: string, providerId: string): void {
	discoveryState.currentModelId = modelId;
	discoveryState.currentProviderId = providerId;
}

/** Get the available variants for the currently active model. */
export function getActiveModelVariants(): string[] {
	return discoveryState.availableVariants;
}

// ─── Variant handler ────────────────────────────────────────────────────────

export function handleVariantInfo(
	msg: Extract<RelayMessage, { type: "variant_info" }>,
): void {
	if (!forCurrentSession(msg)) return;
	const previous = discoveryState.currentVariant;
	discoveryState.currentVariant = msg.variant ?? "";
	// Merge the server list with the active model's catalog variants so a stale or
	// partial message can never hide an option (e.g. DeepSeek's "max").
	const catalog = getActiveModel()?.variants ?? [];
	const merged = Array.from(
		new Set(
			[
				...(msg.variants ?? []),
				...catalog,
				...(msg.variant ? [msg.variant] : []),
				...(discoveryState.lockedPrimeVariant
					? [discoveryState.lockedPrimeVariant]
					: []),
				...(discoveryState.lockedSubagentVariant
					? [discoveryState.lockedSubagentVariant]
					: []),
			].filter(Boolean),
		),
	);
	discoveryState.availableVariants = merged;
	if (msg.locked && msg.variant !== undefined && msg.variant !== previous) {
		showToast("Strength is locked in settings", { variant: "warn" });
	}
}

/** Per-chat agent selection sent on session view/switch and agent changes. */
export function handleAgentInfo(
	msg: Extract<RelayMessage, { type: "agent_info" }>,
): void {
	if (!forCurrentSession(msg)) return;
	discoveryState.activeAgentId = msg.agent || null;
}

/** Per-chat custom system prompt, sent on session view/switch and on change. */
export function handleSystemPromptInfo(
	msg: Extract<RelayMessage, { type: "system_prompt_info" }>,
): void {
	if (!forCurrentSession(msg)) return;
	discoveryState.systemPrompt = msg.text ?? "";
}

/** Variant lock state for a model (prime and subagent scopes). */
export function handleVariantLockInfo(
	msg: Extract<RelayMessage, { type: "variant_lock_info" }>,
): void {
	// Prime locks are per chat; subagent locks are project-wide (all chats).
	if (
		!msg.sessionId ||
		!sessionState.currentId ||
		msg.sessionId === sessionState.currentId
	) {
		discoveryState.lockedPrimeVariant = msg.prime || null;
	}
	discoveryState.lockedSubagentVariant = msg.subagent || null;
	discoveryState.modelDefaultVariant = msg.modelDefault || null;
}

/** Clear all discovery state (for project switch). */
export function clearDiscoveryState(): void {
	discoveryState.agents = [];
	discoveryState.activeAgentId = null;
	discoveryState.systemPrompt = "";
	discoveryState.providers = [];
	discoveryState.currentModelId = "";
	discoveryState.currentProviderId = "";
	discoveryState.commands = [];
	discoveryState.commandsFetched = false;
	discoveryState.skills = [];
	discoveryState.skillsFetched = false;
	discoveryState.defaultModelId = "";
	discoveryState.defaultProviderId = "";
	discoveryState.subagentModelId = "";
	discoveryState.subagentProviderId = "";
	discoveryState.subagentVariant = "";
	discoveryState.lockedPrimeVariant = null;
	discoveryState.lockedSubagentVariant = null;
	discoveryState.modelDefaultVariant = null;
	discoveryState.currentVariant = "";
	discoveryState.availableVariants = [];
}
