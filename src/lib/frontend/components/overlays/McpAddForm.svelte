<!-- ─── MCP Add/Replace Form ─────────────────────────────────────────────── -->
<!-- Adds (or replaces) an MCP server at runtime via PUT /api/experimental -->
<!-- /mcp/{server}. Mirrors the v2 Mcp.LocalConfigEncoded / RemoteConfigEncoded -->
<!-- schemas.                                                                -->

<script lang="ts">
	import { addMcp } from "../../stores/mcp.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import { wsSend } from "../../stores/ws.svelte.js";
	import { buildMcpConfig, MCP_PROTOCOLS } from "../../utils/mcp-form.js";

	let {
		/** When set, the form edits (replaces) this existing server. */
		editName = null,
		onDone,
	}: {
		editName?: string | null;
		onDone?: () => void;
	} = $props();

	// ─── Form state ────────────────────────────────────────────────────────────

	let name = $state("");
	let transport = $state<"local" | "remote">("local");
	let command = $state("");
	let url = $state("");
	let cwd = $state("");
	let envText = $state("");
	let headersText = $state("");
	let disabled = $state(false);
	let codemode = $state(false);
	let protocol = $state("");

	const isEditing = $derived(editName != null && editName !== "");

	// React to the parent switching the edit target.
	$effect(() => {
		if (editName != null && editName !== "") {
			name = editName;
		}
	});

	// ─── Submit ────────────────────────────────────────────────────────────────

	function submit() {
		const result = buildMcpConfig({
			name,
			transport,
			command,
			url,
			cwd,
			envText,
			headersText,
			disabled,
			codemode,
			protocol,
		});
		if (!result.ok) {
			showToast(result.error, { variant: "warn" });
			return;
		}
		addMcp(wsSend, result.name, result.config);
		showToast(
			isEditing
				? `Replacing MCP server "${result.name}"…`
				: `Adding MCP server "${result.name}"…`,
		);
		resetForm();
		onDone?.();
	}

	function resetForm() {
		if (!isEditing) name = "";
		command = "";
		url = "";
		cwd = "";
		envText = "";
		headersText = "";
		disabled = false;
		codemode = false;
		protocol = "";
	}

	/** Leave replace mode and clear the carried-over name. */
	function cancelEdit() {
		name = "";
		onDone?.();
	}
</script>

<div
	id="mcp-add-form"
	class="border border-border rounded-lg p-3 space-y-2 font-brand"
>
	<div class="text-xs font-semibold uppercase tracking-widest text-text-muted">
		{isEditing ? `Replace "${editName}"` : "Add server"}
	</div>

	<input
		type="text"
		placeholder="Server name"
		class="w-full px-2.5 min-h-[40px] text-sm border border-border rounded bg-bg text-text placeholder:text-text-muted disabled:opacity-60"
		data-testid="mcp-name-input"
		bind:value={name}
		disabled={isEditing}
	/>

	<div class="flex items-center gap-4 text-sm text-text-secondary">
		<label class="flex items-center gap-1.5 cursor-pointer">
			<input type="radio" class="accent-[var(--color-brand-a)]" value="local" bind:group={transport} />
			Local command
		</label>
		<label class="flex items-center gap-1.5 cursor-pointer">
			<input type="radio" class="accent-[var(--color-brand-a)]" value="remote" bind:group={transport} />
			Remote URL
		</label>
	</div>

	{#if transport === "local"}
		<input
			type="text"
			placeholder="Command (e.g. npx -y @modelcontextprotocol/server-filesystem .)"
			class="w-full px-2.5 min-h-[40px] text-sm border border-border rounded bg-bg text-text placeholder:text-text-muted font-mono"
			data-testid="mcp-command-input"
			bind:value={command}
		/>
		<input
			type="text"
			placeholder="Working directory (optional)"
			class="w-full px-2.5 min-h-[40px] text-sm border border-border rounded bg-bg text-text placeholder:text-text-muted font-mono"
			data-testid="mcp-cwd-input"
			bind:value={cwd}
		/>
		<textarea
			rows="2"
			placeholder="Environment — one KEY=VALUE per line (optional)"
			class="w-full px-2.5 py-2 text-sm border border-border rounded bg-bg text-text placeholder:text-text-muted font-mono resize-y"
			data-testid="mcp-env-input"
			bind:value={envText}
		></textarea>
	{:else}
		<input
			type="text"
			placeholder="URL (e.g. https://example.com/mcp)"
			class="w-full px-2.5 min-h-[40px] text-sm border border-border rounded bg-bg text-text placeholder:text-text-muted font-mono"
			data-testid="mcp-url-input"
			bind:value={url}
		/>
		<textarea
			rows="2"
			placeholder="Headers — one Name: value per line (optional)"
			class="w-full px-2.5 py-2 text-sm border border-border rounded bg-bg text-text placeholder:text-text-muted font-mono resize-y"
			data-testid="mcp-headers-input"
			bind:value={headersText}
		></textarea>
	{/if}

	<details class="text-sm">
		<summary class="cursor-pointer text-text-muted select-none">Advanced</summary>
		<div class="pt-2 space-y-2">
			<label class="flex items-center gap-2 text-text-secondary cursor-pointer">
				<input type="checkbox" class="accent-[var(--color-brand-a)]" bind:checked={disabled} />
				Disabled (configured but not connected)
			</label>
			<label class="flex items-center gap-2 text-text-secondary cursor-pointer">
				<input type="checkbox" class="accent-[var(--color-brand-a)]" bind:checked={codemode} />
				Code mode (expose as code-mode tools)
			</label>
			<label class="flex items-center gap-2 text-text-secondary">
				<span class="shrink-0">Protocol</span>
				<select
					class="flex-1 px-2 min-h-[36px] text-sm border border-border rounded bg-bg text-text"
					data-testid="mcp-protocol-select"
					bind:value={protocol}
				>
					<option value="">Default (legacy)</option>
					{#each MCP_PROTOCOLS as p}
						<option value={p}>{p}</option>
					{/each}
				</select>
			</label>
		</div>
	</details>

	<div class="flex items-center gap-2">
		<button
			type="button"
			class="flex-1 min-h-[44px] text-sm rounded border border-border text-text hover:bg-white/[0.05] cursor-pointer bg-transparent disabled:opacity-50 disabled:cursor-not-allowed"
			data-testid="mcp-add-submit"
			disabled={!name.trim() || (transport === "local" ? !command.trim() : !url.trim())}
			onclick={submit}
		>
			{isEditing ? "Replace server" : "Add server"}
		</button>
		{#if isEditing}
			<button
				type="button"
				class="px-3 min-h-[44px] text-sm rounded border border-border text-text-muted hover:text-text cursor-pointer bg-transparent"
				onclick={cancelEdit}
			>
				Cancel
			</button>
		{/if}
	</div>
	<p class="text-xs text-text-muted">
		Added servers are runtime-only: OpenCode connects them immediately and keeps them until its next restart.
	</p>
</div>
