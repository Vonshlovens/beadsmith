<script lang="ts">
	/** What a First Mate chat is about: every project, or one of them. */
	import SelectField from '#lib/components/select-field.svelte';
	import { tip } from '#lib/client/tooltip.js';
	import { projectList } from '#lib/client/projects.svelte.js';

	interface Props {
		/** Project id, or null for every project. */
		value: string | null;
		disabled?: boolean;
		onchange?: (value: string | null) => void;
	}

	let { value = $bindable(), disabled = false, onchange }: Props = $props();

	const projects = $derived(projectList());
	const items = $derived([
		{ value: '', label: 'All projects' },
		...(value && !projects.some((project) => project.id === value)
			? [{ value, label: 'Selected project (unavailable)' }]
			: []),
		...projects.map((project) => ({ value: project.id, label: project.name }))
	]);

	/** With `onchange` the parent decides; the picker shows `value` until it does. */
	function pick(raw: string) {
		const next = raw === '' ? null : raw;
		if (onchange) {
			onchange(next);
		} else {
			value = next;
		}
	}
</script>

<span class="ctx" {@attach tip('What First Mate looks at')}>
	<span class="ctx-lbl" id="mate-ctx-lbl">Scope</span>
	<SelectField
		value={value ?? ''}
		{items}
		{disabled}
		controlled
		class="select-sm ctx-sel"
		aria-label="Scope: what First Mate looks at"
		onValueChange={pick}
	/>
</span>

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
	.ctx :global(.ctx-sel) {
		width: auto;
		max-width: 22ch;
		background-color: var(--s2);
		border-color: transparent;
	}
	@media (pointer: coarse) {
		.ctx :global(.ctx-sel) {
			min-height: 44px;
		}
	}
</style>
