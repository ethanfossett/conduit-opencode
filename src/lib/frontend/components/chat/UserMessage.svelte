<!-- ─── User Message ────────────────────────────────────────────────────────── -->
<!-- Left-aligned user message card with pink glow. Preserves .msg-user class.
     When queued, the card is dimmed and shows a shimmering "Queued" label.
     The queued visual is DERIVED from the immutable `sentDuringEpoch` fact
     and the live `turnEpoch` — no mutable flags, no clearing needed. -->

<script lang="ts">
	import { submissionState } from "../../stores/submissions.svelte.js";
	import type { UserMessage } from "../../types.js";
	import { chatState } from "../../stores/chat.svelte.js";
	import Icon from "../shared/Icon.svelte";
	import { escapeHtml, extractDisplayText, formatFileSize } from "../../utils/format.js";

	let { message }: { message: UserMessage } = $props();

	const deliveryStatus = $derived(message.submissionId ? submissionState.statuses[message.submissionId] : undefined);

	/** True while the turn that was in-progress when this message was sent
	 *  hasn't completed yet. Clears automatically when `handleDone`
	 *  increments `turnEpoch`. */
	const isQueued = $derived(
		message.sentDuringEpoch != null &&
		chatState.turnEpoch <= message.sentDuringEpoch,
	);

	// DEBUG: track all reactive inputs driving the shimmer
	$inspect(
		"[UserMessage shimmer]",
		{
			isQueued,
			turnEpoch: chatState.turnEpoch,
			sentDuringEpoch: message.sentDuringEpoch,
			currentMessageId: chatState.currentMessageId,
			phase: chatState.phase,
			text: message.text.slice(0, 40),
		},
	);
</script>

<div
	class="msg-user max-w-[760px] mx-auto mb-3 px-5"
	class:opacity-50={isQueued}
	data-uuid={message.uuid}
>
	<div
		class="bg-bg-surface rounded-[10px] py-4 px-5 relative glow-brand-a"
		class:border={isQueued}
		class:border-dashed={isQueued}
		class:border-border={isQueued}
	>
		<div class="text-sm font-mono font-semibold uppercase tracking-[1.5px] text-brand-a mb-2">You</div>
		<div class="text-base leading-[1.7] break-words whitespace-pre-wrap text-text">
			{@html escapeHtml(extractDisplayText(message.text))}
		</div>
		{#if message.attachments && message.attachments.length > 0}
			<div class="flex flex-wrap items-center gap-2 mt-2.5">
				{#each message.attachments as attachment (attachment.id)}
					{#if attachment.kind === "image"}
						<img
							src={attachment.dataUrl}
							alt={attachment.name}
							class="w-[60px] h-[60px] rounded-lg object-cover border border-border"
						/>
					{:else}
						<span
							class="flex items-center gap-1.5 max-w-[220px] px-2 py-1 rounded-md border border-border bg-bg-alt text-text-secondary"
							title="{attachment.name} ({attachment.mime})"
						>
							<Icon name="file" size={14} class="shrink-0 text-text-muted" />
							<span class="text-xs truncate">{attachment.name}</span>
							<span class="text-[10px] text-text-muted shrink-0">
								{formatFileSize(attachment.size)}
							</span>
						</span>
					{/if}
				{/each}
			</div>
		{/if}
		{#if deliveryStatus && deliveryStatus !== "accepted"}
			<p class="text-xs mt-2 text-text-muted" role="status">
				{#if deliveryStatus === "sending"}Sending…
				{:else if deliveryStatus === "failed"}Not accepted — draft retained
				{:else}Delivery unconfirmed — check history before retrying{/if}
			</p>
		{:else if isQueued}
			<div class="flex items-center mt-2">
				<span class="queued-shimmer text-text-muted text-xs font-mono">Queued</span>
			</div>
		{/if}
	</div>
</div>

<style>
	.queued-shimmer {
		background: linear-gradient(
			90deg,
			var(--color-text-muted) 0%,
			var(--color-text-secondary, #888) 50%,
			var(--color-text-muted) 100%
		);
		background-size: 200% 100%;
		-webkit-background-clip: text;
		background-clip: text;
		-webkit-text-fill-color: transparent;
		animation: shimmer 2s ease-in-out infinite;
	}

	@keyframes shimmer {
		0% { background-position: 200% 0; }
		100% { background-position: -200% 0; }
	}
</style>
