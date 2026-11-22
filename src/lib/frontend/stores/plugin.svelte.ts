// ─── Plugin Store ────────────────────────────────────────────────────────────
// Loaded OpenCode plugins + their state. The server is authoritative: the
// store mirrors `plugin_list` broadcasts and `plugin_updated` results, and
// exposes check/update actions over the WebSocket.

import type { PluginInfo, RelayMessage } from "../types.js";

// ─── State ──────────────────────────────────────────────────────────────────

export const pluginState = $state({
	plugins: [] as PluginInfo[],
	/** True once at least one plugin_list has been received. */
	loaded: false,
	/** True while a check-for-updates request is in flight. */
	checking: false,
	/** Package targets currently being updated. */
	updating: [] as string[],
});

// ─── Pure helpers ───────────────────────────────────────────────────────────

/** The install target for package plugins (used by check/update). */
export function pluginTarget(plugin: PluginInfo): string | undefined {
	return plugin.source?.type === "package" ? plugin.source.target : undefined;
}

/** Human-readable label for a plugin's source. */
export function pluginSourceLabel(plugin: PluginInfo): string {
	const source = plugin.source;
	switch (source?.type) {
		case "builtin":
			return "Built-in";
		case "package":
			return source.version ? `Package · v${source.version}` : "Package";
		case "local":
			return `Local · ${source.path}`;
		case "sdk":
			return "SDK";
		default:
			return "Unknown";
	}
}

/** Human-readable label for a plugin's state. */
export function pluginStateLabel(plugin: PluginInfo): string {
	if (plugin.state?.status === "failed") return "Failed";
	return "Active";
}

/** True when a package plugin has a newer version available. */
export function pluginOutdated(plugin: PluginInfo): boolean {
	return plugin.source?.type === "package" && plugin.source.outdated === true;
}

/** True while this plugin is being updated. */
export function pluginUpdating(plugin: PluginInfo): boolean {
	const target = pluginTarget(plugin);
	if (!target) return false;
	if (plugin.source?.type === "package" && plugin.source.updating === true)
		return true;
	return pluginState.updating.includes(target);
}

/** All package targets with a newer version available. */
export function outdatedTargets(plugins: PluginInfo[]): string[] {
	return plugins
		.map((p) => (pluginOutdated(p) ? pluginTarget(p) : undefined))
		.filter((t): t is string => typeof t === "string" && t.length > 0);
}

// ─── Message handlers ───────────────────────────────────────────────────────

export function handlePluginList(
	msg: Extract<RelayMessage, { type: "plugin_list" }>,
): void {
	pluginState.plugins = Array.isArray(msg.plugins) ? msg.plugins : [];
	pluginState.loaded = true;
	pluginState.checking = false;
	// A refreshed list supersedes any in-flight update tracking that the
	// server no longer reports as updating.
	const updating = new Set(
		pluginState.plugins
			.filter((p) => p.source?.type === "package" && p.source.updating === true)
			.map((p) => (p.source?.type === "package" ? p.source.target : ""))
			.filter((t) => t.length > 0),
	);
	pluginState.updating = pluginState.updating.filter((t) => updating.has(t));
}

export function handlePluginUpdated(
	msg: Extract<RelayMessage, { type: "plugin_updated" }>,
): void {
	const targets = Array.isArray(msg.targets) ? msg.targets : [];
	pluginState.updating = pluginState.updating.filter(
		(t) => !targets.includes(t),
	);
}

// ─── Actions ────────────────────────────────────────────────────────────────

type SendFn = (data: Record<string, unknown>) => void;

/** Request the current plugin list. */
export function requestPlugins(sendFn: SendFn): void {
	pluginState.checking = false;
	sendFn({ type: "list_plugins" });
}

/** Ask OpenCode to check one (or all) package plugins for updates. */
export function checkPlugins(sendFn: SendFn, target?: string): void {
	pluginState.checking = true;
	sendFn({
		type: "check_plugins",
		...(target ? { target } : {}),
	});
}

/** Update the given package plugin targets. */
export function updatePlugins(sendFn: SendFn, targets: string[]): void {
	const unique = [...new Set(targets.filter((t) => !!t))];
	if (unique.length === 0) return;
	pluginState.updating = [...new Set([...pluginState.updating, ...unique])];
	sendFn({ type: "update_plugins", targets: unique });
}

export function clearPluginState(): void {
	pluginState.plugins = [];
	pluginState.loaded = false;
	pluginState.checking = false;
	pluginState.updating = [];
}
