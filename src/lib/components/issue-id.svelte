<script lang="ts">
	/**
	 * The id chip: the project prefix recedes, the short suffix people say out
	 * loud stays bright.
	 */
	import { tip } from '#lib/client/tooltip.js';
	import { splitIssueId } from '#lib/client/format.js';

	interface Props {
		id: string;
		href?: string;
		strong?: boolean;
		/** Replace the prefix with an ellipsis, as the relationships rail does. */
		abbreviate?: boolean;
	}

	let { id, href, strong = false, abbreviate = false }: Props = $props();

	const parts = $derived(splitIssueId(id));
	const prefix = $derived(abbreviate ? (parts.prefix ? '…-' : '') : parts.prefix);
</script>

{#if href}
	<a class="id{strong ? ' id-strong' : ''}" {href} {@attach tip(id)}
		>{prefix}<b>{parts.suffix}</b></a
	>
{:else}
	<span class="id{strong ? ' id-strong' : ''}" {@attach tip(id)}>{prefix}<b>{parts.suffix}</b></span
	>
{/if}
