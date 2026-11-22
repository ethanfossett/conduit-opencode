<!-- ─── VCS Panel ─────────────────────────────────────────────────────────────── -->
<!-- Shows the working-tree status (branch + changed files) and unified diffs    -->
<!-- from OpenCode's v2 /api/vcs endpoints. Opens as a right-side slide-over.     -->

<script lang="ts">
	import type { RelayMessage } from "../../types.js";
	import { onFileBrowser, wsSend } from "../../stores/ws.svelte.js";
	import Icon from "../shared/Icon.svelte";
	import BlockGrid from "../shared/BlockGrid.svelte";

	let {
		visible = false,
		onClose,
	}: {
		visible?: boolean;
		onClose?: () => void;
	} = $props();

	// ─── State ─────────────────────────────────────────────────────────────────

	let provider = $state<string | undefined>(undefined);
	let branch = $state<string | undefined>(undefined);
	let files = $state<
		Array<{
			path: string;
			status: string;
			additions?: number;
			deletions?: number;
		}>
	>([]);
	let diffs = $state<
		Array<{ path: string; diff: string; additions: number; deletions: number; status: string }>
	>([]);
	let loading = $state(false);
	let diffLoading = $state(false);
	let showDiff = $state(false);

	// ─── WS subscription ───────────────────────────────────────────────────────

	$effect(() => {
		if (!visible) return;
		const unsub = onFileBrowser((msg: RelayMessage) => {
			if (msg.type === "vcs_info") {
				provider = msg.provider;
				branch = msg.branch;
				files = msg.files ?? [];
				loading = false;
			} else if (msg.type === "vcs_diff") {
				diffs = msg.diffs ?? [];
				diffLoading = false;
			}
		});
		return unsub;
	});

	// Request status whenever the panel opens.
	$effect(() => {
		if (visible) {
			loading = true;
			wsSend({ type: "get_vcs" });
		}
	});

	// ─── Handlers ──────────────────────────────────────────────────────────────

	function refresh() {
		loading = true;
		showDiff = false;
		diffs = [];
		wsSend({ type: "get_vcs" });
	}

	function loadDiff() {
		showDiff = true;
		if (diffs.length === 0) {
			diffLoading = true;
			wsSend({ type: "get_vcs_diff", mode: "working" });
		}
	}

	function statusLabel(status: string): string {
		switch (status) {
			case "added":
				return "A";
			case "deleted":
				return "D";
			default:
				return "M";
		}
	}

	function statusColor(status: string): string {
		switch (status) {
			case "added":
				return "text-success";
			case "deleted":
				return "text-error";
			default:
				return "text-accent";
		}
	}
</script>

{#if visible}
	<!-- Backdrop -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="fixed inset-0 z-[150] bg-black/40" onclick={onClose}></div>

	<!-- Slide-over -->
	<aside
		class="fixed top-0 right-0 z-[151] h-dvh w-full max-w-[520px] flex flex-col bg-bg-alt border-l border-border shadow-[0_0_24px_rgba(var(--shadow-rgb),0.4)]"
	>
		<!-- Header -->
		<div class="flex items-center gap-2 px-4 py-2.5 border-b border-border-subtle shrink-0 min-h-[44px]">
			<Icon name="git-fork" size={16} />
			<span class="flex-1 font-brand font-semibold text-text truncate">
				Changes
				{#if branch}<span class="text-text-dimmer font-normal">· {branch}</span>{/if}
			</span>
			<button
				type="button"
				class="flex items-center justify-center w-7 h-7 rounded-md border-none bg-transparent text-text-muted cursor-pointer transition-[background,color] duration-150 hover:bg-[rgba(var(--overlay-rgb),0.04)] hover:text-text"
				title="Refresh"
				onclick={refresh}
			>
				<Icon name="refresh-cw" size={16} />
			</button>
			<button
				type="button"
				class="flex items-center justify-center w-7 h-7 rounded-md border-none bg-transparent text-text-muted cursor-pointer transition-[background,color] duration-150 hover:bg-[rgba(var(--overlay-rgb),0.04)] hover:text-text"
				title="Close"
				onclick={onClose}
			>
				<Icon name="x" size={16} />
			</button>
		</div>

		<!-- Body -->
		<div class="flex-1 overflow-y-auto px-3 py-2">
			{#if loading && files.length === 0}
				<div class="flex items-center justify-center py-10 text-text-dimmer text-sm">
					<BlockGrid cols={5} mode="fast" blockSize={1.5} gap={0.5} class="shrink-0" />
					<span class="ml-2">Loading…</span>
				</div>
			{:else if files.length === 0}
				<div class="text-center py-10 text-text-dimmer text-sm">
					Working tree clean
				</div>
			{:else}
				<div class="text-xs text-text-dimmer px-1 pb-1">
					{files.length} changed file{files.length === 1 ? "" : "s"}
				</div>
				<ul class="flex flex-col gap-0.5">
					{#each files as f (f.path)}
						<li class="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-[rgba(var(--overlay-rgb),0.04)]">
							<span class="w-4 text-center font-mono text-xs {statusColor(f.status)}">{statusLabel(f.status)}</span>
							<span class="flex-1 font-mono text-xs text-text-secondary truncate" dir="rtl">{f.path}</span>
							{#if f.additions != null || f.deletions != null}
								<span class="font-mono text-[11px] text-success">+{f.additions ?? 0}</span>
								<span class="font-mono text-[11px] text-error">-{f.deletions ?? 0}</span>
							{/if}
						</li>
					{/each}
				</ul>

				<button
					type="button"
					class="w-full mt-3 py-1.5 px-3 rounded-lg text-xs font-medium border cursor-pointer transition-colors duration-100 font-brand bg-transparent text-text-dimmer border-border-subtle hover:bg-[rgba(var(--overlay-rgb),0.04)] hover:text-text"
					onclick={showDiff ? refresh : loadDiff}
				>
					{showDiff ? "Hide diff" : "Show diff"}
				</button>

				{#if showDiff}
					{#if diffLoading}
						<div class="flex items-center justify-center py-6 text-text-dimmer text-sm">
							<BlockGrid cols={5} mode="fast" blockSize={1.5} gap={0.5} class="shrink-0" />
							<span class="ml-2">Loading diff…</span>
						</div>
					{:else if diffs.length === 0}
						<div class="text-center py-6 text-text-dimmer text-sm">No diff</div>
					{:else}
						{#each diffs as d (d.path)}
							<div class="mt-3">
								<div class="font-mono text-[11px] text-text-muted truncate" dir="rtl">{d.path}</div>
								<pre class="mt-1 p-2 rounded-md bg-bg overflow-x-auto font-mono text-[11px] leading-[1.5] text-text-secondary border border-border-subtle">{d.diff}</pre>
							</div>
						{/each}
					{/if}
				{/if}
			{/if}
		</div>
	</aside>
{/if}
