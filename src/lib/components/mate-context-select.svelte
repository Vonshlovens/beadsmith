<script lang="ts">
	/** What a First Mate chat is about: every project, or one of them. */
	import { projectList } from '$lib/client/projects.svelte';

	interface Props {
		/** Project id, or null for every project. */
		value: string | null;
		onchange?: (value: string | null) => void;
	}

	let { value = $bindable(), onchange }: Props = $props();

	const projects = $derived(projectList());

	function pick(event: Event) {
		const raw = (event.currentTarget as HTMLSelectElement).value;
		value = raw === '' ? null : raw;
		onchange?.(value);
	}
</script>

<label class="ctx" title="What First Mate looks at">
	<span class="ctx-lbl">About</span>
	<select class="select ctx-sel" value={value ?? ''} onchange={pick}>
		<option value="">All projects</option>
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
</style>
