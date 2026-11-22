<!-- ─── Paste Preview ──────────────────────────────────────────────────────── -->
<!-- Horizontal row of pending attachments: image thumbnails plus icon+name -->
<!-- chips for arbitrary files. Purely client-side display.                  -->

<script lang="ts">
	import Icon from "../shared/Icon.svelte";
	import type { PendingAttachment } from "../../types.js";
	import { formatFileSize } from "../../utils/format.js";

	let {
		attachments,
		onRemove,
	}: {
		attachments: PendingAttachment[];
		onRemove: (id: string) => void;
	} = $props();

	const hasAttachments = $derived(attachments.length > 0);

	/** Truncate a name for display under the thumbnail / on the chip. */
	function truncateName(name: string, maxLen = 20): string {
		if (name.length <= maxLen) return name;
		return `${name.slice(0, maxLen)}\u2026`;
	}
</script>

{#if hasAttachments}
	<div id="image-preview">
		<div
			class="paste-preview-bar flex items-center gap-2 px-4 py-2 overflow-x-auto max-h-[90px] border-t border-border-subtle bg-bg-surface"
			style="-webkit-overflow-scrolling: touch"
		>
			{#each attachments as attachment (attachment.id)}
				{#if attachment.kind === "image"}
					<div
						class="paste-thumb group relative shrink-0 w-[60px] h-[60px] rounded-lg overflow-hidden border border-border bg-bg-alt"
						data-image-id={attachment.id}
					>
						<img
							src={attachment.dataUrl}
							alt={attachment.name}
							class="w-full h-full object-cover block"
						/>
						<button
							class="paste-remove-btn absolute top-0.5 right-0.5 w-[18px] h-[18px] border-none rounded-full bg-[rgba(0,0,0,0.6)] text-white text-sm leading-none flex items-center justify-center cursor-pointer opacity-0 transition-opacity duration-150 group-hover:opacity-100"
							title="Remove image"
							onclick={(e: MouseEvent) => {
								e.preventDefault();
								e.stopPropagation();
								onRemove(attachment.id);
							}}
						>
							&#x2715;
						</button>
						<span
							class="paste-thumb-name absolute bottom-0 left-0 right-0 text-xs leading-[1.2] text-white bg-[rgba(0,0,0,0.55)] px-[3px] py-px text-center overflow-hidden text-ellipsis whitespace-nowrap"
						>
							{truncateName(attachment.name)}
						</span>
					</div>
				{:else}
					<div
						class="paste-file-chip group relative flex items-center gap-2 shrink-0 max-w-[220px] h-[60px] px-2.5 rounded-lg border border-border bg-bg-alt"
						data-file-id={attachment.id}
						title="{attachment.name} ({formatFileSize(attachment.size)})"
					>
						<Icon name="file" size={20} class="shrink-0 text-text-muted" />
						<div class="min-w-0 flex flex-col">
							<span class="text-xs text-text truncate">
								{truncateName(attachment.name, 24)}
							</span>
							<span class="text-[10px] text-text-muted truncate">
								{formatFileSize(attachment.size)} · {attachment.mime}
							</span>
						</div>
						<button
							class="paste-remove-btn absolute -top-1 -right-1 w-[18px] h-[18px] border-none rounded-full bg-[rgba(0,0,0,0.65)] text-white text-sm leading-none flex items-center justify-center cursor-pointer"
							title="Remove file"
							aria-label="Remove file"
							onclick={(e: MouseEvent) => {
								e.preventDefault();
								e.stopPropagation();
								onRemove(attachment.id);
							}}
						>
							&#x2715;
						</button>
					</div>
				{/if}
			{/each}
		</div>
	</div>
{/if}
