<script lang="ts">
	/**
	 * Empty states end in a verb (specs/05). The mark is the thread with the
	 * bead missing from it.
	 */
	import type { Snippet } from 'svelte';

	interface Props {
		title: string;
		description?: string;
		actions?: Snippet;
	}

	let { title, description, actions }: Props = $props();
</script>

<div class="empty">
	<div class="empty-mark" aria-hidden="true"></div>
	<div class="h3">{title}</div>
	{#if description}
		<p>{description}</p>
	{/if}
	{#if actions}
		<div class="row gap-2" style="justify-content:center">
			{@render actions()}
		</div>
	{/if}
</div>
