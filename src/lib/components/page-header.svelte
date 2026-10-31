<script lang="ts">
	/**
	 * Compact page header: the title, a short count, and
	 * icon actions on one line. Replaces the eyebrow label, display-size title
	 * and worded Refresh button each page used to carry. With `onrefresh` it
	 * shows a refresh icon and binds `r`.
	 */
	import type { Snippet } from 'svelte';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import { useHotkeys } from '$lib/client/hotkeys.svelte';

	interface Props {
		title: string;
		/** Short count line, e.g. `3 · 30 issues`. */
		meta?: string;
		/** Spoken and hover form of `meta` when the visible one is terse. */
		meta_label?: string;
		onrefresh?: () => unknown;
		refreshing?: boolean;
		actions?: Snippet;
	}

	let { title, meta, meta_label, onrefresh, refreshing = false, actions }: Props = $props();

	useHotkeys(() =>
		onrefresh === undefined
			? []
			: [{ keys: ['r'], label: 'Refresh this page', group: 'General', run: () => void onrefresh() }]
	);
</script>

<div class="phd">
	<h1 class="phd-t">{title}</h1>
	{#if meta}
		<span class="phd-m mono-num" title={meta_label} aria-label={meta_label}>{meta}</span>
	{/if}
	<span class="phd-sp"></span>
	{@render actions?.()}
	{#if onrefresh}
		<button
			class="btn btn-sm btn-ghost btn-icon"
			class:is-spinning={refreshing}
			type="button"
			aria-label="Refresh"
			title="Refresh (r)"
			disabled={refreshing}
			onclick={() => void onrefresh()}
		>
			<RefreshCwIcon size={14} strokeWidth={1.4} />
		</button>
	{/if}
</div>

<style>
	.phd {
		display: flex;
		align-items: center;
		gap: var(--s-2) var(--s-3);
		flex-wrap: wrap;
		min-height: 28px;
		margin-bottom: var(--s-4);
	}
	.phd-t {
		font-size: var(--t-lg);
		font-weight: 650;
		letter-spacing: -0.01em;
		color: var(--tx-hi);
		margin: 0;
	}
	.phd-m {
		font-size: var(--t-sm);
		color: var(--tx-dim);
	}
	.phd-sp {
		flex: 1;
	}
	.is-spinning :global(svg) {
		animation: phd-spin 0.9s linear infinite;
	}
	@keyframes phd-spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
