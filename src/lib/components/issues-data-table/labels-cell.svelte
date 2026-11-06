<script lang="ts">
	/** Labels cell: two tags, then a muted count of the rest. */
	import { tip } from '#lib/client/tooltip.js';
	interface Props {
		labels: string[];
	}

	let { labels }: Props = $props();
	const hidden = $derived(labels.slice(2));
</script>

{#if labels.length > 0}
	{#each labels.slice(0, 2) as label (label)}
		<span class="tag">{label}</span>
	{/each}
	{#if hidden.length > 0}
		<span class="tag more" {@attach tip(hidden.join(', '))}>+{hidden.length}</span>
	{/if}
{:else}
	<span class="faint">—</span>
{/if}

<style>
	.more {
		color: var(--tx-dim);
	}
	.more::before {
		content: none;
	}
</style>
