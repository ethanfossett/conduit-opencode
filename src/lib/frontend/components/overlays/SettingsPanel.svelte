<!-- ─── Settings Panel ────────────────────────────────────────────────────── -->
<!-- Modal settings panel with tabbed navigation. Uses the 68-mockup card   -->
<!-- design. Tabs: Notifications, Appearance, Instances, Debug.             -->

<script lang="ts">
	import { untrack } from "svelte";
	import Icon from "../shared/Icon.svelte";
	import ToggleSetting from "../shared/ToggleSetting.svelte";
	import { createFrontendLogger } from "../../utils/logger.js";
	import type { Base16Theme } from "../../stores/theme-compute.js";

	const log = createFrontendLogger("push");
	import {
		getCachedInstances,
		getProxyDetection,
		getScanResult,
		instanceStatusColor,
		isScanInFlight,
		startProxyDetection,
		triggerScan,
	} from "../../stores/instance.svelte.js";
	import { wsSend } from "../../stores/ws.svelte.js";
	import { confirm, showToast } from "../../stores/ui.svelte.js";
	import {
		activateCredential,
		createApiKeyCredential,
		credentialState,
		credentialValueSummary,
		deleteCredential,
		requestCredentials,
	} from "../../stores/credentials.svelte.js";
	import {
		requestIntegrations,
	} from "../../stores/integration.svelte.js";
	import {
		requestPlugins,
	} from "../../stores/plugin.svelte.js";
	import {
		connectMcp,
		disconnectMcp,
		mcpCanConnect,
		mcpCanDisconnect,
		mcpState,
		mcpStatusColor,
		mcpStatusLabel,
		removeMcp,
		requestMcp,
	} from "../../stores/mcp.svelte.js";
	import IntegrationsPanel from "./IntegrationsPanel.svelte";
	import McpAddForm from "./McpAddForm.svelte";
	import PluginsPanel from "./PluginsPanel.svelte";
	import {
		reloadConfig,
		requestServerInfo,
		serverInfoState,
	} from "../../stores/server-info.svelte.js";
	import { versionState } from "../../stores/version.svelte.js";
	import { copyToClipboard } from "../../utils/clipboard.js";
	import { featureFlags, toggleFeature } from "../../stores/feature-flags.svelte.js";
	import {
		themeState,
		getThemeLists,
		applyTheme,
	} from "../../stores/theme.svelte.js";
	import {
		type NotifSettings,
		getNotifSettings,
		saveNotifSettings,
	} from "../../utils/notif-settings.js";
	import { setPushActive } from "../../stores/ws.svelte.js";

	// ─── Props ──────────────────────────────────────────────────────────────

	let {
		visible = false,
		initialTab = "notifications",
		onClose,
	}: { visible: boolean; initialTab?: string; onClose?: () => void } =
		$props();

	// ─── Local state ────────────────────────────────────────────────────────

	let activeTab = $state("notifications");

	// Instance management
	let expandedInstanceId = $state<string | null>(null);
	let renamingInstanceId = $state<string | null>(null);
	let renameValue = $state("");
	let expandedScenario = $state<string | null>(null);
	let copiedKey = $state<string | null>(null);
	let copyTimer: ReturnType<typeof setTimeout> | null = null;

	// Notification settings
	let notifSettings: NotifSettings = $state(getNotifSettings());
	let pushBlocked = $state(
		typeof Notification !== "undefined" && Notification.permission === "denied",
	);
	let browserBlocked = $state(
		typeof Notification !== "undefined" && Notification.permission === "denied",
	);
	let pushBusy = $state(false);
	let pushError = $state("");
	const pushUnavailable =
		typeof Notification === "undefined" ||
		!("serviceWorker" in navigator) ||
		(typeof window !== "undefined" && !window.isSecureContext);

	// MCP / Credentials / Server admin state
	let credIntegrationID = $state("");
	let credKey = $state("");
	let credLabel = $state("");
	let credActivate = $state(true);
	/** MCP server being replaced via the add form (null = adding a new one). */
	let editMcpName = $state<string | null>(null);

	// ─── Derived ────────────────────────────────────────────────────────────

	const instances = $derived(getCachedInstances());
	const scanInFlight = $derived(isScanInFlight());
	const scanResult = $derived(getScanResult());
	const proxyResult = $derived(getProxyDetection());
	const ccsDetected = $derived(proxyResult?.found ?? false);
	const themeLists = $derived(getThemeLists());
	const mcpServers = $derived(mcpState.servers);
	const credentials = $derived(credentialState.credentials);
	const serverInfo = $derived(serverInfoState.info);

	const SWATCH_KEYS = ["base00", "base01", "base09", "base0B", "base0D"] as const;

	// ─── Effects ────────────────────────────────────────────────────────────

	$effect(() => {
		if (visible) {
			activeTab = initialTab;
			expandedInstanceId = null;
			renamingInstanceId = null;
			expandedScenario = null;
			editMcpName = null;
			// Only refresh notification settings if no toggle operation is
			// in progress. Reading pushBusy via untrack() avoids adding it
			// as a dependency (which would re-trigger this effect when the
			// toggle completes and cause the exact race we're preventing).
			if (!untrack(() => pushBusy)) {
				notifSettings = getNotifSettings();
			}
			startProxyDetection(wsSend);
			// Prime MCP / credential / server-info state for the new tabs.
			requestMcp(wsSend);
			requestCredentials(wsSend);
			requestServerInfo(wsSend);
		}
	});

	// Refresh the active admin tab's data when it becomes visible.
	$effect(() => {
		if (!visible) return;
		const tab = activeTab;
		if (tab === "mcp") requestMcp(wsSend);
		else if (tab === "integrations") requestIntegrations(wsSend);
		else if (tab === "plugins") requestPlugins(wsSend);
		else if (tab === "providers") requestCredentials(wsSend);
		else if (tab === "server") requestServerInfo(wsSend);
	});

	// ─── Instance handlers ──────────────────────────────────────────────────

	function handleToggleInstance(instanceId: string) {
		expandedInstanceId = expandedInstanceId === instanceId ? null : instanceId;
		if (expandedInstanceId !== instanceId) renamingInstanceId = null;
	}
	function handleStart(instanceId: string) { wsSend({ type: "instance_start", instanceId }); }
	function handleStop(instanceId: string) { wsSend({ type: "instance_stop", instanceId }); }
	async function handleRemove(instanceId: string, instanceName: string) {
		const confirmed = await confirm(`Remove instance "${instanceName}"? This cannot be undone.`);
		if (confirmed) wsSend({ type: "instance_remove", instanceId });
	}
	function handleScanNow() { triggerScan(wsSend); }
	function startRename(instanceId: string, currentName: string) {
		renamingInstanceId = instanceId;
		renameValue = currentName;
	}
	function submitRename() {
		if (!renamingInstanceId) return;
		const trimmed = renameValue.trim();
		if (!trimmed) { showToast("Instance name cannot be empty", { variant: "warn" }); return; }
		wsSend({ type: "instance_rename", instanceId: renamingInstanceId, name: trimmed });
		renamingInstanceId = null;
	}
	function cancelRename() { renamingInstanceId = null; }
	function handleRenameKeydown(e: KeyboardEvent) {
		if (e.key === "Enter") { e.preventDefault(); submitRename(); }
		else if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
	}
	async function handleCopy(text: string, key: string) {
		const ok = await copyToClipboard(text);
		if (ok) {
			copiedKey = key;
			if (copyTimer) clearTimeout(copyTimer);
			copyTimer = setTimeout(() => { copiedKey = null; copyTimer = null; }, 2000);
		} else { showToast("Failed to copy — clipboard unavailable", { variant: "warn" }); }
	}
	function toggleScenario(id: string) { expandedScenario = expandedScenario === id ? null : id; }

	// ─── MCP handlers ───────────────────────────────────────────────────────

	function handleMcpConnect(server: string) { connectMcp(wsSend, server); }
	function handleMcpDisconnect(server: string) { disconnectMcp(wsSend, server); }
	function handleMcpEdit(server: string) {
		editMcpName = server;
		// Ensure the form is visible on small screens by scrolling to it.
		document
			.getElementById("mcp-add-form")
			?.scrollIntoView({ block: "nearest", behavior: "smooth" });
	}
	async function handleMcpRemove(server: string) {
		const confirmed = await confirm(`Remove MCP server "${server}"? This cannot be undone.`);
		if (confirmed) removeMcp(wsSend, server);
		if (editMcpName === server) editMcpName = null;
	}

	// ─── Credential handlers ────────────────────────────────────────────────

	function submitCredential() {
		if (!credIntegrationID.trim() || !credKey.trim()) {
			showToast("Integration and key are required", { variant: "warn" });
			return;
		}
		createApiKeyCredential(wsSend, {
			integrationID: credIntegrationID,
			key: credKey,
			label: credLabel,
			activate: credActivate,
		});
		credIntegrationID = "";
		credKey = "";
		credLabel = "";
	}
	function handleActivateCredential(id: string) { activateCredential(wsSend, id); }
	async function handleDeleteCredential(id: string, label: string) {
		const confirmed = await confirm(`Remove credential "${label || id}"? This cannot be undone.`);
		if (confirmed) deleteCredential(wsSend, id);
	}

	// ─── Server handlers ────────────────────────────────────────────────────

	function handleReloadConfig() {
		reloadConfig(wsSend);
		// Refresh the shown identity shortly after the rebuild settles.
		setTimeout(() => requestServerInfo(wsSend), 1500);
	}

	// ─── Notification handlers ──────────────────────────────────────────────

	async function togglePush(): Promise<void> {
		if (pushBusy) return;
		pushBusy = true;
		pushError = "";
		try {
			if (!notifSettings.push) {
				if (pushUnavailable) { pushError = "Push notifications require a secure connection (HTTPS)."; return; }
				const permission = await Notification.requestPermission();
				pushBlocked = permission === "denied";
				if (permission !== "granted") return;
				const { enablePushSubscription } = await import("../../utils/notifications.js");
				await enablePushSubscription();
				notifSettings.push = true;
				saveNotifSettings(notifSettings);
				setPushActive(true);
				try {
					const swReg = await navigator.serviceWorker.getRegistration();
					if (swReg?.active) await swReg.showNotification("Push Enabled", { body: "Push notifications are now active.", tag: "opencode-push-enabled" });
				} catch { /* non-fatal */ }
			} else {
				notifSettings.push = false;
				saveNotifSettings(notifSettings);
				setPushActive(false);
				// Use getRegistration() — never hangs, unlike .ready which
				// blocks forever if the SW was evicted by the OS.
				const swReg = await navigator.serviceWorker.getRegistration();
				if (swReg?.active) {
					try { await swReg.showNotification("Push Disabled", { body: "Browser alerts will be used instead.", tag: "opencode-push-disabled" }); } catch { /* non-fatal */ }
					const sub = await swReg.pushManager.getSubscription();
					if (sub) {
						const endpoint = sub.endpoint;
						await sub.unsubscribe();
						await fetch("/api/push/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint }) });
					}
				}
			}
		} catch (err) {
			log.warn("Toggle failed:", err);
			notifSettings.push = false;
			setPushActive(false);
			pushError = err instanceof Error ? err.message : "Push notification setup failed.";
		} finally {
			saveNotifSettings(notifSettings);
			pushBusy = false;
		}
	}
	async function toggleBrowser(): Promise<void> {
		const newValue = !notifSettings.browser;
		if (newValue && typeof Notification !== "undefined") {
			if (Notification.permission === "denied") { browserBlocked = true; return; }
			if (Notification.permission !== "granted") {
				const perm = await Notification.requestPermission();
				browserBlocked = perm === "denied";
				if (perm !== "granted") return;
			}
			try { const n = new Notification("Browser Alerts Enabled", { body: "You will be notified when tasks complete.", tag: "opencode-browser-test" }); setTimeout(() => n.close(), 5000); } catch { /* */ }
		}
		notifSettings.browser = newValue;
		saveNotifSettings(notifSettings);
	}
	function toggleSound(): void {
		notifSettings.sound = !notifSettings.sound;
		saveNotifSettings(notifSettings);
	}

	// ─── Backdrop / escape ──────────────────────────────────────────────────

	function handleBackdropClick(e: MouseEvent) {
		if (e.target === e.currentTarget) onClose?.();
	}
	$effect(() => {
		if (!visible) return;
		function handleKeydown(e: KeyboardEvent) { if (e.key === "Escape") onClose?.(); }
		document.addEventListener("keydown", handleKeydown);
		return () => document.removeEventListener("keydown", handleKeydown);
	});
</script>

<!-- ─── Copyable command block snippet ────────────────────────────────────── -->
{#snippet cmdBlock(cmd: string, key: string)}
	<div class="group/cmd flex items-start gap-1.5 bg-black/[0.04] dark:bg-white/[0.06] rounded px-2.5 py-1.5 font-mono text-xs text-text leading-relaxed">
		<span class="flex-1 whitespace-pre-wrap break-all select-all">{cmd}</span>
		<button type="button" class="shrink-0 p-0.5 text-text-muted hover:text-text opacity-0 group-hover/cmd:opacity-100 transition-opacity cursor-pointer" title="Copy" onclick={() => handleCopy(cmd, key)}>
			{#if copiedKey === key}<Icon name="check" size={13} class="text-green-500" />{:else}<Icon name="copy" size={13} />{/if}
		</button>
	</div>
{/snippet}

{#if visible}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="fixed inset-0 z-[200] flex items-center justify-center bg-[rgba(var(--overlay-rgb),0.15)] backdrop-blur-sm" onclick={handleBackdropClick}>
		<div id="settings-panel" class="bg-bg border border-border rounded-xl shadow-2xl max-w-lg w-full mx-4 flex flex-col max-h-[80vh] max-md:max-w-none max-md:mx-0 max-md:h-full max-md:max-h-none max-md:rounded-none">
			<!-- Header -->
			<div class="flex items-center justify-between px-5 py-3 border-b border-border">
				<h2 class="text-lg font-semibold text-text font-brand">Settings</h2>
				<button class="text-text-muted hover:text-text p-1 cursor-pointer border-none bg-transparent" onclick={() => onClose?.()}>
					<Icon name="x" size={16} />
				</button>
			</div>

			<!-- Tabs -->
			<div class="flex border-b border-border px-5 gap-1 font-brand overflow-x-auto [scrollbar-width:none]">
				{#each [
					{ id: "notifications", label: "Alerts" },
					{ id: "appearance", label: "Theme" },
					{ id: "instances", label: "Instances" },
					{ id: "mcp", label: "MCP" },
					{ id: "integrations", label: "Integrations" },
					{ id: "plugins", label: "Plugins" },
					{ id: "providers", label: "Providers" },
					{ id: "server", label: "Server" },
					{ id: "debug", label: "Debug" },
				] as tab}
					<button
						class="px-3 min-h-[44px] text-sm font-medium border-b-2 -mb-px transition-colors cursor-pointer border-none bg-transparent shrink-0 whitespace-nowrap {activeTab === tab.id ? 'border-brand-a text-text' : 'border-transparent text-text-muted hover:text-text'}"
						style="border-bottom: 2px solid {activeTab === tab.id ? 'var(--color-brand-a)' : 'transparent'};"
						onclick={() => (activeTab = tab.id)}
					>
						{tab.label}
					</button>
				{/each}
			</div>

			<!-- Tab content -->
			<div class="flex-1 overflow-y-auto p-5">

				<!-- ═══ Notifications ═══ -->
				{#if activeTab === "notifications"}
					<div class="space-y-2">
						<ToggleSetting
							icon="smartphone"
							label="Push notifications"
							description="Receive push notifications even when the tab is closed"
							checked={notifSettings.push}
							onchange={togglePush}
							disabled={pushBusy || pushUnavailable}
							dimmed={pushUnavailable}
							class="bg-bg-surface border border-border rounded-[10px] px-5 py-4 gap-4 font-brand {pushBusy || pushUnavailable ? 'opacity-60' : ''}"
						/>
						<ToggleSetting
							icon="bell"
							label="Browser alerts"
							description="Show desktop notifications when tasks complete"
							checked={notifSettings.browser}
							onchange={toggleBrowser}
							class="bg-bg-surface border border-border rounded-[10px] px-5 py-4 gap-4 font-brand"
						/>
						<ToggleSetting
							icon="volume-2"
							label="Sound"
							description="Play a sound when notifications are triggered"
							checked={notifSettings.sound}
							onchange={toggleSound}
							class="bg-bg-surface border border-border rounded-[10px] px-5 py-4 gap-4 font-brand"
						/>
						{#if pushUnavailable}
							<div class="px-2 py-1.5 text-xs text-text-muted">Push notifications require HTTPS. Enable a certificate in the CLI settings.</div>
						{:else if pushError}
							<div class="px-2 py-1.5 text-xs text-error">{pushError}</div>
						{:else if pushBlocked}
							<div class="px-2 py-1.5 text-xs text-error">Push notifications are blocked by your browser. Update site settings to allow notifications.</div>
						{:else if browserBlocked}
							<div class="px-2 py-1.5 text-xs text-error">Browser alerts are blocked. Update site settings to allow notifications.</div>
						{/if}
					</div>

				<!-- ═══ Appearance ═══ -->
				{:else if activeTab === "appearance"}
					<div class="space-y-4">
						{#each [
							{ key: "dark", label: "Dark", items: themeLists.dark },
							{ key: "light", label: "Light", items: themeLists.light },
							{ key: "custom", label: "Custom", items: themeLists.custom },
						] as section}
							{#if section.items.length > 0}
								<div>
									<div class="text-xs font-semibold uppercase tracking-widest text-text-muted px-1 mb-2 font-brand">{section.label}</div>
									<div class="space-y-1">
										{#each section.items as { id, theme }}
											<button
												class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors cursor-pointer bg-transparent {themeState.currentThemeId === id ? 'border-brand-a bg-brand-a/5' : 'border-transparent hover:bg-bg-surface'}"
												onclick={() => applyTheme(id)}
											>
												<div class="flex gap-[2px] shrink-0">
													{#each SWATCH_KEYS as key}
														<span class="w-3 h-3 rounded-sm border border-white/10" style="background: #{theme[key]};"></span>
													{/each}
												</div>
												<span class="flex-1 text-left text-base font-brand {themeState.currentThemeId === id ? 'text-text font-medium' : 'text-text-secondary'}">
													{theme.name}
												</span>
												{#if themeState.currentThemeId === id}
													<Icon name="check" size={14} class="text-success shrink-0" />
												{/if}
											</button>
										{/each}
									</div>
								</div>
							{/if}
						{/each}
					</div>

				<!-- ═══ Instances ═══ -->
				{:else if activeTab === "instances"}
					<div class="flex items-center justify-between mb-3">
						<span class="text-xs text-text-muted font-medium uppercase tracking-wide font-brand">
							{instances.length} instance{instances.length !== 1 ? "s" : ""}
						</span>
					<button
						type="button"
					class="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded border border-border text-text-muted hover:text-text hover:border-text-muted transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed font-brand"
						data-testid="scan-now-btn"
						disabled={scanInFlight}
						onclick={handleScanNow}
					>
							<Icon name="refresh-cw" size={12} class={scanInFlight ? "animate-spin" : ""} />
							{scanInFlight ? "Scanning..." : "Scan Now"}
						</button>
					</div>

					{#if scanResult && !scanInFlight}
					<div class="mb-3 text-xs text-text-muted bg-white/[0.04] rounded px-2.5 py-1.5 font-brand">
							{#if scanResult.discovered.length > 0}
								Found {scanResult.discovered.length} new instance{scanResult.discovered.length !== 1 ? "s" : ""} on port{scanResult.discovered.length !== 1 ? "s" : ""} {scanResult.discovered.join(", ")}.
							{:else if scanResult.lost.length > 0}
								{scanResult.lost.length} instance{scanResult.lost.length !== 1 ? "s" : ""} lost (port{scanResult.lost.length !== 1 ? "s" : ""} {scanResult.lost.join(", ")}).
							{:else if scanResult.active.length > 0}
								{scanResult.active.length} active instance{scanResult.active.length !== 1 ? "s" : ""} on port{scanResult.active.length !== 1 ? "s" : ""} {scanResult.active.join(", ")} (no changes).
							{:else}
								No active instances found.
							{/if}
						</div>
					{/if}

					{#if instances.length > 0}
					<div id="instance-settings-list" class="space-y-1 font-brand">
							{#each instances as inst}
								<div class="border border-border rounded-lg">
									<button class="flex items-center justify-between w-full px-3 py-2 text-left text-sm hover:bg-white/[0.03] cursor-pointer bg-transparent border-none" onclick={() => handleToggleInstance(inst.id)}>
										<div class="flex items-center gap-2 min-w-0">
											<span class={"w-2 h-2 rounded-full shrink-0 " + instanceStatusColor(inst.status)}></span>
											{#if renamingInstanceId === inst.id}
												<!-- svelte-ignore a11y_autofocus -->
												<input type="text" class="px-1.5 py-0.5 text-sm border border-accent rounded bg-bg text-text w-36" bind:value={renameValue} onkeydown={handleRenameKeydown} onclick={(e) => e.stopPropagation()} onfocusout={submitRename} autofocus />
											{:else}
												<span class="font-medium text-text truncate">{inst.name}</span>
											{/if}
											{#if !inst.managed}
												<span class="text-xs text-text-muted bg-white/[0.08] px-1.5 py-0.5 rounded-full">discovered</span>
											{/if}
										</div>
										<span class="text-text-muted text-xs shrink-0 ml-2">:{inst.port}</span>
									</button>
									{#if expandedInstanceId === inst.id}
										<div class="flex flex-wrap gap-2 px-3 py-2 border-t border-border">
											{#if inst.managed}
												<button class="px-3 py-1 text-xs rounded border border-border text-text hover:bg-white/[0.05] cursor-pointer bg-transparent" onclick={() => handleStart(inst.id)}>Start</button>
												<button class="px-3 py-1 text-xs rounded border border-border text-text hover:bg-white/[0.05] cursor-pointer bg-transparent" onclick={() => handleStop(inst.id)}>Stop</button>
											{/if}
											<button class="px-3 py-1 text-xs rounded border border-border text-accent hover:bg-accent/10 cursor-pointer bg-transparent" data-testid="rename-instance-btn" onclick={() => startRename(inst.id, inst.name)}>Rename</button>
											<button class="px-3 py-1 text-xs rounded border border-red-700 text-red-500 hover:bg-red-500/10 cursor-pointer bg-transparent" onclick={() => handleRemove(inst.id, inst.name)}>Remove</button>
										</div>
									{/if}
								</div>
							{/each}
						</div>
					{/if}

					{#if instances.length === 0}
					<div class="mt-2 space-y-2 font-brand">
							<p class="text-sm text-text-muted mb-3">No OpenCode instances detected. Start one from your terminal and it will appear here automatically.</p>
							<div class="border border-border rounded-lg overflow-hidden">
								<button type="button" class="flex items-center gap-2 w-full px-3 py-2.5 text-left text-sm font-medium text-text hover:bg-white/[0.03] cursor-pointer bg-transparent border-none" onclick={() => toggleScenario("direct")}>
									<Icon name={expandedScenario === "direct" ? "chevron-down" : "chevron-right"} size={14} class="text-text-muted shrink-0" />
									<span>Quick Start — Direct API Key</span>
								</button>
								{#if expandedScenario === "direct"}
									<div class="px-3 pb-3 space-y-2 border-t border-border pt-2.5">
										<p class="text-xs text-text-muted">1. Start an OpenCode server:</p>
										{@render cmdBlock("opencode serve --port 4098", "direct-1")}
										<p class="text-xs text-text-muted">2. Configure your provider:</p>
										{@render cmdBlock("opencode config set provider anthropic\nopencode config set anthropic.apiKey sk-ant-...", "direct-2")}
										<p class="text-xs text-text-muted italic">It will appear here automatically.</p>
									</div>
								{/if}
							</div>
							<div class="border border-border rounded-lg overflow-hidden">
								<button type="button" class="flex items-center gap-2 w-full px-3 py-2.5 text-left text-sm font-medium text-text hover:bg-white/[0.03] cursor-pointer bg-transparent border-none" onclick={() => toggleScenario("ccs")}>
									<Icon name={expandedScenario === "ccs" ? "chevron-down" : "chevron-right"} size={14} class="text-text-muted shrink-0" />
									<span>Multi-Provider — Via CCS</span>
									{#if ccsDetected}<Icon name="circle-check" size={14} class="text-green-500 ml-auto shrink-0" />{:else if proxyResult === null}<span class="text-xs text-text-muted animate-pulse ml-auto">detecting...</span>{/if}
								</button>
								{#if expandedScenario === "ccs"}
									<div class="px-3 pb-3 space-y-2 border-t border-border pt-2.5">
										<p class="text-xs text-text-muted">CCS manages OAuth tokens and API keys for 20+ providers.</p>
										{#if ccsDetected}
											<div class="flex items-center gap-1.5 text-xs text-green-400 bg-green-500/10 rounded px-2 py-1"><Icon name="circle-check" size={12} />CCS detected on port {proxyResult?.port ?? 8317}</div>
										{/if}
										<p class="text-xs text-text-muted">1. Install CCS:</p>
										{@render cmdBlock("npm install -g @anthropic-ai/ccs", "ccs-1")}
										<p class="text-xs text-text-muted">2. Authenticate:</p>
										{@render cmdBlock("ccs claude --auth", "ccs-2")}
										<p class="text-xs text-text-muted">3. Start proxy:</p>
										{@render cmdBlock("ccs cliproxy start", "ccs-3")}
										<p class="text-xs text-text-muted">4. Start OpenCode:</p>
										{@render cmdBlock('ANTHROPIC_API_KEY="ccs-internal-managed" \\\n  ANTHROPIC_BASE_URL="http://127.0.0.1:8317/api/provider/claude/v1" \\\n  opencode serve --port 4098', "ccs-4")}
									</div>
								{/if}
							</div>
							<div class="border border-border rounded-lg overflow-hidden">
								<button type="button" class="flex items-center gap-2 w-full px-3 py-2.5 text-left text-sm font-medium text-text hover:bg-white/[0.03] cursor-pointer bg-transparent border-none" onclick={() => toggleScenario("custom")}>
									<Icon name={expandedScenario === "custom" ? "chevron-down" : "chevron-right"} size={14} class="text-text-muted shrink-0" />
									<span>Custom Setup</span>
								</button>
								{#if expandedScenario === "custom"}
									<div class="px-3 pb-3 space-y-2 border-t border-border pt-2.5">
										<p class="text-xs text-text-muted">Configure with environment variables:</p>
										{@render cmdBlock("ANTHROPIC_API_KEY=sk-ant-... opencode serve --port 4098", "custom-1")}
									</div>
								{/if}
							</div>
							<div class="flex items-center justify-center gap-2 pt-2 text-xs text-text-muted">
								<span>Already started?</span>
								<button type="button" class="text-accent hover:text-accent font-medium cursor-pointer border-none bg-transparent" data-testid="scan-now-link" onclick={handleScanNow}>{scanInFlight ? "Scanning..." : "Scan Now"}</button>
							</div>
						</div>
					{/if}

				<!-- ═══ MCP Servers ═══ -->
				{:else if activeTab === "mcp"}
					<div class="flex items-center justify-between mb-3">
						<span class="text-xs text-text-muted font-medium uppercase tracking-wide font-brand">
							{mcpServers.length} server{mcpServers.length !== 1 ? "s" : ""}
						</span>
						<button
							type="button"
							class="flex items-center gap-1.5 px-2.5 min-h-[36px] text-xs rounded border border-border text-text-muted hover:text-text hover:border-text-muted transition-colors cursor-pointer font-brand"
							data-testid="mcp-refresh-btn"
							onclick={() => requestMcp(wsSend)}
						>
							<Icon name="refresh-cw" size={12} />
							Refresh
						</button>
					</div>

					{#if mcpServers.length > 0}
						<div id="mcp-server-list" class="space-y-1 font-brand">
							{#each mcpServers as server (server.name)}
								<div class="border border-border rounded-lg px-3 py-2.5" data-testid="mcp-server-row">
									<div class="flex items-center gap-2 min-w-0">
										<span class={"w-2 h-2 rounded-full shrink-0 " + mcpStatusColor(server)}></span>
										<span class="font-medium text-text truncate">{server.name}</span>
										<span class="text-xs text-text-muted ml-auto shrink-0">{mcpStatusLabel(server)}</span>
									</div>
									{#if server.integrationID}
										<div class="mt-1 text-xs text-text-muted truncate">integration: {server.integrationID}</div>
									{/if}
									{#if server.status?.status === "failed" || server.status?.status === "needs_auth"}
										<div class="mt-1 text-xs text-error break-words">{server.status.error}</div>
									{/if}
									<div class="flex flex-wrap gap-2 mt-2">
										{#if mcpCanConnect(server)}
											<button
												class="px-3 min-h-[36px] text-xs rounded border border-border text-text hover:bg-white/[0.05] cursor-pointer bg-transparent"
												data-testid="mcp-connect-btn"
												onclick={() => handleMcpConnect(server.name)}
											>Connect</button>
										{/if}
										{#if mcpCanDisconnect(server)}
											<button
												class="px-3 min-h-[36px] text-xs rounded border border-border text-text hover:bg-white/[0.05] cursor-pointer bg-transparent"
												data-testid="mcp-disconnect-btn"
												onclick={() => handleMcpDisconnect(server.name)}
											>Disconnect</button>
										{/if}
										<button
											class="px-3 min-h-[36px] text-xs rounded border border-border text-accent hover:bg-accent/10 cursor-pointer bg-transparent"
											data-testid="mcp-edit-btn"
											onclick={() => handleMcpEdit(server.name)}
										>Edit</button>
										<button
											class="px-3 min-h-[36px] text-xs rounded border border-red-700 text-red-500 hover:bg-red-500/10 cursor-pointer bg-transparent"
											data-testid="mcp-remove-btn"
											onclick={() => handleMcpRemove(server.name)}
										>Remove</button>
									</div>
								</div>
							{/each}
						</div>
					{:else}
						<div class="text-sm text-text-muted font-brand mb-4">
							No MCP servers configured. Add one below, or configure servers in your OpenCode config.
						</div>
					{/if}

					<div class="mt-3">
						<McpAddForm editName={editMcpName} onDone={() => (editMcpName = null)} />
					</div>

				<!-- ═══ Integrations ═══ -->
				{:else if activeTab === "integrations"}
					<IntegrationsPanel onClose={onClose} />

				<!-- ═══ Plugins ═══ -->
				{:else if activeTab === "plugins"}
					<PluginsPanel />

				<!-- ═══ Provider Credentials ═══ -->
				{:else if activeTab === "providers"}
					{#if credentials.length > 0}
						<div id="credential-list" class="space-y-1 font-brand mb-4">
							{#each credentials as cred (cred.id)}
								<div class="flex items-center gap-2 border border-border rounded-lg px-3 py-2.5" data-testid="credential-row">
									<div class="min-w-0 flex-1">
										<div class="flex items-center gap-2 min-w-0">
											<span class="font-medium text-text truncate">{cred.label || cred.integrationID}</span>
											{#if cred.active}
												<span class="text-[10px] uppercase tracking-wide text-success border border-success/40 rounded px-1 py-0.5 shrink-0">Active</span>
											{/if}
										</div>
										<div class="text-xs text-text-muted truncate">{cred.integrationID} · {credentialValueSummary(cred)}</div>
									</div>
									{#if !cred.active}
										<button
											class="px-2.5 min-h-[36px] text-xs rounded border border-border text-text hover:bg-white/[0.05] cursor-pointer bg-transparent shrink-0"
											data-testid="credential-activate-btn"
											onclick={() => handleActivateCredential(cred.id)}
										>Activate</button>
									{/if}
									<button
										class="px-2.5 min-h-[36px] text-xs rounded border border-red-700 text-red-500 hover:bg-red-500/10 cursor-pointer bg-transparent shrink-0"
										data-testid="credential-delete-btn"
										onclick={() => handleDeleteCredential(cred.id, cred.label || cred.integrationID)}
									>Delete</button>
								</div>
							{/each}
						</div>
					{:else}
						<div class="text-sm text-text-muted font-brand mb-4">
							No provider credentials stored.
						</div>
					{/if}

					<div class="border border-border rounded-lg p-3 space-y-2 font-brand">
						<div class="text-xs font-semibold uppercase tracking-widest text-text-muted">Add API key</div>
						<input
							type="text"
							placeholder="Integration (e.g. anthropic)"
							class="w-full px-2.5 min-h-[40px] text-sm border border-border rounded bg-bg text-text placeholder:text-text-muted"
							data-testid="credential-integration-input"
							bind:value={credIntegrationID}
						/>
						<input
							type="password"
							placeholder="API key"
							autocomplete="off"
							class="w-full px-2.5 min-h-[40px] text-sm border border-border rounded bg-bg text-text placeholder:text-text-muted"
							data-testid="credential-key-input"
							bind:value={credKey}
						/>
						<input
							type="text"
							placeholder="Label (optional)"
							class="w-full px-2.5 min-h-[40px] text-sm border border-border rounded bg-bg text-text placeholder:text-text-muted"
							data-testid="credential-label-input"
							bind:value={credLabel}
						/>
						<label class="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
							<input type="checkbox" class="accent-[var(--color-brand-a)]" bind:checked={credActivate} />
							Make active
						</label>
						<button
							type="button"
							class="w-full min-h-[44px] text-sm rounded border border-border text-text hover:bg-white/[0.05] cursor-pointer bg-transparent disabled:opacity-50 disabled:cursor-not-allowed"
							data-testid="credential-add-btn"
							disabled={!credIntegrationID.trim() || !credKey.trim()}
							onclick={submitCredential}
						>Add credential</button>
					</div>

				<!-- ═══ Server ═══ -->
				{:else if activeTab === "server"}
					<div class="space-y-3 font-brand">
						<div class="bg-bg-surface border border-border rounded-[10px] px-5 py-4 space-y-1.5">
							<div class="flex items-center justify-between gap-2">
								<span class="text-sm text-text-secondary">OpenCode server</span>
								<span class="text-sm text-text font-mono" data-testid="server-version">
									{serverInfo ? `v${serverInfo.version}` : serverInfoState.loaded ? "unknown" : "…"}
								</span>
							</div>
							{#if serverInfo}
								<div class="flex items-center justify-between gap-2">
									<span class="text-xs text-text-muted">PID</span>
									<span class="text-xs text-text-muted font-mono">{serverInfo.pid}</span>
								</div>
								{#each serverInfo.urls as url}
									<div class="text-xs text-text-muted truncate font-mono">{url}</div>
								{/each}
							{/if}
							<div class="flex items-center justify-between gap-2 pt-1 border-t border-border-subtle">
								<span class="text-sm text-text-secondary">Conduit</span>
								<span class="text-sm text-text font-mono" data-testid="conduit-version">
									{versionState.current ? `v${versionState.current}` : "unknown"}
								</span>
							</div>
						</div>

						<button
							type="button"
							class="flex items-center gap-2 w-full min-h-[44px] px-3 text-sm rounded-lg border border-border text-text hover:bg-white/[0.05] cursor-pointer bg-transparent"
							data-testid="reload-config-btn"
							onclick={handleReloadConfig}
						>
							<Icon name="refresh-cw" size={14} />
							Reload configuration
						</button>
						<p class="text-xs text-text-muted">
							Rebuilds every loaded OpenCode location. Running sessions continue at the next step boundary.
						</p>
					</div>

				<!-- ═══ Debug ═══ -->
				{:else if activeTab === "debug"}
					<div class="space-y-2">
						<ToggleSetting
							label="Connection debug panel"
							description="Shows WebSocket state transitions, timing, and lifecycle events."
							checked={featureFlags.debug}
							onchange={() => toggleFeature("debug")}
							class="bg-bg-surface border border-border rounded-[10px] px-5 py-4 gap-4 font-brand"
						/>
						<div class="text-xs text-text-dimmer space-y-1.5 px-1 font-brand">
							<div>URL param: <code class="px-1 py-0.5 bg-white/[0.08] rounded text-text-muted">?feats=debug</code></div>
							<div>Keyboard: <kbd class="px-1.5 py-0.5 bg-white/[0.08] rounded text-text-muted border border-border/50">Ctrl+Shift+D</kbd></div>
						</div>
					</div>
				{/if}
			</div>
		</div>
	</div>
{/if}
