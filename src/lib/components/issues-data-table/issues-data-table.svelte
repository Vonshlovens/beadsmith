<script lang="ts">
	/**
	 * Issues list as a shadcn-svelte data table: TanStack Table for column
	 * defs, sort state, and visibility; the existing Table primitives for
	 * markup; Beads CSS for the look. Filtering stays on the page (it is a
	 * URL concern). Column widths stay here as props because the title column
	 * absorbs slack rather than sharing pixels equally. The frame scrolls;
	 * Status and Id pin to the left of that scrollport.
	 */
	import { goto, preloadData } from '$app/navigation';
	import { issueDetailHref } from '$lib/client/issue-view.js';
	import { FlexRender, createTable, type SortingState, type Updater } from '@tanstack/svelte-table';
	import * as Table from '$lib/components/ui/table/index.js';
	import { STICKY_COLUMNS, visibilityState } from '$lib/client/columns.js';
	import type { ColumnId, StickyColumn } from '$lib/client/columns.js';
	import { statusKey } from '$lib/client/format.js';
	import { sortIssues } from '$lib/client/sort.js';
	import type { SortState } from '$lib/client/sort.js';
	import { rememberIssueSummaryHint } from '$lib/client/issue-summary-hint.js';
	import { agentAvailability } from '$lib/client/agent.js';
	import { useHotkeys } from '$lib/client/hotkeys.svelte.js';
	import { currentProject, statusSnapshot } from '$lib/client/projects.svelte.js';
	import { app_state } from '$lib/client/stores.svelte.js';
	import type { IssueSummary } from '$lib/types.js';
	import { issueColumns } from './columns.js';
	import { features } from './data-table-features.js';
	import type { IssuesTableMeta } from './data-table-features.js';
	import { fromSortingState, toSortingState } from './sorting.js';

	interface Props {
		issues: IssueSummary[];
		project_id: string;
		project_name: string;
		total_count: number;
		painted: ReadonlySet<ColumnId>;
		resizing_column: ColumnId | null;
		sort: SortState;
		table_min_width: number;
		pin_left: Partial<Record<StickyColumn, number>> | null;
		scroll_el: HTMLDivElement | null;
		columnWidth: (column: ColumnId) => number;
		onStartResize: (event: PointerEvent, column: ColumnId) => void;
		onMoveResize: (event: PointerEvent) => void;
		onEndResize: (event: PointerEvent) => void;
		onGripKeydown: (event: KeyboardEvent, column: ColumnId) => void;
		onResetColumnWidth: (column: ColumnId) => void;
	}

	let {
		issues,
		project_id,
		project_name,
		total_count,
		painted,
		resizing_column,
		sort = $bindable(),
		table_min_width,
		pin_left,
		scroll_el = $bindable(null),
		columnWidth,
		onStartResize,
		onMoveResize,
		onEndResize,
		onGripKeydown,
		onResetColumnWidth
	}: Props = $props();

	let scrolled_x = $state(false);
	/** Keyboard cursor (j/k); null until the reader moves it. */
	let cursor_id = $state<string | null>(null);

	const rows = $derived(sortIssues(issues, sort));
	const cursor_row = $derived(rows.find((issue) => issue.id === cursor_id));
	const agent_visible = $derived(
		agentAvailability(statusSnapshot(), currentProject()?.allow).visible
	);

	/**
	 * Move the keyboard cursor and focus that row's title link, so the row is
	 * announced and Enter follows it.
	 *
	 * @param step - Down (1) or up (-1).
	 */
	function stepCursor(step: 1 | -1): boolean {
		if (rows.length === 0) {
			return false;
		}
		const at = cursor_id === null ? -1 : rows.findIndex((issue) => issue.id === cursor_id);
		const next_at = at < 0 ? (step === 1 ? 0 : rows.length - 1) : at + step;
		const next = rows[Math.min(Math.max(next_at, 0), rows.length - 1)];
		if (next === undefined) {
			return false;
		}
		cursor_id = next.id;
		requestAnimationFrame(() => {
			const row = scroll_el?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(next.id)}"]`);
			row?.scrollIntoView({ block: 'nearest' });
			row?.querySelector<HTMLElement>('td.t-title a, a')?.focus({ preventScroll: true });
		});
		return true;
	}

	useHotkeys(() => [
		{ keys: ['j', 'ArrowDown'], label: 'Next issue', group: 'Lists', run: () => stepCursor(1) },
		{ keys: ['k', 'ArrowUp'], label: 'Previous issue', group: 'Lists', run: () => stepCursor(-1) },
		{
			keys: ['o', 'Enter'],
			label: 'Open the issue page',
			group: 'Lists',
			run: (event) => {
				if (cursor_row === undefined) {
					return false;
				}
				// A focused link already follows itself on Enter.
				if (event.key === 'Enter' && (event.target as HTMLElement | null)?.closest('a')) {
					return false;
				}
				stashRow(cursor_row);
				void goto(rowHref(cursor_row.id));
			}
		},
		{
			keys: ['a'],
			label: 'Ask an agent about the selected issue',
			group: 'Agent',
			when: () => agent_visible,
			run: () => {
				if (cursor_row === undefined) {
					return false;
				}
				app_state.openAgent({
					project_id,
					issue_id: cursor_row.id,
					issue_title: cursor_row.title
				});
			}
		}
	]);
	const leaf_count = $derived(issueColumns.length);
	const pin_edge = $derived.by(() => {
		if (!pin_left) {
			return null;
		}
		let edge: StickyColumn | null = null;
		for (const column of STICKY_COLUMNS) {
			if (pin_left[column] !== undefined) {
				edge = column;
			}
		}
		return edge;
	});

	function applySorting(updater: Updater<SortingState>) {
		const current = toSortingState(sort);
		sort = fromSortingState(typeof updater === 'function' ? updater(current) : updater);
	}

	const table = createTable({
		features,
		columns: issueColumns,
		get data() {
			return rows;
		},
		getRowId: (issue) => issue.id,
		enableMultiSort: false,
		enableSortingRemoval: true,
		manualSorting: true,
		state: {
			get sorting() {
				return toSortingState(sort);
			},
			get columnVisibility() {
				return visibilityState(painted);
			}
		},
		onSortingChange: applySorting,
		get meta(): IssuesTableMeta {
			return {
				project_id,
				resizing_column,
				columnWidth,
				startResize: onStartResize,
				moveResize: onMoveResize,
				endResize: onEndResize,
				onGripKeydown,
				resetColumnWidth: onResetColumnWidth
			};
		}
	});

	function rowHref(issue_id: string): string {
		return issueDetailHref(project_id, issue_id);
	}

	/**
	 * Start the detail load for one hovered or focused row. SvelteKit's
	 * body-level preload-data only fires for anchors, so Id/Title links already
	 * prefetch — this covers the rest of the row. Do not call from list load
	 * or mousedown; one row at a time on hover/focus only.
	 *
	 * @param issue_id - Issue the row represents.
	 */
	function preloadRow(issue_id: string) {
		void preloadData(rowHref(issue_id));
	}

	/**
	 * Stash the row as a paint hint for the detail header. Hover, focus, and
	 * pointerdown all call this because Id/Title are links and skip `openRow`.
	 *
	 * @param issue - List-row summary, never treated as authoritative later.
	 */
	function stashRow(issue: IssueSummary) {
		rememberIssueSummaryHint(issue);
	}

	function prepareRow(issue: IssueSummary) {
		stashRow(issue);
		preloadRow(issue.id);
	}

	/**
	 * Row click opens the issue, unless the click landed on a control.
	 *
	 * @param event - The originating mouse event.
	 * @param issue - Issue the row represents.
	 */
	function openRow(event: MouseEvent, issue: IssueSummary) {
		const target = event.target as HTMLElement | null;
		if (target?.closest('a, button, [role="menu"]')) {
			return;
		}
		stashRow(issue);
		void goto(rowHref(issue.id));
	}

	function ariaSortValue(column_id: string): 'ascending' | 'descending' | 'none' {
		const direction = table.getColumn(column_id)?.getIsSorted();
		if (direction === 'asc') {
			return 'ascending';
		}
		if (direction === 'desc') {
			return 'descending';
		}
		return 'none';
	}

	function pinLeft(column_id: string): number | undefined {
		if (!pin_left) {
			return undefined;
		}
		return pin_left[column_id as StickyColumn];
	}

	function pinClass(column_id: string): string {
		const left = pinLeft(column_id);
		if (left === undefined) {
			return '';
		}
		return column_id === pin_edge ? 'is-pin is-pin-edge' : 'is-pin';
	}

	function onTableScroll(event: Event) {
		const target = event.currentTarget;
		if (!(target instanceof HTMLElement)) {
			return;
		}
		scrolled_x = target.scrollLeft > 0;
	}
