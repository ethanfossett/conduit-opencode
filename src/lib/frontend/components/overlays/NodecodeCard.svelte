<script lang="ts">
	import { untrack } from "svelte";
	import {
		NODECODE_PROVIDER_ID,
		type NodecodeAction,
		nodecodeModel,
		nodecodePreset,
	} from "../../../nodecode.js";
	import { integrationState } from "../../stores/integration.svelte.js";
	import { sendNewSession, sessionCreation } from "../../stores/session.svelte.js";
	import { getIsConnected, wsSend } from "../../stores/ws.svelte.js";
	import { copyToClipboard } from "../../utils/clipboard.js";
	import { generateUuid } from "../../utils/format.js";

	let { onClose }: { onClose?: () => void } = $props();
	let key = $state("");
	let requestId = $state("");
	let pending = $state<NodecodeAction | null>(null);
	let feedback = $state("");
	let copied = $state(false);
	let serverVersion = $state("");
	let replacingKey = $state(false);
	const result = $derived(integrationState.nodecode?.requestId === requestId
		? integrationState.nodecode
		: null);
	const status = $derived(result?.status);
	const available = $derived(status === "model_available" || status === "test_passed");
	// A failed inference test should leave the test button available for retry.
	let canTest = $state(false);
	const secure = globalThis.isSecureContext;
	const connected = $derived(getIsConnected());
	const preset = JSON.stringify({ providers: { [NODECODE_PROVIDER_ID]: nodecodePreset } }, null, 2);

	function run(action: NodecodeAction) {
		if (pending) return;
		const id = generateUuid();
		const sent = wsSend({
			type: "nodecode_setup", action, requestId: id,
			...(action === "connect" && { key: key.trim() }),
		});
		if (!sent) {
			feedback = "Reconnect to OpenCode and try again.";
			return;
		}
		requestId = id;
		feedback = "";
		pending = action;
		if (action !== "test") canTest = false;
		if (action === "connect") key = "";
	}

	$effect(() => {
		if (connected) {
			untrack(() => {
				pending = null;
				run("status");
			});
		} else {
			pending = null;
			canTest = false;
			requestId = "";
			serverVersion = "";
		}
	});

	$effect(() => {
		if (result) {
			pending = null;
			if (result.serverVersion) serverVersion = result.serverVersion;
			if (available) {
				canTest = true;
				replacingKey = false;
				if (status === "model_available") wsSend({ type: "get_models" });
			}
		}
	});

	$effect(() => {
		if (!pending) return;
		const timer = setTimeout(() => {
			pending = null;
			requestId = "";
			feedback = "OpenCode took too long to reply. Refresh before retrying.";
		}, 45_000);
		return () => clearTimeout(timer);
	});

	async function copyPreset() {
		copied = await copyToClipboard(preset);
		if (!copied) feedback = "Couldn’t copy automatically. Select and copy the config below.";
	}

	function newChat() {
		if (sendNewSession(wsSend, nodecodeModel)) onClose?.();
	}

	const buttonStyle = "min-h-10 rounded border border-border px-3 text-xs text-text hover:bg-bg-alt disabled:opacity-50";
</script>

<section aria-labelledby="nodecode-heading" class="mb-4 space-y-3 rounded-lg border border-border bg-bg-surface p-3">
	<div class="flex items-center justify-between gap-2">
		<div>
			<h3 id="nodecode-heading" class="font-medium text-text">NodeCode · Cyber v1</h3>
			{#if serverVersion}<p class="text-xs text-text-muted">OpenCode {serverVersion}</p>{/if}
		</div>
		<button type="button" class={buttonStyle} disabled={!!pending || !connected} onclick={() => run("status")}>Refresh NodeCode</button>
	</div>

	<p role="status" class="text-xs text-text-muted">
		{#if feedback}{feedback}
		{:else if pending === "connect"}Saving key…
		{:else if pending === "test"}Waiting for a test reply…
		{:else if pending === "status"}Checking OpenCode…
		{:else if result?.message}{result.message}
		{:else if status === "needs_config"}Add the NodeCode provider to your OpenCode server.
		{:else if status === "needs_key"}Connect a regular NodeCode API key.
		{:else if status === "key_saved"}Key saved. OpenCode hasn’t listed Cyber v1 yet. Refresh to check again.
		{:else if status === "model_available"}Cyber v1 is available.
		{:else if status === "test_passed"}Test passed. Cyber v1 replied through OpenCode.
		{:else if !connected}Connect to OpenCode to check NodeCode.
		{/if}
	</p>

	{#if status === "needs_config" || status === "unsupported"}
		<details class="text-xs text-text-muted">
			<summary class="cursor-pointer">OpenCode configuration</summary>
			<p class="my-2">Merge this into the config on the machine running OpenCode. Then reload OpenCode’s configuration and refresh here.</p>
			<button type="button" class={buttonStyle} onclick={copyPreset}>{copied ? "Copied" : "Copy NodeCode config"}</button>
			<pre class="mt-2 overflow-auto rounded bg-bg-alt p-2 text-text">{preset}</pre>
		</details>
	{/if}

	{#if replacingKey || status === "needs_key" || status === "error" && !canTest}
		{#if secure}
			<form class="space-y-2" onsubmit={(event) => { event.preventDefault(); run("connect"); }}>
				<label for="nodecode-key" class="text-xs text-text-muted">NodeCode API key</label>
				<input id="nodecode-key" type="password" autocomplete="off" spellcheck="false" bind:value={key} class="block w-full rounded border border-border bg-bg p-2 text-text" />
				<button type="submit" class={buttonStyle} disabled={!key.trim() || !!pending || !connected}>Connect NodeCode</button>
			</form>
		{:else}
			<p class="text-xs text-text-muted">Open Conduit over HTTPS to enter an API key.</p>
		{/if}
		<a class="text-xs text-accent underline" href="https://nodecode.ai/account/keys" target="_blank" rel="noreferrer">Get a regular API key</a>
		<p class="text-xs text-text-muted">Free keys are restricted to NodeCode’s CLI.</p>
	{/if}

	{#if canTest || status === "key_saved"}
		<button type="button" class={buttonStyle} disabled={!!pending} onclick={() => { replacingKey = !replacingKey; key = ""; }}>{replacingKey ? "Cancel key change" : "Replace key"}</button>
	{/if}

	{#if canTest}
		<p class="text-xs text-text-muted">The connection test sends a short request using your NodeCode balance.</p>
		<div class="flex flex-wrap gap-2">
			<button type="button" class={buttonStyle} disabled={!!pending || !connected} title="Send a short request using your NodeCode balance" onclick={() => run("test")}>Test connection</button>
			<button type="button" class={buttonStyle} disabled={!!pending || !connected || sessionCreation.value.phase === "creating"} onclick={newChat}>New chat with Cyber v1</button>
		</div>
	{/if}
</section>
