<!-- ─── Integrations Panel ────────────────────────────────────────────────── -->
<!-- Lists available integrations and drives their connect flows: raw API   -->
<!-- key, OAuth (with polling + code completion) and command auth.           -->

<script lang="ts">
	import NodecodeCard from "./NodecodeCard.svelte";
	import { NODECODE_PROVIDER_ID } from "../../../nodecode.js";
	import Icon from "../shared/Icon.svelte";
	import type { IntegrationInfo, IntegrationMethod } from "../../types.js";
	import {
		attemptIsActive,
		attemptStatusLabel,
		cancelIntegrationCommand,
		cancelIntegrationOAuth,
		completeIntegrationOAuth,
		connectIntegrationKey,
		dismissAttempt,
		integrationMethodLabel,
		integrationState,
		pollIntegrationCommand,
		pollIntegrationOAuth,
		requestIntegrations,
		startIntegrationCommand,
		startIntegrationOAuth,
	} from "../../stores/integration.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import { wsSend } from "../../stores/ws.svelte.js";

	let expandedId = $state<string | null>(null);
	let keyInputs = $state<Record<string, string>>({});
	let keyLabels = $state<Record<string, string>>({});
	let codeInputs = $state<Record<string, string>>({});

	let { onClose }: { onClose?: () => void } = $props();
	const integrations = $derived(integrationState.integrations.filter((i) => i.id !== NODECODE_PROVIDER_ID));

	function toggleExpanded(id: string) {
		expandedId = expandedId === id ? null : id;
	}

	function methodKey(integration: IntegrationInfo, method: IntegrationMethod, i: number): string {
		if (method.type === "key") return `${integration.id}:key:${i}`;
		if (method.type === "oauth" || method.type === "command") {
			return `${integration.id}:${method.type}:${method.id}`;
		}
		return `${integration.id}:env:${i}`;
	}

	function attemptsFor(integrationID: string) {
		return Object.values(integrationState.attempts).filter(
			(a) => a.integrationID === integrationID,
		);
	}

	// ─── Actions ───────────────────────────────────────────────────────────────

	function submitKey(integration: IntegrationInfo, methodKeyStr: string) {
		const key = (keyInputs[methodKeyStr] ?? "").trim();
		if (!key) {
			showToast("API key is required", { variant: "warn" });
			return;
		}
		connectIntegrationKey(wsSend, {
			integrationID: integration.id,
			key,
			...(keyLabels[methodKeyStr]?.trim()
				? { label: keyLabels[methodKeyStr]?.trim() }
				: {}),
		});
		keyInputs = { ...keyInputs, [methodKeyStr]: "" };
	}

	function startOAuth(integration: IntegrationInfo, method: IntegrationMethod) {
		if (method.type !== "oauth") return;
		startIntegrationOAuth(wsSend, {
			integrationID: integration.id,
			methodID: method.id,
		});
	}

	function startCommand(integration: IntegrationInfo, method: IntegrationMethod) {
		if (method.type !== "command") return;
		startIntegrationCommand(wsSend, {
			integrationID: integration.id,
			methodID: method.id,
		});
	}

	function completeOAuth(integrationID: string, attemptID: string) {
		const code = (codeInputs[attemptID] ?? "").trim();
		completeIntegrationOAuth(wsSend, integrationID, attemptID, code || undefined);
	}

	function cancelAttempt(integrationID: string, attemptID: string, kind: "oauth" | "command") {
		if (kind === "oauth") cancelIntegrationOAuth(wsSend, integrationID, attemptID);
		else cancelIntegrationCommand(wsSend, integrationID, attemptID);
	}

	// ─── Status polling for active attempts ────────────────────────────────────
	// Re-armed whenever the attempt map changes; polls every 3s while any
	// attempt is pending.

	$effect(() => {
		const active = Object.values(integrationState.attempts).filter(
			attemptIsActive,
		);
		if (active.length === 0) return;
		const timer = setInterval(() => {
			for (const attempt of Object.values(integrationState.attempts)) {
				if (!attemptIsActive(attempt)) continue;
				if (attempt.kind === "oauth") {
					pollIntegrationOAuth(wsSend, attempt.integrationID, attempt.attemptID);
				} else {
					pollIntegrationCommand(wsSend, attempt.integrationID, attempt.attemptID);
				}
			}
		}, 3000);
		return () => clearInterval(timer);
	});
