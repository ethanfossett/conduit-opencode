<!-- ─── Model Variant Picker ─────────────────────────────────────────────── -->
<!-- Thinking level badge + dropdown for cycling model variants. -->
<!-- Manages its own dropdown state, outside-click, and Ctrl+T shortcut. -->

<script lang="ts">
	import Icon from "../shared/Icon.svelte";
	import { clickOutside } from "../shared/use-click-outside.svelte.js";
	import {
		discoveryState,
		getActiveModelVariants,
	} from "../../stores/discovery.svelte.js";
	import { sessionState } from "../../stores/session.svelte.js";
	import { wsSend } from "../../stores/ws.svelte.js";

	// ─── Props ──────────────────────────────────────────────────────────────────

	let { onOpen }: { onOpen?: () => void } = $props();

	// ─── State ──────────────────────────────────────────────────────────────────

	let variantDropdownOpen = $state(false);
	let lockMenu = $state<null | "prime" | "subagent">(null);

	// ─── Derived ────────────────────────────────────────────────────────────────

	/** Available variants for the active model. */
	const variants = $derived(getActiveModelVariants());

	/** Current variant label. */
	const currentVariant = $derived(discoveryState.currentVariant);

	/** Display label for the variant badge. */
	const variantLabel = $derived(currentVariant || "default");

	// ─── Handlers ───────────────────────────────────────────────────────────────

	function toggleVariantDropdown(e: MouseEvent) {
		e.stopPropagation();
		onOpen?.();
		variantDropdownOpen = !variantDropdownOpen;
	}

	function selectVariant(variant: string, e: MouseEvent) {
		e.stopPropagation();
		wsSend({ type: "switch_variant", variant, sessionId: sessionState.currentId ?? undefined });
		discoveryState.currentVariant = variant;
		variantDropdownOpen = false;
	}

	function cycleVariant() {
		// Cycle: default → low → medium → high → max → default
		const cycle = ["", ...variants];
		const currentIdx = cycle.indexOf(currentVariant);
		const nextIdx = (currentIdx + 1) % cycle.length;
		// biome-ignore lint/style/noNonNullAssertion: index is always valid (modulo cycle.length)
		const next = cycle[nextIdx]!;
		wsSend({ type: "switch_variant", variant: next, sessionId: sessionState.currentId ?? undefined });
		discoveryState.currentVariant = next;
	}

	/** Lock or unlock a scope at an explicit strength ("" = unlock). */
	function chooseLock(
		scope: "prime" | "subagent",
		variant: string,
		e: MouseEvent,
	) {
		e.stopPropagation();
		if (!discoveryState.currentModelId || !discoveryState.currentProviderId) return;
		wsSend({
			type: "set_variant_lock",
			provider: discoveryState.currentProviderId,
			model: discoveryState.currentModelId,
			scope,
			locked: variant !== "",
			variant,
			...(scope === "prime" && sessionState.currentId
				? { sessionId: sessionState.currentId }
				: {}),
		});
		lockMenu = null;
	}

	/** Set/clear the model-level default strength (used for new chats). */
	function setModelDefault(variant: string | null, e: MouseEvent) {
		e.stopPropagation();
		if (!discoveryState.currentModelId || !discoveryState.currentProviderId) return;
		wsSend({
			type: "set_model_default",
			provider: discoveryState.currentProviderId,
			model: discoveryState.currentModelId,
			variant,
			...(sessionState.currentId ? { sessionId: sessionState.currentId } : {}),
		});
		lockMenu = null;
	}

	/** Cycle the main variant (or lock menus are handled separately). */

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "Escape" && variantDropdownOpen) {
			variantDropdownOpen = false;
			return;
		}
		if (e.key === "t" && e.ctrlKey && variants.length > 0) {
			e.preventDefault();
			cycleVariant();
		}
	}

	// ─── Lifecycle ──────────────────────────────────────────────────────────────

	$effect(() => {
		document.addEventListener("keydown", handleKeydown);
		return () => {
			document.removeEventListener("keydown", handleKeydown);
		};
	});

	// ─── Public API ─────────────────────────────────────────────────────────────

	/** Close the dropdown (called by parent for mutual exclusion). */
	export function close() {
		variantDropdownOpen = false;
	}
</script>

