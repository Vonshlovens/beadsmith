/**
 * Due-date columns for the agenda (agenda.dev `getColumnTodos`).
 *
 *   1 column   everything, most urgent first
 *   2 columns  today + overdue | the rest
 *   3 columns  today + overdue | next 7 days | upcoming and undated
 *
 * Within a column cards follow {@link compareByUrgency}; the first column
 * lists today's cards before overdue ones, as agenda.dev does.
 */
import { daysUntil } from './dates.js';
import { compareByUrgency, SOON_DAYS, type UrgencyInput } from './urgency.js';

export type ColumnCount = 1 | 2 | 3;

export interface TodoColumn<T> {
	id: 'all' | 'now' | 'week' | 'later' | 'rest';
	label: string;
	todos: T[];
}

type Dated = UrgencyInput & { due_at?: string | null };

/** `urgency` sorts each column by {@link compareByUrgency}; `manual` by `sort_key` (set by dragging). */
export type ColumnOrder = 'urgency' | 'manual';

/** Which of `count` columns a todo belongs to. */
export function columnIndex(
	due_at: string | null | undefined,
	count: ColumnCount,
	now: Date
): number {
	if (count === 1) {
		return 0;
	}
	const diff = daysUntil(due_at, now);
	if (diff !== undefined && diff <= 0) {
		return 0;
	}
	if (count === 3 && diff !== undefined && diff <= SOON_DAYS) {
		return 1;
	}
	return count - 1;
}

/**
 * Split todos into columns.
 * @param todos Open todos in any order.
 * @param count 1, 2 or 3 columns, by viewport.
 * @param now Reference time, fixed once per render.
 * @param order How cards are ordered inside a column.
 */
export function groupIntoColumns<T extends Dated>(
	todos: readonly T[],
	count: ColumnCount,
	now: Date,
	order: ColumnOrder = 'urgency'
): TodoColumn<T>[] {
	const sort =
		order === 'manual'
			? (a: Dated, b: Dated) => (a.sort_key ?? 0) - (b.sort_key ?? 0)
			: compareByUrgency(now);
	const defs: Pick<TodoColumn<T>, 'id' | 'label'>[] =
		count === 1
			? [{ id: 'all', label: 'All' }]
			: count === 2
				? [
						{ id: 'now', label: 'Today & overdue' },
						{ id: 'rest', label: 'Upcoming' }
					]
				: [
						{ id: 'now', label: 'Today & overdue' },
						{ id: 'week', label: 'Next 7 days' },
						{ id: 'later', label: 'Upcoming' }
					];
	const columns: TodoColumn<T>[] = defs.map((def) => ({ ...def, todos: [] }));
	for (const todo of todos) {
		columns[columnIndex(todo.due_at, count, now)].todos.push(todo);
	}
	for (const column of columns) {
		column.todos.sort(sort);
	}
	if (count > 1 && order === 'urgency') {
		const first = columns[0].todos;
		const today = first.filter((todo) => daysUntil(todo.due_at, now) === 0);
		const overdue = first.filter((todo) => daysUntil(todo.due_at, now) !== 0);
		columns[0].todos = [...today, ...overdue];
	}
	return columns;
}
