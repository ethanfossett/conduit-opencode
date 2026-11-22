<!-- ─── Plugins Panel ─────────────────────────────────────────────────────── -->
<!-- Lists loaded OpenCode plugins with their source/state and surfaces     -->
<!-- update checking + package updates.                                      -->

<script lang="ts">
	import Icon from "../shared/Icon.svelte";
	import {
		checkPlugins,
		outdatedTargets,
		pluginOutdated,
		pluginSourceLabel,
		pluginStateLabel,
		pluginState,
		pluginTarget,
		pluginUpdating,
		requestPlugins,
		updatePlugins,
	} from "../../stores/plugin.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import { wsSend } from "../../stores/ws.svelte.js";

	const plugins = $derived(pluginState.plugins);
	const outdated = $derived(outdatedTargets(plugins));

	function updateOne(target: string) {
		updatePlugins(wsSend, [target]);
	}

	function updateAllOutdated() {
		const targets = outdatedTargets(plugins);
		if (targets.length === 0) {
			showToast("No plugin updates available");
			return;
		}
		updatePlugins(wsSend, targets);
	}
</script>

<div class="flex items-center justify-between mb-3 gap-2">
	<span class="text-xs text-text-muted font-medium uppercase tracking-wide font-brand">
		{plugins.length} plugin{plugins.length !== 1 ? "s" : ""}
	</span>
	<div class="flex items-center gap-2">
		<button
			type="button"
			class="flex items-center gap-1.5 px-2.5 min-h-[36px] text-xs rounded border border-border text-text-muted hover:text-text hover:border-text-muted transition-colors cursor-pointer font-brand disabled:opacity-50"
			data-testid="plugin-check-btn"
			disabled={pluginState.checking}
			onclick={() => checkPlugins(wsSend)}
		>
			<Icon name="refresh-cw" size={12} class={pluginState.checking ? "animate-spin" : ""} />
			{pluginState.checking ? "Checking…" : "Check updates"}
		</button>
		{#if outdated.length > 0}
			<button
				type="button"
				class="flex items-center gap-1.5 px-2.5 min-h-[36px] text-xs rounded border border-border text-text hover:bg-white/[0.05] transition-colors cursor-pointer font-brand"
				data-testid="plugin-update-all-btn"
				onclick={updateAllOutdated}
			>
				<Icon name="circle-arrow-up" size={12} />
				Update all ({outdated.length})
			</button>
		{/if}
	</div>
</div>

{#if plugins.length > 0}
	<div id="plugin-list" class="space-y-1 font-brand">
		{#each plugins as plugin, i (pluginTarget(plugin) ?? plugin.id ?? `plugin-${i}`)}
			{@const target = pluginTarget(plugin)}
			{@const busy = pluginUpdating(plugin)}
			<div
				class="border border-border rounded-lg px-3 py-2.5"
				data-testid="plugin-row"
			>
				<div class="flex items-center gap-2 min-w-0">
					<Icon name="package" size={14} class="text-text-muted shrink-0" />
					<span class="font-medium text-text truncate">
						{plugin.id ?? target ?? "plugin"}
					</span>
					{#if plugin.state?.status === "failed"}
						<span class="text-xs text-error shrink-0">Failed</span>
					{:else}
						<span class="text-xs text-text-muted ml-auto shrink-0">{pluginStateLabel(plugin)}</span>
					{/if}
				</div>
				<div class="flex items-center gap-2 mt-1 text-xs text-text-muted">
					<span class="truncate">{pluginSourceLabel(plugin)}</span>
					{#if pluginOutdated(plugin)}
						<span class="shrink-0 text-amber-400 border border-amber-400/40 rounded px-1 py-0.5 uppercase tracking-wide text-[10px]">
							update available
						</span>
					{/if}
				</div>
				{#if plugin.state?.status === "failed"}
					<div class="mt-1 text-xs text-error break-words">{plugin.state.error}</div>
				{/if}
				{#if target && pluginOutdated(plugin)}
					<div class="flex flex-wrap gap-2 mt-2">
						<button
							type="button"
							class="flex items-center gap-1.5 px-3 min-h-[36px] text-xs rounded border border-border text-text hover:bg-white/[0.05] cursor-pointer bg-transparent disabled:opacity-50"
							data-testid="plugin-update-btn"
							disabled={busy}
							onclick={() => updateOne(target)}
						>
							<Icon name="circle-arrow-up" size={12} class={busy ? "animate-spin" : ""} />
							{busy ? "Updating…" : "Update"}
						</button>
					</div>
				{/if}
			</div>
		{/each}
	</div>
{:else}
	<div class="text-sm text-text-muted font-brand">
		{pluginState.loaded ? "No plugins loaded." : "Loading plugins…"}
	</div>
{/if}
