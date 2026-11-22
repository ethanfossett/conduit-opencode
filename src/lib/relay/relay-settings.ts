// ─── Relay Settings Persistence ──────────────────────────────────────────────
// Load/save relay-specific settings from ~/.conduit/settings.jsonc.
// Separate from OpenCode's own config — the relay has its own settings file.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG_DIR } from "../env.js";
import type { ModelOverride } from "../session/session-overrides.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RelaySettings {
	defaultModel?: string;
	defaultVariants?: Record<string, string>;
	/** Model used by worker/subagent agents (applied to OpenCode's project config). */
	subagentModel?: string;
	/** Reasoning variant for the subagent model. */
	subagentVariant?: string;
	/** Per-session agent selection, persisted so it survives daemon restarts. */
	sessionAgents?: Record<string, string>;
	/** Per-session thinking level, persisted so it survives daemon restarts. */
	sessionVariants?: Record<string, string>;
	/** Per-session custom system prompt (appended to OpenCode's system prompt). */
	sessionSystemPrompts?: Record<string, string>;
	/** Locked prime strength per model ("provider/model" -> variant). */
	lockedPrimeVariants?: Record<string, string>;
	/** Locked subagent strength per model ("provider/model" -> variant). */
	lockedSubagentVariants?: Record<string, string>;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const SETTINGS_FILE = "settings.jsonc";

// ─── Helpers ────────────────────────────────────────────────────────────────

function resolveDir(configDir?: string): string {
	return configDir ?? DEFAULT_CONFIG_DIR;
}

/** Strip single-line (//) and multi-line (/* *​/) comments from JSONC text. */
function stripComments(text: string): string {
	return text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Load relay settings from the config directory.
 * Returns empty object if file doesn't exist or is corrupt.
 */
export function loadRelaySettings(configDir?: string): RelaySettings {
	try {
		const dir = resolveDir(configDir);
		const raw = readFileSync(join(dir, SETTINGS_FILE), "utf-8");
		return JSON.parse(stripComments(raw)) as RelaySettings;
	} catch {
		return {};
	}
}

/**
 * Save relay settings to the config directory.
 * Uses load-merge-save to preserve existing fields not present in the update.
 * Creates the directory if it doesn't exist. Uses atomic write (tmp + rename).
 */
export function saveRelaySettings(
	settings: RelaySettings,
	configDir?: string,
): void {
	const dir = resolveDir(configDir);
	mkdirSync(dir, { recursive: true });

	// Load-merge-save: preserve existing fields not present in the new settings
	const existing = loadRelaySettings(configDir);
	const merged: RelaySettings = { ...existing };

	if (settings.defaultModel !== undefined) {
		merged.defaultModel = settings.defaultModel;
	}

	// Merge defaultVariants map (shallow merge of entries)
	if (settings.defaultVariants) {
		merged.defaultVariants = {
			...existing.defaultVariants,
			...settings.defaultVariants,
		};
	}

	if (settings.subagentModel !== undefined) {
		merged.subagentModel = settings.subagentModel;
	}

	if (settings.subagentVariant !== undefined) {
		merged.subagentVariant = settings.subagentVariant;
	}

	if (settings.sessionAgents) {
		merged.sessionAgents = {
			...existing.sessionAgents,
			...settings.sessionAgents,
		};
	}

	if (settings.sessionVariants) {
		merged.sessionVariants = {
			...existing.sessionVariants,
			...settings.sessionVariants,
		};
	}

	if (settings.sessionSystemPrompts) {
		merged.sessionSystemPrompts = {
			...existing.sessionSystemPrompts,
			...settings.sessionSystemPrompts,
		};
	}

	if (settings.lockedPrimeVariants) {
		merged.lockedPrimeVariants = {
			...existing.lockedPrimeVariants,
			...settings.lockedPrimeVariants,
		};
	}

	if (settings.lockedSubagentVariants) {
		merged.lockedSubagentVariants = {
			...existing.lockedSubagentVariants,
			...settings.lockedSubagentVariants,
		};
	}

	const tmpPath = join(dir, `.${SETTINGS_FILE}.tmp`);
	const finalPath = join(dir, SETTINGS_FILE);
	writeFileSync(tmpPath, JSON.stringify(merged, null, 2), "utf-8");
	renameSync(tmpPath, finalPath);
}

/** Remove all per-session settings for a deleted session. */
export function pruneSessionSettings(
	configDir: string | undefined,
	sessionId: string,
): void {
	const dir = resolveDir(configDir);
	let settings: RelaySettings;
	try {
		const raw = readFileSync(join(dir, SETTINGS_FILE), "utf-8");
		settings = JSON.parse(stripComments(raw)) as RelaySettings;
	} catch {
		return;
	}
	let changed = false;
	for (const map of [
		settings.sessionAgents,
		settings.sessionVariants,
		settings.sessionSystemPrompts,
		settings.lockedPrimeVariants,
	]) {
		if (map && sessionId in map) {
			delete map[sessionId];
			changed = true;
		}
	}
	if (!changed) return;
	try {
		const tmpPath = join(dir, `.${SETTINGS_FILE}.tmp`);
		writeFileSync(tmpPath, JSON.stringify(settings, null, 2), "utf-8");
		renameSync(tmpPath, join(dir, SETTINGS_FILE));
	} catch {
		// Best-effort cleanup.
	}
}

/**
 * Parse a "provider/model" string into a ModelOverride.
 * Returns undefined for empty or missing input.
 */
export function parseDefaultModel(
	value: string | undefined,
): ModelOverride | undefined {
	if (!value) return undefined;
	const slashIdx = value.indexOf("/");
	if (slashIdx <= 0) return undefined;
	return {
		providerID: value.slice(0, slashIdx),
		modelID: value.slice(slashIdx + 1),
	};
}
