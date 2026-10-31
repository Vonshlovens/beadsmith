/**
 * TanStack Table v9 feature set for the issues list. shadcn-svelte's data
 * table is this object plus the Table primitives — not a packaged component —
 * so the list opts into sorting and visibility here and leaves pagination,
 * filtering, and row selection out. URL filters and the Beads slack-column
 * resize stay outside the table.
 */
import {
	columnVisibilityFeature,
	metaHelper,
	rowSortingFeature,
	tableFeatures
} from '@tanstack/svelte-table';
import type { ColumnId } from '$lib/client/columns.js';

/** Per-table callbacks the header cells need for the Beads resize grip. */
export type IssuesTableMeta = {
	project_id: string;
	resizing_column: ColumnId | null;
	columnWidth: (column: ColumnId) => number;
	startResize: (event: PointerEvent, column: ColumnId) => void;
	moveResize: (event: PointerEvent) => void;
	endResize: (event: PointerEvent) => void;
	onGripKeydown: (event: KeyboardEvent, column: ColumnId) => void;
	resetColumnWidth: (column: ColumnId) => void;
};

/** Cell/header class names the stylesheet already keys alignment off. */
export type IssuesColumnMeta = {
	cellClass: string;
	headerClass: string;
};

export const features = tableFeatures({
	columnVisibilityFeature,
	rowSortingFeature,
	tableMeta: metaHelper<IssuesTableMeta>(),
	columnMeta: metaHelper<IssuesColumnMeta>()
});

export type IssuesTableFeatures = typeof features;
