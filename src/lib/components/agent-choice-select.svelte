<script lang="ts">
	/**
	 * Model and effort for a launch or a new chat, picked from the operator's
	 * list (`dispatch.models` / `dispatch.efforts`). Rendered only when the
	 * server offers something and the work's runner can take it; each half
	 * only when its list is not empty. "Runner default" leaves the field out.
	 * The pick is remembered for the next launch (`agent-choice.svelte.ts`);
	 * the caller adds `agent_choice.forLaunch` / `forChat` to its request.
	 */
	import SelectField from '#lib/components/select-field.svelte';
	import { agent_choice } from '#lib/client/agent-choice.svelte.js';
	import {
		agentChoiceOffer,
		choiceItems,
		DEFAULT_CHOICE,
		offersChoice
	} from '#lib/client/agent-choice.js';
	import { statusSnapshot } from '#lib/client/projects.svelte.js';
	import { tip } from '#lib/client/tooltip.js';

	interface Props {
		/** The runner this work goes to can choose a model. */
		takes: boolean;
		disabled?: boolean;
	}

	let { takes, disabled = false }: Props = $props();

	const offer = $derived(agentChoiceOffer(statusSnapshot()?.dispatch));
	const picked = $derived(agent_choice.fields(offer));

	function pick(field: 'model' | 'effort', raw: string) {
		agent_choice.choose(field, raw === DEFAULT_CHOICE ? undefined : raw);
	}
</script>

{#if takes && offersChoice(offer)}
	<span class="choice" role="group" aria-label="Model and effort">
		{#if offer.models.length > 0}
			<span
				class="pair"
				{@attach tip('The model the agent runs on. Runner default leaves it to the runner.')}
			>
				<span class="lbl">Model</span>
				<SelectField
					value={picked.model ?? DEFAULT_CHOICE}
					items={choiceItems(offer.models)}
					controlled
					{disabled}
					class="select-sm choice-sel"
					aria-label="Model"
					onValueChange={(raw) => pick('model', raw)}
				/>
			</span>
		{/if}
		{#if offer.efforts.length > 0}
			<span class="pair" {@attach tip('How hard the model thinks. Higher costs more.')}>
				<span class="lbl">Effort</span>
				<SelectField
					value={picked.effort ?? DEFAULT_CHOICE}
					items={choiceItems(offer.efforts)}
					controlled
					{disabled}
					class="select-sm choice-sel"
					aria-label="Effort"
					onValueChange={(raw) => pick('effort', raw)}
				/>
			</span>
		{/if}
	</span>
{/if}

<style>
	.choice {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-1) var(--s-3);
		min-width: 0;
		max-width: 100%;
	}
	.pair {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}
	.lbl {
		font-size: var(--t-xs);
		color: var(--tx-dim);
		white-space: nowrap;
	}
	.pair :global(.choice-sel) {
		width: auto;
		max-width: 22ch;
		background-color: var(--s2);
		border-color: transparent;
	}
	@media (pointer: coarse) {
		.pair :global(.choice-sel) {
			min-height: 44px;
		}
	}
</style>
