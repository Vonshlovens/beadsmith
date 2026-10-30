/**
 * Issue-list column definitions for the shadcn-svelte data table.
 *
 * Cells are Svelte components via `renderComponent`. Sorting still uses the
 * Beads comparator (`sortIssues`) so id ties and the three-click cycle stay
 * exactly as the unit tests describe; TanStack owns header state and
 * visibility.
 */
import { createColumnHelper, renderComponent } from '@tanstack/svelte-table';
import IssueId from '$lib/components/issue-id.svelte';
import PriorityChip from '$lib/components/priority-chip.svelte';
import StatusBadge from '$lib/components/status-badge.svelte';
import TypeChip from '$lib/components/type-chip.svelte';
import { COLUMN_LABELS } from '$lib/client/columns.js';
import { relativeShort } from '$lib/client/format.js';
import { issueDetailHref } from '$lib/client/issue-view.js';
import type { IssueSummary } from '$lib/types.js';
import AssigneeCell from './assignee-cell.svelte';
import { features } from './data-table-features.js';
import type { IssuesTableMeta } from './data-table-features.js';
import DepsCell from './deps-cell.svelte';
import HeaderCell from './header-cell.svelte';
import LabelsCell from './labels-cell.svelte';
import TitleCell from './title-cell.svelte';

const columnHelper = createColumnHelper<typeof features, IssueSummary>();

/**
 * Header text, which is not always the menu's text. A header is uppercased,
 * letter-spaced and living inside a column the reader may drag down to 48px,
 * so two of them abbreviate; the menu, which has room, spells them out.
 */
export const HEADER_LABELS: Record<keyof typeof COLUMN_LABELS, string> = {
	...COLUMN_LABELS,
	status: '●',
	priority: 'Pri',
	deps: 'Deps'
};

/** Narrower than this, the status column shows the bead without its word. */
export const STATUS_WORD_WIDTH = 100;

/**
 * The cell class each column has always used. The stylesheet keys alignment,
 * colour and wrapping off these, so they survive the move onto TanStack
 * columns unchanged.
 */
const CELL_CLASS = {
	status: 'c-st',
	id: 'c-id',
	title: 't-title',
	type: 'c-ty',
	priority: 'c-pr',
	assignee: 'c-as',
	labels: 'c-lb',
	deps: 'c-dp',
	updated: 'c-up'
} as const;

function headerClass(column: keyof typeof CELL_CLASS): string {
	return column === 'title' ? '' : CELL_CLASS[column];
}

function headerCell(
	ctx: {
		column: {
			id: string;
			getIsSorted: () => false | 'asc' | 'desc';
			getToggleSortingHandler: () => undefined | ((event: unknown) => void);
		};
		table: { options: { meta?: IssuesTableMeta } };
	},
	column: keyof typeof HEADER_LABELS
) {
	return renderComponent(HeaderCell, {
		column,
		label: HEADER_LABELS[column],
		sorted: ctx.column.getIsSorted(),
		onSort: ctx.column.getToggleSortingHandler(),
		meta: ctx.table.options.meta
	});
}

export const issueColumns = columnHelper.columns([
	columnHelper.accessor('status', {
		id: 'status',
		header: (ctx) => headerCell(ctx, 'status'),
		// A badge needs ~100px; the default 64px column shows the bead alone.
		cell: ({ row, table }) =>
			renderComponent(StatusBadge, {
				status: row.original.status,
				compact: (table.options.meta?.columnWidth('status') ?? 0) < STATUS_WORD_WIDTH
			}),
		enableHiding: true,
		sortDescFirst: false,
		meta: { cellClass: CELL_CLASS.status, headerClass: headerClass('status') }
	}),
	columnHelper.accessor('id', {
		id: 'id',
		header: (ctx) => headerCell(ctx, 'id'),
		cell: ({ row, table }) =>
			renderComponent(IssueId, {
				id: row.original.id,
				href: issueDetailHref(table.options.meta?.project_id ?? '', row.original.id)
			}),
		enableHiding: true,
		sortDescFirst: false,
		meta: { cellClass: CELL_CLASS.id, headerClass: headerClass('id') }
	}),
	columnHelper.accessor('title', {
		id: 'title',
		header: (ctx) => headerCell(ctx, 'title'),
		cell: ({ row, table }) =>
			renderComponent(TitleCell, {
				title: row.original.title,
				href: issueDetailHref(table.options.meta?.project_id ?? '', row.original.id)
			}),
		enableHiding: false,
		sortDescFirst: false,
		meta: { cellClass: CELL_CLASS.title, headerClass: headerClass('title') }
	}),
	columnHelper.accessor('issue_type', {
		id: 'type',
		header: (ctx) => headerCell(ctx, 'type'),
		cell: ({ row }) => renderComponent(TypeChip, { type: row.original.issue_type }),
		enableHiding: true,
		sortDescFirst: false,
		meta: { cellClass: CELL_CLASS.type, headerClass: headerClass('type') }
	}),
	columnHelper.accessor('priority', {
		id: 'priority',
		header: (ctx) => headerCell(ctx, 'priority'),
		cell: ({ row }) => renderComponent(PriorityChip, { priority: row.original.priority }),
		enableHiding: true,
		sortDescFirst: false,
		meta: { cellClass: CELL_CLASS.priority, headerClass: headerClass('priority') }
	}),
	columnHelper.accessor('assignee', {
		id: 'assignee',
		header: (ctx) => headerCell(ctx, 'assignee'),
		cell: ({ row }) => renderComponent(AssigneeCell, { assignee: row.original.assignee }),
		enableHiding: true,
		sortDescFirst: false,
		meta: { cellClass: CELL_CLASS.assignee, headerClass: headerClass('assignee') }
	}),
	columnHelper.accessor((issue) => issue.labels, {
		id: 'labels',
		header: (ctx) => headerCell(ctx, 'labels'),
		cell: ({ row }) => renderComponent(LabelsCell, { labels: row.original.labels }),
		enableHiding: true,
		sortDescFirst: false,
		meta: { cellClass: CELL_CLASS.labels, headerClass: headerClass('labels') }
	}),
	columnHelper.accessor((issue) => issue.dependency_count, {
		id: 'deps',
		header: (ctx) => headerCell(ctx, 'deps'),
		cell: ({ row }) =>
			renderComponent(DepsCell, {
				dependency_count: row.original.dependency_count,
				dependent_count: row.original.dependent_count
			}),
		sortDescFirst: true,
		enableHiding: true,
		meta: { cellClass: CELL_CLASS.deps, headerClass: headerClass('deps') }
	}),
	columnHelper.accessor('updated_at', {
		id: 'updated',
		header: (ctx) => headerCell(ctx, 'updated'),
		cell: ({ row }) => relativeShort(row.original.updated_at),
		sortDescFirst: true,
		enableHiding: true,
		meta: { cellClass: CELL_CLASS.updated, headerClass: headerClass('updated') }
	})
]);
