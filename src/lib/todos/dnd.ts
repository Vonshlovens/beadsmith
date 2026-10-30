/**
 * Drag-and-drop rules for the agenda. Pure: the page owns the
 * events and the mutations.
 *
 * Dropping a card in another column reschedules it:
 *
 *   Today & overdue   today and overdue dates are kept; anything later becomes today
 *   Next 7 days       a date 1–7 days out is kept; anything else becomes tomorrow
 *   Upcoming          a date more than 7 days out is kept; anything else is cleared
 *                     (two columns: a date after today is kept, otherwise cleared)
 *   All (one column)  no date change
 *
 * Dropping at a position in a column sets `sort_key` between the neighbours.
 * Columns follow urgency by default; a reorder switches them to manual order so
 * the drop is not undone by the next sort.
 */
import type { TodoColumn } from './columns.js';
import { addDays, daysUntil, toDateOnly } from './dates.js';
import { SOON_DAYS } from './urgency.js';

export type ColumnId = TodoColumn<unknown>['id'];

/**
 * The `due_at` a card takes when dropped on a column.
 * @returns The new value, or `undefined` when the date stays as it is.
 */
export function dueForColumn(
	column: ColumnId,
	due_at: string | null,
	now: Date
): string | null | undefined {
	const diff = daysUntil(due_at, now);
	switch (column) {
		case 'all':
			return undefined;
		case 'now':
			return diff !== undefined && diff <= 0 ? undefined : toDateOnly(now);
		case 'week':
			return diff !== undefined && diff >= 1 && diff <= SOON_DAYS
				? undefined
				: toDateOnly(addDays(now, 1));
		case 'later':
			return diff !== undefined && diff > SOON_DAYS ? undefined : null;
		case 'rest':
			return diff !== undefined && diff >= 1 ? undefined : null;
	}
}

export interface KeyedTodo {
	id: string;
	sort_key: number;
}

export interface KeyPatch {
	id: string;
	sort_key: number;
}

/**
 * `sort_key` patches that put `moved` at `index` among `others` (the column
 * without it). A strictly increasing pair of neighbours takes the midpoint; at
 * either end the key steps past the neighbour; a tie renumbers the column.
 */
export function placeAt(moved: KeyedTodo, others: readonly KeyedTodo[], index: number): KeyPatch[] {
	const at = Math.max(0, Math.min(index, others.length));
	const prev = others[at - 1];
	const next = others[at];
	if (prev === undefined && next === undefined) {
		return [];
	}
	let key: number;
	if (prev === undefined) {
		key = next.sort_key - 1;
	} else if (next === undefined) {
		key = prev.sort_key + 1;
	} else if (prev.sort_key < next.sort_key) {
		key = (prev.sort_key + next.sort_key) / 2;
	} else {
		const order = [...others.slice(0, at), moved, ...others.slice(at)];
		const base = Math.min(...order.map((item) => item.sort_key));
		return order
			.map((item, i) => ({ id: item.id, sort_key: base + i }))
			.filter((patch) => order.find((item) => item.id === patch.id)?.sort_key !== patch.sort_key);
	}
	return key === moved.sort_key ? [] : [{ id: moved.id, sort_key: key }];
}