</script>

<NodecodeCard {onClose} />

<div class="flex items-center justify-between mb-3">
	<span class="text-xs text-text-muted font-medium uppercase tracking-wide font-brand">
		{integrations.length} integration{integrations.length !== 1 ? "s" : ""}
	</span>
	<button
		type="button"
		class="flex items-center gap-1.5 px-2.5 min-h-[36px] text-xs rounded border border-border text-text-muted hover:text-text hover:border-text-muted transition-colors cursor-pointer font-brand"
		data-testid="integrations-refresh-btn"
		onclick={() => requestIntegrations(wsSend)}
	>
		<Icon name="refresh-cw" size={12} />
		Refresh
	</button>
</div>

{#if integrations.length > 0}
	<div id="integration-list" class="space-y-1 font-brand">
		{#each integrations as integration (integration.id)}
			{@const attempts = attemptsFor(integration.id)}
			<div class="border border-border rounded-lg" data-testid="integration-row">
				<button
					type="button"
					class="flex items-center gap-2 w-full px-3 py-2.5 text-left bg-transparent border-none cursor-pointer hover:bg-white/[0.03]"
					onclick={() => toggleExpanded(integration.id)}
				>
					<Icon
						name={expandedId === integration.id ? "chevron-down" : "chevron-right"}
						size={14}
						class="text-text-muted shrink-0"
					/>
					<Icon name="plug" size={15} class="text-text-muted shrink-0" />
					<span class="font-medium text-text truncate">{integration.name}</span>
					<span class="text-xs text-text-muted truncate ml-1">{integration.id}</span>
					{#if integration.connections.length > 0}
						<span class="ml-auto text-[10px] uppercase tracking-wide text-success border border-success/40 rounded px-1 py-0.5 shrink-0">
							{integration.connections.length} connected
						</span>
					{:else if attempts.length > 0}
						<span class="ml-auto text-[10px] uppercase tracking-wide text-amber-400 border border-amber-400/40 rounded px-1 py-0.5 shrink-0">
							pending
						</span>
					{/if}
				</button>

				{#if expandedId === integration.id}
					<div class="px-3 pb-3 pt-1 space-y-2 border-t border-border">
						{#if integration.connections.length > 0}
							<div class="text-xs text-text-muted">
								{#each integration.connections as connection}
									<div class="truncate">
										{connection.label || connection.credentialID || connection.type || "connection"}
										{#if connection.active}<span class="text-success"> · active</span>{/if}
									</div>
								{/each}
							</div>
						{/if}

						{#each integration.methods as method, i (methodKey(integration, method, i))}
							{@const mk = methodKey(integration, method, i)}
							<div class="border border-border-subtle rounded p-2 space-y-1.5">
								<div class="flex items-center gap-1.5 text-xs text-text-secondary">
									<Icon
										name={method.type === "key" ? "key-round" : method.type === "env" ? "terminal" : "link"}
										size={12}
										class="text-text-muted shrink-0"
									/>
									<span class="font-medium">{integrationMethodLabel(method)}</span>
									<span class="text-text-muted">· {method.type}</span>
								</div>

								{#if method.type === "key"}
									<input
										type="password"
										placeholder="API key"
										autocomplete="off"
										class="w-full px-2.5 min-h-[36px] text-sm border border-border rounded bg-bg text-text placeholder:text-text-muted"
										data-testid="integration-key-input"
										bind:value={keyInputs[mk]}
									/>
									<input
										type="text"
										placeholder="Label (optional)"
										class="w-full px-2.5 min-h-[36px] text-sm border border-border rounded bg-bg text-text placeholder:text-text-muted"
										data-testid="integration-key-label-input"
										bind:value={keyLabels[mk]}
									/>
									<button
										type="button"
										class="px-3 min-h-[36px] text-xs rounded border border-border text-text hover:bg-white/[0.05] cursor-pointer bg-transparent"
										data-testid="integration-connect-key-btn"
										onclick={() => submitKey(integration, mk)}
									>Connect with key</button>
								{:else if method.type === "oauth"}
									<button
										type="button"
										class="px-3 min-h-[36px] text-xs rounded border border-border text-text hover:bg-white/[0.05] cursor-pointer bg-transparent"
										data-testid="integration-connect-oauth-btn"
										onclick={() => startOAuth(integration, method)}
									>Start OAuth</button>
								{:else if method.type === "command"}
									<button
										type="button"
										class="px-3 min-h-[36px] text-xs rounded border border-border text-text hover:bg-white/[0.05] cursor-pointer bg-transparent"
										data-testid="integration-connect-command-btn"
										onclick={() => startCommand(integration, method)}
									>Run auth command</button>
								{:else if method.type === "env"}
									<div class="text-xs text-text-muted font-mono break-all">
										{method.names.join(", ")}
									</div>
								{/if}
							</div>
						{/each}

						{#each attempts as attempt (attempt.attemptID)}
							<div
								class="border rounded p-2 space-y-1.5 {attempt.phase === 'failed'
									? 'border-red-700/60'
									: attempt.phase === 'complete'
										? 'border-success/60'
										: 'border-amber-400/40'}"
								data-testid="integration-attempt"
							>
								<div class="flex items-center gap-2 text-xs">
									<span class="uppercase tracking-wide text-text-muted">{attempt.kind}</span>
									<span class="text-text-secondary">{attemptStatusLabel(attempt)}</span>
								</div>
								{#if attempt.instructions}
									<div class="text-xs text-text-muted break-words">{attempt.instructions}</div>
								{/if}
								{#if attempt.url && (attempt.kind !== "oauth" || attempt.phase === "started" || attempt.phase === "pending")}
									<a
										href={attempt.url}
										target="_blank"
										rel="noopener noreferrer"
										class="inline-flex items-center gap-1 text-xs text-accent hover:underline break-all"
									>
										<Icon name="external-link" size={12} class="shrink-0" />
										Open authorization page
									</a>
								{/if}
								{#if attempt.kind === "oauth" && attemptIsActive(attempt)}
									<div class="flex items-center gap-2">
										<input
											type="text"
											placeholder="Authorization code (if shown)"
											class="flex-1 px-2.5 min-h-[36px] text-sm border border-border rounded bg-bg text-text placeholder:text-text-muted"
											data-testid="integration-oauth-code-input"
											bind:value={codeInputs[attempt.attemptID]}
										/>
										<button
											type="button"
											class="px-3 min-h-[36px] text-xs rounded border border-border text-text hover:bg-white/[0.05] cursor-pointer bg-transparent shrink-0"
											data-testid="integration-oauth-complete-btn"
											onclick={() => completeOAuth(attempt.integrationID, attempt.attemptID)}
										>Complete</button>
									</div>
								{/if}
								<div class="flex items-center gap-2">
									{#if attemptIsActive(attempt)}
										<button
											type="button"
											class="px-3 min-h-[32px] text-xs rounded border border-border text-text-muted hover:text-text cursor-pointer bg-transparent"
											data-testid="integration-cancel-btn"
											onclick={() => cancelAttempt(attempt.integrationID, attempt.attemptID, attempt.kind)}
										>Cancel</button>
									{:else}
										<button
											type="button"
											class="px-3 min-h-[32px] text-xs rounded border border-border text-text-muted hover:text-text cursor-pointer bg-transparent"
											onclick={() => dismissAttempt(attempt.integrationID, attempt.attemptID)}
										>Dismiss</button>
									{/if}
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		{/each}
	</div>
{:else}
	<div class="text-sm text-text-muted font-brand">
		{integrationState.loaded ? "No integrations available." : "Loading integrations…"}
	</div>
{/if}