{#if variants.length > 0}
	<div class="relative" use:clickOutside={() => { variantDropdownOpen = false; }}>
		<button
			data-testid="variant-badge"
		class="inline-flex items-center gap-1 h-6 px-2 ml-0.5 border border-border bg-bg-alt text-text-muted text-xs font-medium cursor-pointer whitespace-nowrap rounded-full transition-colors duration-100 hover:bg-bg hover:text-text-secondary font-brand"
			title="Thinking level ({variantLabel}) — Ctrl+T to cycle{discoveryState.lockedPrimeVariant ? ' (locked)' : ''}"
			onclick={toggleVariantDropdown}
		>
			{variantLabel}
			{#if discoveryState.lockedPrimeVariant}
				<Icon name="lock" size={8} class="shrink-0 opacity-70" />
			{/if}
			<Icon name="chevron-down" size={8} class="shrink-0 opacity-50" />
		</button>

		<!-- Variant dropdown -->
		{#if variantDropdownOpen}
			<div
				data-testid="variant-dropdown"
			class="absolute bottom-[calc(100%+4px)] right-0 w-40 bg-bg-alt border border-border rounded-lg shadow-[0_-4px_16px_rgba(var(--shadow-rgb),0.3)] z-[210] py-1 font-brand"
			>
				<!-- Default option (clears variant) -->
				<button
					data-testid="variant-option-default"
					class="flex items-center gap-2 w-full py-1.5 px-3 border-none bg-transparent text-text text-base text-left cursor-pointer transition-colors duration-100 hover:bg-bg {currentVariant === '' ? 'text-accent' : ''}"
					onclick={(e) => selectVariant("", e)}
				>
					{#if currentVariant === ""}
						<span class="text-accent font-bold text-xs">&#10003;</span>
					{:else}
						<span class="w-[10px]"></span>
					{/if}
					default
				</button>

				<!-- Variant options -->
				{#each variants as v (v)}
					<button
						data-testid="variant-option-{v}"
						class="flex items-center gap-2 w-full py-1.5 px-3 border-none bg-transparent text-text text-base text-left cursor-pointer transition-colors duration-100 hover:bg-bg {currentVariant === v ? 'text-accent' : ''}"
						onclick={(e) => selectVariant(v, e)}
					>
						{#if currentVariant === v}
							<span class="text-accent font-bold text-xs">&#10003;</span>
						{:else}
							<span class="w-[10px]"></span>
						{/if}
						{v}
					</button>
				{/each}

				<!-- Footer: shortcut hint + independent prime/sub strength locks -->
				<div class="border-t border-border mt-1 pt-1 px-2 pb-1 text-xs text-text-dimmer">
					<div class="flex items-center justify-between gap-1">
						<span>Ctrl+T</span>
						<span class="flex items-center gap-1">
							<button
								data-testid="lock-prime"
								class="inline-flex items-center gap-0.5 px-1 py-0.5 border-none bg-transparent cursor-pointer rounded transition-colors duration-100 hover:bg-bg {discoveryState.lockedPrimeVariant ? 'text-accent' : 'text-text-dimmer'}"
								title="Set the prime strength lock for this model"
								onclick={(e) => {
									e.stopPropagation();
									lockMenu = lockMenu === "prime" ? null : "prime";
								}}
							>
								<Icon name={discoveryState.lockedPrimeVariant ? "lock" : "lock-open"} size={11} />
								prime{discoveryState.lockedPrimeVariant ? `:${discoveryState.lockedPrimeVariant}` : ""}
							</button>
							<button
								data-testid="lock-subagent"
								class="inline-flex items-center gap-0.5 px-1 py-0.5 border-none bg-transparent cursor-pointer rounded transition-colors duration-100 hover:bg-bg {discoveryState.lockedSubagentVariant ? 'text-accent' : 'text-text-dimmer'}"
								title="Set the subagent strength lock (applies to all chats in this project)"
								onclick={(e) => {
									e.stopPropagation();
									lockMenu = lockMenu === "subagent" ? null : "subagent";
								}}
							>
								<Icon name={discoveryState.lockedSubagentVariant ? "lock" : "lock-open"} size={11} />
								sub{discoveryState.lockedSubagentVariant ? `:${discoveryState.lockedSubagentVariant}` : ""}
							</button>
						</span>
					</div>
					{#if lockMenu}
						<div class="mt-1 flex flex-wrap items-center gap-1" data-testid="lock-menu-{lockMenu}">
							<button
								class="px-1.5 py-0.5 border border-border bg-bg-alt text-text-muted rounded cursor-pointer hover:text-text transition-colors duration-100"
								onclick={(e) => chooseLock(lockMenu ?? "prime", "", e)}
							>
								unlock
							</button>
							{#each variants as v (v)}
								<button
									class="px-1.5 py-0.5 border border-border bg-bg-alt text-text-muted rounded cursor-pointer hover:text-text transition-colors duration-100 {(lockMenu === "prime" ? discoveryState.lockedPrimeVariant : discoveryState.lockedSubagentVariant) === v ? "text-accent" : ""}"
									onclick={(e) => chooseLock(lockMenu ?? "prime", v, e)}
								>
									{v}
								</button>
							{/each}
						</div>
						<div class="mt-1 flex flex-wrap items-center gap-1 border-t border-border pt-1">
							<span>model default: {discoveryState.modelDefaultVariant ?? "none"}</span>
							<button
								class="px-1.5 py-0.5 border border-border bg-bg-alt text-text-muted rounded cursor-pointer hover:text-text transition-colors duration-100"
								title="Use the currently selected strength for new chats on this model"
								onclick={(e) => setModelDefault(discoveryState.currentVariant || null, e)}
							>
								save current
							</button>
							{#if discoveryState.modelDefaultVariant}
								<button
									class="px-1.5 py-0.5 border border-border bg-bg-alt text-text-muted rounded cursor-pointer hover:text-text transition-colors duration-100"
									title="Clear the model default strength"
									onclick={(e) => setModelDefault(null, e)}
								>
									clear
								</button>
							{/if}
						</div>
					{/if}
				</div>
			</div>
		{/if}
	</div>
{/if}
