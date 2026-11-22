<!-- ─── File Menu ──────────────────────────────────────────────────────────── -->
<!-- @-mention autocomplete popup. Merges the client-side project file list   -->
<!-- with server-provided references. Filters are computed by the caller;      -->
<!-- supports keyboard navigation (ArrowUp/Down, Enter, Escape) and mouse      -->
<!-- selection.                                                                -->

<script lang="ts">
	import Icon from "../shared/Icon.svelte";
	import BlockGrid from "../shared/BlockGrid.svelte";

	// ─── Types ──────────────────────────────────────────────────────────────────

	/** Merged menu item (file/directory entry or server reference). */
	interface MenuItem {
		value: string;
		label: string;
		kind: "file" | "directory" | "reference";
		/** For file entries: path prefix before the basename. */
		pathPrefix?: string;
		basename?: string;
		description?: string;
	}

	// ─── Props ──────────────────────────────────────────────────────────────────

	let {
		query,
		visible,
		entries,
		references = [],
		onSelect,
		onClose,
		loading = false,
	}: {
		query: string;
		visible: boolean;
		entries: string[];
		references?: ReferenceMenuEntry[];
		onSelect: (value: string) => void;
		onClose: () => void;
		loading?: boolean;
	} = $props();

	// ─── State ──────────────────────────────────────────────────────────────────

	let activeIndex = $state(0);

	// ─── Derived ────────────────────────────────────────────────────────────────

	const items = $derived<MenuItem[]>([
		...entries.map((entry): MenuItem => {
			const isDir = entry.endsWith("/");
			const lastSlash = entry.lastIndexOf(
				"/",
				isDir ? entry.length - 2 : entry.length - 1,
			);
			return {
				value: entry,
				label: entry,
				kind: isDir ? "directory" : "file",
				...(lastSlash >= 0
					? {
							pathPrefix: entry.slice(0, lastSlash + 1),
							basename: entry.slice(lastSlash + 1),
						}
					: { basename: entry }),
			};
		}),
		...references.map(
			(ref): MenuItem => ({
				value: ref.value,
				label: ref.label,
				kind: "reference",
				...(ref.description !== undefined && { description: ref.description }),
			}),
		),
	]);

	const isVisible = $derived(visible && (items.length > 0 || loading));

	// ─── Reset active index when items change ───────────────────────────────────

	$effect(() => {
		void items.length;
		void query;
		activeIndex = 0;
	});

	// ─── Keyboard handling ──────────────────────────────────────────────────────

	export function handleKeydown(e: KeyboardEvent): boolean {
		if (!isVisible) return false;

		switch (e.key) {
			case "ArrowDown": {
				e.preventDefault();
				if (items.length > 0) {
					activeIndex = (activeIndex + 1) % items.length;
					scrollActiveIntoView();
				}
				return true;
			}

			case "ArrowUp": {
				e.preventDefault();
				if (items.length > 0) {
					activeIndex = (activeIndex - 1 + items.length) % items.length;
					scrollActiveIntoView();
				}
				return true;
			}

			case "Tab":
			case "Enter": {
				e.preventDefault();
				const selected = items[activeIndex];
				if (items.length > 0 && selected) {
					onSelect(selected.value);
				}
				return true;
			}

			case "Escape": {
				e.preventDefault();
				onClose();
				return true;
			}

			default:
				return false;
		}
	}

	// ─── Helpers ────────────────────────────────────────────────────────────────

	function scrollActiveIntoView(): void {
		requestAnimationFrame(() => {
			const menu = document.querySelector("#file-menu .file-menu-list");
			const activeItem = menu?.querySelector(".file-item-active");
			if (activeItem) {
				activeItem.scrollIntoView({ block: "nearest" });
			}
		});
	}
</script>

<div id="file-menu" class:hidden={!isVisible}>
	{#if isVisible}
		<div
			class="file-menu-list absolute bottom-full left-0 right-0 mb-1 bg-bg-surface border border-border rounded-xl shadow-[0_-4px_16px_rgba(0,0,0,0.3)] max-h-[300px] overflow-y-auto z-[60] py-1"
		>
			{#if loading && items.length === 0}
				<div
					class="flex items-center gap-2 py-3 px-3.5 text-text-muted text-base"
				>
					<BlockGrid cols={5} mode="fast" blockSize={1.5} gap={0.5} class="shrink-0" />
					<span>Loading files…</span>
				</div>
			{:else if items.length === 0}
				<div class="py-3 px-3.5 text-text-muted text-base">
					No files found
				</div>
			{:else}
				{#each items as item, i (item.kind + ":" + item.value)}
					<div
						class="file-item flex items-center gap-2 py-2 px-3.5 cursor-pointer transition-colors duration-100 max-sm:py-1.5 max-sm:px-2.5 max-sm:gap-1.5 {i === activeIndex ? 'file-item-active bg-accent-bg hover:bg-accent-bg' : 'hover:bg-bg-alt'}"
						data-file-index={i}
						data-entry-kind={item.kind}
						role="option"
						tabindex="-1"
						aria-selected={i === activeIndex}
						onmousedown={(e) => {
							e.preventDefault();
							onSelect(item.value);
						}}
						onmouseenter={() => {
							activeIndex = i;
						}}
					>
						{#if item.kind === "reference"}
							<Icon name="link" size={14} class="shrink-0 text-accent" />
						{:else}
							<Icon
								name={item.kind === "directory" ? "folder" : "file"}
								size={14}
								class="shrink-0 {item.kind === "directory" ? 'text-warning' : 'text-text-muted'}"
							/>
						{/if}
						<span
							class="file-path flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-base max-sm:text-xs"
						>
							{#if item.kind === "reference"}
								<span class="text-text">{item.value}</span>
								<span class="text-text-muted font-sans"> · reference</span>
							{:else if item.pathPrefix !== undefined}
								<span class="text-text-muted">{item.pathPrefix}</span
								><span class="text-text">{item.basename}</span>
							{:else}
								<span class="text-text">{item.basename}</span>
							{/if}
						</span>
						{#if item.description}
							<span
								class="shrink-0 max-w-[40%] overflow-hidden text-ellipsis whitespace-nowrap text-xs text-text-muted"
								>{item.description}</span
							>
						{/if}
					</div>
				{/each}
			{/if}
		</div>
	{/if}
</div>
