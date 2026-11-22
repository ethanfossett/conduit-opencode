<script lang="ts">
	let { conversation = false, retry }: { conversation?: boolean; retry?: () => void } = $props();
</script>

<section class="display-recovery flex-1 min-h-0 overflow-auto p-6 text-text bg-bg" role="alert">
	<div class="max-w-lg mx-auto py-8">
		<h1 class="text-xl font-semibold mb-3">{conversation ? "Conversation display paused" : "Conduit hit a display error"}</h1>
		<p class="text-text-muted mb-4">{conversation ? "Your composer and terminal are still available. Try displaying the conversation again, or switch sessions." : "Reload Conduit to reconnect to your session. Saved drafts remain on this device."}</p>
		<p class="text-text-muted mb-4">Reloading does not submit your prompt again.</p>
		<div class="flex flex-wrap gap-3">
			{#if retry}<button class="px-4 py-2 rounded bg-accent text-bg font-medium" onclick={retry}>Try displaying again</button>{/if}
			<button class="px-4 py-2 rounded border border-border" onclick={() => window.location.reload()}>Reload Conduit</button>
			<a class="px-4 py-2 underline" href="/">Open projects</a>
		</div>
	</div>
</section>
