<!-- ─── Skill Menu ──────────────────────────────────────────────────────────── -->
<!-- Button + dropdown for activating a discovered skill in the current session. -->

<script lang="ts">
	import type { SkillInfo } from "../../types.js";
	import Icon from "../shared/Icon.svelte";

	let { open, skills, onToggle, onSelect }: {
		open: boolean;
		skills: SkillInfo[];
		onToggle: () => void;
		onSelect: (skill: SkillInfo) => void;
	} = $props();
</script>

<div id="skill-wrap" class="relative shrink-0">
	<button
		id="skill-btn"
		type="button"
		aria-label="Skills"
		title="Activate a skill"
		class="w-8 h-8 rounded-[10px] bg-transparent border border-border text-text-muted cursor-pointer flex items-center justify-center transition-[background,color] duration-150 touch-manipulation active:opacity-70 hover:text-text"
		onclick={onToggle}
	>
		<Icon name="sparkles" size={15} />
	</button>
	<div
		id="skill-menu"
		class="absolute bottom-[calc(100%+8px)] left-0 min-w-[220px] max-w-[340px] max-h-[320px] overflow-y-auto bg-bg-surface border border-border rounded-[10px] p-1 shadow-[0_-4px_24px_rgba(var(--shadow-rgb),0.4)] z-20"
		class:hidden={!open}
	>
		{#if skills.length === 0}
			<div class="px-3 py-3 text-text-muted text-sm font-brand">No skills found</div>
		{:else}
			{#each skills as skill (skill.id)}
				<button
					class="flex flex-col items-start gap-0.5 w-full py-2.5 px-3 border-none bg-none text-left cursor-pointer transition-[background,color] duration-150 rounded-md hover:bg-[rgba(var(--overlay-rgb),0.04)]"
					type="button"
					onclick={() => onSelect(skill)}
				>
					<span class="text-text text-sm font-brand">{skill.name || skill.id}</span>
					{#if skill.description}
						<span class="text-text-muted text-xs leading-snug line-clamp-2">{skill.description}</span>
					{/if}
				</button>
			{/each}
		{/if}
	</div>
</div>
