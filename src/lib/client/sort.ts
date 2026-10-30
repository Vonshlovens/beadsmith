/**
 * Client-side sorting for the issues table.
 *
 * Sorting never touches the URL or `load`: the rows are already in memory, so
 * reordering them is instant and a click never costs a round trip. The trade
 * is that a sort is not shareable and does not survive leaving the route,
 * which is the right way round for a control you click while reading.
 */
import { statusKey, STATUS_KEYS } from '$lib/client/format';
import type { IssueSummary } from '$lib/types';

/** Sortable columns, in the order the table renders them. */
export const SORT_COLUMNS = [
	'status',
	'id',
	'title',
	'type',
	'priority',
	'assignee',
	'labels',
	'deps',
	'updated'
] as const;

export type SortColumn = (typeof SORT_COLUMNS)[number];
export type SortDirection = 'asc' | 'desc';

export interface SortState {
	/** `null` means "the order the database returned". */
	column: SortColumn | null;
	direction: SortDirection;
}

export const UNSORTED: SortState = { column: null, direction: 'asc' };

/**
 * Which direction a column starts in. Recency and urgency read best with the
 * most interesting rows first, so those columns open descending.
 */
const DESCENDING_FIRST = new Set<SortColumn>(['updated', 'deps']);

/**
 * Advance the sort state for a header click: first click sorts, second
 * reverses, third returns to the database order.
 *
 * @param current - The state before the click.
 * @param column - The column whose header was clicked.
 */
export function nextSort(current: SortState, column: SortColumn): SortState {
	if (current.column !== column) {
		return { column, direction: DESCENDING_FIRST.has(column) ? 'desc' : 'asc' };
	}
	const opened_with: SortDirection = DESCENDING_FIRST.has(column) ? 'desc' : 'asc';
	if (current.direction === opened_with) {
		return { column, direction: opened_with === 'asc' ? 'desc' : 'asc' };
	}
	return UNSORTED;
}

/**
 * The `aria-sort` value for one header, given the active sort.
 *
 * @param state - The active sort.
 * @param column - The column being described.
 */
export function ariaSort(
	state: SortState,
	column: SortColumn
): 'ascending' | 'descending' | 'none' {
	if (state.column !== column) {
		return 'none';
	}
	return state.direction === 'asc' ? 'ascending' : 'descending';
}

/** Status ordering: the workflow order, not the alphabet. */
const STATUS_RANK = new Map<string, number>(STATUS_KEYS.map((key, index) => [key, index]));

/** Text comparison that keeps `prj-9` before `prj-10`. */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * The value a column sorts on. Strings compare through the collator, numbers
 * compare numerically, and every "nothing here" case sorts last in ascending
 * order so empty rows do not crowd the top.
 *
 * @param issue - The row being ranked.
 * @param column - The column doing the ranking.
 */
function sortValue(issue: IssueSummary, column: SortColumn): string | number {
	switch (column) {
		case 'status':
			return STATUS_RANK.get(statusKey(issue.status)) ?? STATUS_KEYS.length;
		case 'id':
			return issue.id;
		case 'title':
			return issue.title;
		case 'type':
			return issue.issue_type || '￿';
		case 'priority':
			return Number.isFinite(issue.priority) ? issue.priority : Number.MAX_SAFE_INTEGER;
		case 'assignee':
			return issue.assignee || '￿';
		case 'labels':
			return issue.labels.length > 0 ? issue.labels.slice().sort(collator.compare)[0] : '￿';
		case 'deps':
			// One number for a column that shows two: what blocks this row is the
			// reason to look at it, and dependents break the ties.
			return issue.dependency_count * 1000 + issue.dependent_count;
		case 'updated':
			return Date.parse(issue.updated_at) || 0;
	}
}

/**
 * Compare two issues on one column, ignoring sort direction. Equal keys fall
 * through as `0` so the caller can break ties (the table always uses id).
 *
 * @param left - First issue.
 * @param right - Second issue.
 * @param column - Column to compare on.
 */
export function compareIssueColumn(
	left: IssueSummary,
	right: IssueSummary,
	column: SortColumn
): number {
	const a = sortValue(left, column);
	const b = sortValue(right, column);

	if (typeof a === 'number' && typeof b === 'number') {
		return a - b;
	}

	return collator.compare(String(a), String(b));
}

/**
 * Sort a copy of the rows. An unsorted state returns the input order, and
 * every sort falls back to the id so equal keys stay in a stable, predictable
 * order rather than drifting between renders.
 *
 * @param issues - Rows to sort.
 * @param state - The active sort.
 */
export function sortIssues(issues: IssueSummary[], state: SortState): IssueSummary[] {
	if (state.column === null) {
		return issues;
	}

	const column = state.column;
	const sign = state.direction === 'asc' ? 1 : -1;

	return issues.slice().sort((a, b) => {
		const order = compareIssueColumn(a, b, column);
		return order === 0 ? collator.compare(a.id, b.id) : order * sign;
	});
}
