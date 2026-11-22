<!-- ─── System Prompt Modal ────────────────────────────────────────────────── -->
<!-- Per-chat custom system prompt editor. The text is appended to OpenCode's -->
<!-- own system prompt for every message sent to the active chat.            -->

<script lang="ts">
	import Icon from "../shared/Icon.svelte";
	import { discoveryState } from "../../stores/discovery.svelte.js";
	import { sessionState } from "../../stores/session.svelte.js";
	import { wsSend } from "../../stores/ws.svelte.js";

	// ─── Props ──────────────────────────────────────────────────────────────────

	let {
		visible = false,
		onClose,
	}: { visible: boolean; onClose?: () => void } = $props();

	// ─── State ──────────────────────────────────────────────────────────────────

	let draft = $state("");
	/** Plain (non-reactive) marker of the chat the draft was seeded from. */
	let seededKey = "";

	// Seed the editor from the active chat's prompt when the modal opens, or
	// when the active chat changes while it is open. Re-seeding stops once the
	// user starts editing (key no longer changes).
	$effect(() => {
		if (!visible) {
			seededKey = "";
			return;
		}
		const id = sessionState.currentId ?? "";
		if (id !== seededKey) {
			seededKey = id;
			draft = discoveryState.systemPrompt;
		}
	});

	const hasSession = $derived(!!sessionState.currentId);
	const dirty = $derived(draft.trim() !== discoveryState.systemPrompt.trim());

	// ─── Handlers ───────────────────────────────────────────────────────────────

	function close() {
		onClose?.();
	}

	function save() {
		if (!hasSession) return;
		wsSend({
			type: "set_system_prompt",
			text: draft,
			sessionId: sessionState.currentId ?? undefined,
		});
		close();
	}

	function clear() {
		draft = "";
		if (hasSession) {
			wsSend({
				type: "set_system_prompt",
				text: "",
				sessionId: sessionState.currentId ?? undefined,
			});
		}
		close();
	}

	function handleBackdropClick(e: MouseEvent) {
		if (e.target === e.currentTarget) close();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "Escape") close();
		if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
	}
</script>

<svelte:window onkeydown={visible ? handleKeydown : undefined} />

{#if visible}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		id="system-prompt-modal"
		class="modal-backdrop fixed inset-0 bg-[rgba(var(--overlay-rgb),0.5)] backdrop-blur-[2px] flex items-center justify-center z-[300] transition-opacity duration-200 ease-linear"
		onclick={handleBackdropClick}
	>
		<div
			class="modal-dialog bg-bg-alt border border-border rounded-xl p-5 w-[92%] max-w-lg shadow-[0_8px_32px_rgba(var(--shadow-rgb),0.4)]"
		>
			<div class="flex items-center gap-2 mb-1">
				<Icon name="file-text" size={15} class="text-text-muted shrink-0" />
				<h2 class="text-sm font-semibold text-text">System prompt</h2>
			</div>
			<p class="text-xs text-text-dimmer leading-normal mb-3">
				Appended to this chat's system prompt on every message.
			</p>

			<textarea
				id="system-prompt-input"
				rows="8"
				spellcheck="false"
				placeholder="You are a helpful assistant&hellip;"
				class="w-full box-border bg-bg border border-border rounded-lg text-text text-sm font-mono leading-normal p-2.5 resize-y outline-none min-h-[120px] max-h-[50vh] placeholder:text-text-muted focus:border-accent"
				bind:value={draft}
				disabled={!hasSession}
			></textarea>

			{#if !hasSession}
				<p class="text-xs text-text-dimmer mt-2">
					Open or create a chat to set its system prompt.
				</p>
			{/if}

			<div class="flex items-center justify-between gap-2 mt-4">
				<button
					type="button"
					class="bg-transparent border border-border text-text-muted rounded-lg py-1.5 px-3 text-sm cursor-pointer hover:bg-[rgba(var(--overlay-rgb),0.05)] disabled:opacity-40 disabled:cursor-default"
					onclick={clear}
					disabled={!hasSession || draft.length === 0}
				>
					Clear
				</button>
				<div class="flex gap-2">
					<button
						type="button"
						class="bg-transparent border border-border text-text-muted rounded-lg py-1.5 px-4 text-sm cursor-pointer hover:bg-[rgba(var(--overlay-rgb),0.05)]"
						onclick={close}
					>
						Cancel
					</button>
					<button
						type="button"
						class="bg-accent border-none text-bg rounded-lg py-1.5 px-4 text-sm font-medium cursor-pointer hover:bg-accent-hover disabled:opacity-40 disabled:cursor-default"
						onclick={save}
						disabled={!hasSession || !dirty}
					>
						Save
					</button>
				</div>
			</div>
		</div>
	</div>
{/if}
