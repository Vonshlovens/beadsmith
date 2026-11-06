<script lang="ts">
	/**
	 * "Runs on": where new First Mate chats and agent threads run, on the
	 * operator's own runner or on Sand (E2B). Only rendered when the service
	 * offers both; the options come from the server, so the browser can only
	 * pick something configured. Existing chats and threads stay where they are.
	 */
	import SelectField from '#lib/components/select-field.svelte';
	import { run_place, type RunPlace } from '#lib/client/agent-runner.svelte.js';
	import { tip } from '#lib/client/tooltip.js';

	const items = $derived(
		run_place.options.map((option) => ({ value: option.place, label: option.label }))
	);

	function pick(raw: string) {
		const option = run_place.options.find((entry) => entry.place === raw);
		if (option) {
			run_place.choose(option.place as RunPlace);
		}
	}
</script>

{#if run_place.options.length > 1}
	<span
		class="runner"
		{@attach tip('Where new chats and agent threads run. Existing ones stay where they are.')}
	>
		<span class="runner-lbl">Runs on</span>
		<SelectField
			value={run_place.current?.place ?? ''}
			{items}
			controlled
			class="select-sm runner-sel"
			aria-label="Runs on: where new chats and agent threads run"
			onValueChange={pick}
		/>
	</span>
{/if}

<style>
	.runner {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		max-width: 100%;
	}
	.runner-lbl {
		font-size: var(--t-xs);
		color: var(--tx-dim);
		white-space: nowrap;
	}
	.runner :global(.runner-sel) {
		width: auto;
		max-width: 22ch;
		background-color: var(--s2);
		border-color: transparent;
	}
	@media (pointer: coarse) {
		.runner :global(.runner-sel) {
			min-height: 44px;
		}
	}
</style>
