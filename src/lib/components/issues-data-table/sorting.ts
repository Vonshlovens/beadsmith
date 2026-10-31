/**
 * Bridge Beads sort state to TanStack's `SortingState`. The table owns the
 * click cycle through `getToggleSortingHandler`; the page still reads the
 * same `{ column, direction }` shape for the toolbar chip.
 */
import type { SortingState } from '@tanstack/svelte-table';
import { SORT_COLUMNS, UNSORTED } from '$lib/client/sort.js';
import type { SortColumn, SortState } from '$lib/client/sort.js';

/**
 * Whether an untrusted column id is one the issues table can sort on.
 *
 * @param id - Candidate column id from TanStack state.
 */
function isSortColumn(id: string): id is SortColumn {
	return (SORT_COLUMNS as readonly string[]).includes(id);
}

/**
 * Convert Beads sort state into the single-column TanStack sorting array.
 * An unsorted table is an empty array, which is also TanStack's default.
 *
 * @param sort - The toolbar/table sort the page currently holds.
 */
export function toSortingState(sort: SortState): SortingState {
	if (sort.column === null) {
		return [];
	}

	return [{ id: sort.column, desc: sort.direction === 'desc' }];
}

/**
 * Convert TanStack sorting back to Beads sort state. Unknown ids and an empty
 * array both mean "the order the database returned".
 *
 * @param sorting - TanStack sorting state after a header click.
 */
export function fromSortingState(sorting: SortingState): SortState {
	const first = sorting[0];
	if (!first || !isSortColumn(first.id)) {
		return UNSORTED;
	}

	return { column: first.id, direction: first.desc ? 'desc' : 'asc' };
}
