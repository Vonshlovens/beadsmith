<script lang="ts">
	/**
	 * Sortable header plus the Beads resize grip. TanStack owns the click
	 * cycle; the grip is still ours because the title column absorbs slack
	 * rather than sharing a pixel budget equally.
	 */
	import {
		COLUMN_LABELS,
		isResizable,
		MAX_COLUMN_WIDTH,
		MIN_COLUMN_WIDTH
	} from '$lib/client/columns.js';
	import type { ColumnId } from '$lib/client/columns.js';
	import type { IssuesTableMeta } from './data-table-features.js';

	interface Props {
		column: ColumnId;
		label: string;
		sorted: false | 'asc' | 'desc';
		onSort?: (event: unknown) => void;
		meta?: IssuesTableMeta;
	}

	let { column, label, sorted, onSort, meta }: Props = $props();

	const width = $derived(meta?.columnWidth(column) ?? 0);
	const dragging = $derived(meta?.resizing_column === column);
</script>

<button
	class="sort-hd"
	type="button"
	onclick={onSort}
	aria-label="Sort by {COLUMN_LABELS[column]}"
	title="Sort by {COLUMN_LABELS[column]}"
>
	<span class="hd-tx" aria-hidden="true">{label}</span>
	<span class="arrow" aria-hidden="true">
		{#if sorted === 'asc'}▲{:else if sorted === 'desc'}▼{:else}⇅{/if}
	</span>
</button>
{#if isResizable(column) && meta}
	<!--
		ARIA treats a focusable separator as a widget — it is the role
		the spec names for a resize handle, and the arrow keys below
		are what make it one. The linter only knows the static case.
	-->
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<span
		class="col-grip"
		class:is-dragging={dragging}
		role="separator"
		tabindex="0"
		aria-orientation="vertical"
		aria-label="Resize {COLUMN_LABELS[column]} column"
		aria-valuenow={width}
		aria-valuemin={MIN_COLUMN_WIDTH}
		aria-valuemax={MAX_COLUMN_WIDTH}
		onpointerdown={(event) => meta.startResize(event, column)}
		onpointermove={meta.moveResize}
		onpointerup={meta.endResize}
		onpointercancel={meta.endResize}
		onclick={(event) => event.stopPropagation()}
		ondblclick={(event) => {
			event.stopPropagation();
			meta.resetColumnWidth(column);
		}}
		onkeydown={(event) => meta.onGripKeydown(event, column)}
	></span>
{/if}

<style>
	.sort-hd {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 9px var(--s-3);
		border: 0;
		border-radius: inherit;
		background: none;
		color: inherit;
		font: inherit;
		letter-spacing: inherit;
		text-transform: inherit;
		white-space: nowrap;
		cursor: pointer;
	}
	.sort-hd:hover {
		background: var(--s3);
		color: var(--tx-hi);
	}
	.sort-hd .hd-tx {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.sort-hd .arrow {
		flex: none;
		font-size: 9px;
		color: var(--tx-dim);
		opacity: 0;
	}
	.sort-hd:hover .arrow,
	.sort-hd:focus-visible .arrow {
		opacity: 1;
	}
	:global([aria-sort='ascending']) .sort-hd,
	:global([aria-sort='descending']) .sort-hd {
		color: var(--em-300);
	}
	:global([aria-sort='ascending']) .arrow,
	:global([aria-sort='descending']) .arrow {
		opacity: 1;
		color: var(--em-400);
	}
	.col-grip {
		position: absolute;
		top: 0;
		right: 0;
		bottom: 0;
		width: 9px;
		z-index: 1;
		cursor: col-resize;
		touch-action: none;
	}
	.col-grip::after {
		content: '';
		position: absolute;
		top: 6px;
		bottom: 6px;
		right: 4px;
		width: 1px;
		background: transparent;
	}
	.col-grip:hover::after,
	.col-grip:focus-visible::after {
		background: var(--line-2);
	}
	.col-grip.is-dragging::after {
		background: var(--em-400);
	}
	.col-grip:focus-visible {
		outline: 2px solid var(--em-400);
		outline-offset: 2px;
	}
</style>