</script>

<div class="tbl-wrap" class:is-scrolled-x={scrolled_x}>
	<div class="tbl-scroll" bind:this={scroll_el} onscroll={onTableScroll}>
		<Table.Root class="tbl" style="width: max(100%, {table_min_width}px)">
			<Table.Caption class="sr-only">
				Issues in {project_name}, {issues.length} of {total_count} shown,
				{table.getVisibleLeafColumns().length} of {leaf_count} columns
			</Table.Caption>
			<!--
				Fixed layout needs the widths declared up front. Every column but the
				title states one; the title states none, so it takes the slack.
			-->
			<colgroup>
				{#each table.getVisibleLeafColumns() as column (column.id)}
					{#if column.id === 'title'}
						<col />
					{:else}
						<col style="width:{columnWidth(column.id as ColumnId)}px" />
					{/if}
				{/each}
			</colgroup>
			<Table.Header>
				{#each table.getHeaderGroups() as headerGroup (headerGroup.id)}
					<Table.Row>
						{#each headerGroup.headers as header (header.id)}
							{@const left = pinLeft(header.column.id)}
							<Table.Head
								class={`${header.column.columnDef.meta?.headerClass ?? ''} ${pinClass(header.column.id)}`.trim()}
								style={left === undefined ? undefined : `left:${left}px`}
								scope="col"
								aria-sort={ariaSortValue(header.column.id)}
							>
								{#if !header.isPlaceholder}
									<FlexRender {header} />
								{/if}
							</Table.Head>
						{/each}
					</Table.Row>
				{/each}
			</Table.Header>
			<Table.Body>
				{#each table.getRowModel().rows as row (row.id)}
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
					<Table.Row
						class={`${statusKey(row.original.status) === 'closed' ? 'is-closed' : ''} ${row.id === cursor_id ? 'is-selected' : ''}`.trim()}
						data-row-id={row.id}
						aria-selected={row.id === cursor_id ? 'true' : undefined}
						onmouseenter={() => prepareRow(row.original)}
						onfocusin={() => {
							cursor_id = row.id;
							prepareRow(row.original);
						}}
						onpointerdown={() => stashRow(row.original)}
						onclick={(event) => openRow(event, row.original)}
					>
						{#each row.getVisibleCells() as cell (cell.id)}
							{@const left = pinLeft(cell.column.id)}
							<Table.Cell
								class={`${cell.column.columnDef.meta?.cellClass ?? ''} ${pinClass(cell.column.id)}`.trim()}
								style={left === undefined ? undefined : `left:${left}px`}
							>
								<FlexRender {cell} />
							</Table.Cell>
						{/each}
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	</div>
	<div class="tbl-ft">
		<span
			class="mono-num"
			title="{issues.length} shown, {total_count - issues.length} hidden by filters"
		>
			{issues.length}{#if total_count > issues.length}<span class="faint">
					/ {total_count}</span
				>{/if}
		</span>
	</div>
</div>

<style>
	/*
	 * The scrollport is `.tbl-scroll`, so the header sticks to the top of the
	 * frame and Status/Id can pin to its left edge. Table.Root's own
	 * overflow-x-auto would be a second scrollport, so it stays visible.
	 */
	.tbl-wrap {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		overflow: hidden;
		border: 1px solid var(--line);
		border-radius: var(--r-2);
		background: var(--s2);
	}
	.tbl-scroll {
		flex: 1;
		min-height: 0;
		overflow: auto;
		overscroll-behavior: contain;
	}
	.tbl-wrap :global([data-slot='table-container']) {
		overflow: visible;
	}
	.tbl-wrap :global(table.tbl) {
		table-layout: fixed;
	}
	.tbl-wrap :global(tbody td.t-title) {
		max-width: none;
		width: auto;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tbl-wrap :global(thead th) {
		background: var(--s1);
		padding: 0;
		position: sticky;
		top: 0;
		z-index: 5;
		height: auto;
	}
	.tbl-wrap :global(thead th.is-pin) {
		z-index: 6;
		background: var(--s1);
	}
	.tbl-wrap :global(tbody td.is-pin) {
		position: sticky;
		z-index: 2;
		background: var(--s2);
	}
	.tbl-wrap :global(tbody tr:hover td.is-pin) {
		background: var(--s2);
	}
	.tbl-wrap.is-scrolled-x :global(.is-pin-edge) {
		box-shadow: 8px 0 10px -8px var(--void);
	}
	.tbl-wrap :global(thead th:first-child .sort-hd) {
		padding-left: var(--s-4);
	}
	.tbl-wrap :global(thead th:last-child .sort-hd) {
		padding-right: var(--s-4);
	}
	.tbl-wrap :global(thead th.c-dp .sort-hd),
	.tbl-wrap :global(thead th.c-up .sort-hd) {
		justify-content: flex-end;
	}
	.tbl-wrap :global(tbody td:first-child) {
		padding-left: var(--s-4);
	}
	.tbl-wrap :global(tbody td:last-child) {
		padding-right: var(--s-4);
	}
	.tbl-wrap :global(tbody tr:last-child td) {
		border-bottom: 0;
	}
	.tbl-wrap :global(tbody tr) {
		cursor: pointer;
	}
	.tbl-wrap :global(.c-st),
	.tbl-wrap :global(.c-id),
	.tbl-wrap :global(.c-ty),
	.tbl-wrap :global(.c-pr),
	.tbl-wrap :global(.c-as),
	.tbl-wrap :global(.c-lb),
	.tbl-wrap :global(.c-dp),
	.tbl-wrap :global(.c-up) {
		width: 1%;
	}
	.tbl-wrap :global(.c-id),
	.tbl-wrap :global(.c-as),
	.tbl-wrap :global(.c-lb),
	.tbl-wrap :global(.c-dp),
	.tbl-wrap :global(.c-up) {
		white-space: nowrap;
	}
	.tbl-wrap :global(.c-as) {
		color: var(--tx-mid);
	}
	.tbl-wrap :global(.c-dp) {
		text-align: right;
	}
	.tbl-wrap :global(.c-up) {
		text-align: right;
		color: var(--tx-dim);
		font-variant-numeric: tabular-nums;
	}
	.tbl-ft {
		display: flex;
		align-items: center;
		gap: var(--s-3);
		padding: 6px var(--s-4);
		border-top: 1px solid var(--line);
		font-size: var(--t-xs);
		color: var(--tx-dim);
	}
	@media (max-width: 640px) {
		.tbl-wrap {
			flex: none;
			overflow: visible;
		}
		.tbl-scroll {
			flex: none;
			overflow-x: auto;
			overflow-y: visible;
		}
		.tbl-wrap :global(thead th),
		.tbl-wrap :global(tbody td.is-pin) {
			position: static;
		}
	}
</style>
