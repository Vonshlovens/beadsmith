<script lang="ts">
	/**
	 * The catalog's StatTile: how many rows one binding read (issues,
	 * projects, missions or todos), with its label and an optional hint. A
	 * read that stopped at its limit shows "50+", since the true count may be
	 * higher; a failed read shows why, never 0.
	 */
	import { surfaceCount } from '#lib/client/surfaces.js';
	import type { SurfaceBindingResult } from '#lib/surfaces.js';
	import SurfaceBindingError from './surface-binding-error.svelte';

	interface Props {
		label: string;
		hint?: string;
		result: SurfaceBindingResult | undefined;
	}

	let { label, hint, result }: Props = $props();

	const read = $derived(surfaceCount(result));
</script>

{#if read.ok}
	<div class="sf-stat panel">
		<span class="lbl">{label}</span>
		<span
			class="sf-stat-n mono-num"
			aria-label={read.value.more ? `${read.value.count} or more` : undefined}
			>{read.value.count}{read.value.more ? '+' : ''}</span
		>
		{#if hint}
			<span class="hint">{hint}</span>
		{:else if read.value.more}
			<span class="hint">The read stopped at its limit; there may be more.</span>
		{/if}
	</div>
{:else}
	<SurfaceBindingError what={label} message={read.message} />
{/if}

<style>
	.sf-stat {
		display: flex;
		flex-direction: column;
		gap: var(--s-1);
		padding: var(--s-3) var(--s-4);
		min-width: 0;
	}
	.sf-stat-n {
		color: var(--tx-hi);
		font-size: var(--t-xl);
		font-weight: 600;
		line-height: 1.1;
	}
</style>
