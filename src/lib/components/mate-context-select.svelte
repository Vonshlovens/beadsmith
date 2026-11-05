<script lang="ts">
	/** What a First Mate chat is about: every project, or one of them. */
	import { projectList } from '#lib/client/projects.svelte.js';

	interface Props {
		/** Project id, or null for every project. */
		value: string | null;
		disabled?: boolean;
		onchange?: (value: string | null) => void;
	}

	let { value = $bindable(), disabled = false, onchange }: Props = $props();

	const projects = $derived(projectList());

	function pick(event: Event) {
		const raw = (event.currentTarget as HTMLSelectElement).value;
		const next = raw === '' ? null : raw;
		if (onchange) {
			(event.currentTarget as HTMLSelectElement).value = value ?? '';
			onchange(next);
		} else value = next;
	}
</script>

<label class="ctx" title="What First Mate looks at">
	<span class="ctx-lbl">Scope</span>
	<select class="select ctx-sel" {disabled} value={value ?? ''} onchange={pick}>
		<option value="">All projects</option>
		{#if value && !projects.some((project) => project.id === value)}
			<option {value}>Selected project (unavailable)</option>
		{/if}
		{#each projects as project (project.id)}
			<option value={project.id}>{project.name}</option>
		{/each}
	</select>
</label>

<style>
	.ctx {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		max-width: 100%;
	}
	.ctx-lbl {
		font-size: var(--t-xs);
		color: var(--tx-dim);
	}
	.ctx-sel {
		width: auto;
		max-width: 22ch;
		height: 28px;
		font-size: var(--t-xs);
		background-position:
			calc(100% - 14px) 11px,
			calc(100% - 9px) 11px;
		background-color: var(--s2);
		border-color: transparent;
	}
	@media (pointer: coarse) {
		.ctx-sel {
			min-height: 44px;
		}
	}
</style>
