/**
 * Sort modes of the tuxedo list view. Pure. `S`-cycle order
 * follows the issue: urgency → due → priority → manual. Reordering with J/K
 * only swaps `sort_key` between neighbours that tie under the active sort, so
 * the visible order never fights the mode (tuxedo's "within sort ties").
 */
import { compareByUrgency, dueBucket, urgency, type DueBucket } from './urgency.js';

export const SORT_MODES = ['urgency', 'due', 'priority', 'manual'] as const;
export type SortMode = (typeof SORT_MODES)[number];

export interface SortableTodo {
	id: string;
	priority: number;
	due_at: string | null;
	sort_key: number;
	created_at: string;
}

/** The mode after `mode` in the cycle (or before it for `step` −1). */
export function cycleSort(mode: SortMode, step: 1 | -1 = 1): SortMode {
	const at = SORT_MODES.indexOf(mode);
	return SORT_MODES[(at + step + SORT_MODES.length) % SORT_MODES.length];
}

/** Read a stored mode, falling back to urgency. */
export function parseSortMode(raw: string | null | undefined): SortMode {
	return (SORT_MODES as readonly string[]).includes(raw ?? '') ? (raw as SortMode) : 'urgency';
}

function dueKey(due_at: string | null): string {
	return due_at === null || due_at === '' ? '￿' : due_at;
}

function byManual(a: SortableTodo, b: SortableTodo): number {
	return (
		a.sort_key - b.sort_key || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)
	);
}

/** Comparator for `mode`. Every mode falls back to manual order. */
export function comparator(
	mode: SortMode,
	now: Date
): (a: SortableTodo, b: SortableTodo) => number {
	const urgent = compareByUrgency(now);
	switch (mode) {
		case 'urgency':
			return (a, b) => urgent(a, b) || byManual(a, b);
		case 'due':
			return (a, b) =>
				dueKey(a.due_at).localeCompare(dueKey(b.due_at)) ||
				a.priority - b.priority ||
				byManual(a, b);
		case 'priority':
			return (a, b) =>
				a.priority - b.priority ||
				dueKey(a.due_at).localeCompare(dueKey(b.due_at)) ||
				byManual(a, b);
		case 'manual':
			return byManual;
	}
}

export function sortTodos<T extends SortableTodo>(
	todos: readonly T[],
	mode: SortMode,
	now: Date
): T[] {
	return [...todos].sort(comparator(mode, now));
}

/** Two todos tie when the active sort cannot tell them apart without `sort_key`. */
export function tiesUnder(mode: SortMode, a: SortableTodo, b: SortableTodo, now: Date): boolean {
	switch (mode) {
		case 'urgency':
			return (
				urgency(a.priority, a.due_at, now) === urgency(b.priority, b.due_at, now) &&
				dueKey(a.due_at) === dueKey(b.due_at)
			);
		case 'due':
			return dueKey(a.due_at) === dueKey(b.due_at);
		case 'priority':
			return a.priority === b.priority && dueKey(a.due_at) === dueKey(b.due_at);
		case 'manual':
			return true;
	}
}

export interface KeyPatch {
	id: string;
	sort_key: number;
}

/**
 * Patches that move `sorted[index]` one place down (`1`) or up (`-1`), or null
 * when the neighbour is outside its tie group or there is none. Moving swaps the
 * two `sort_key`s; equal keys are nudged apart so the swap is visible.
 */
export function reorderPatches(
	sorted: readonly SortableTodo[],
	index: number,
	direction: 1 | -1,
	mode: SortMode,
	now: Date
): KeyPatch[] | null {
	const here = sorted[index];
	const there = sorted[index + direction];
	if (here === undefined || there === undefined || !tiesUnder(mode, here, there, now)) {
		return null;
	}
	if (here.sort_key !== there.sort_key) {
		return [
			{ id: here.id, sort_key: there.sort_key },
			{ id: there.id, sort_key: here.sort_key }
		];
	}
	return [{ id: here.id, sort_key: there.sort_key + direction * 0.5 }];
}

const GROUP_LABELS: Record<DueBucket, string> = {
	overdue: 'Overdue',
	today: 'Today',
	soon: 'Next 7 days',
	later: 'Later',
	none: 'No date'
};

export interface Group<T> {
	key: string;
	label: string;
	items: T[];
}

/** Due-bucket groups in agenda order, for the due sort. Empty groups are dropped. */
export function groupByDue<T extends SortableTodo>(sorted: readonly T[], now: Date): Group<T>[] {
	const order: DueBucket[] = ['overdue', 'today', 'soon', 'later', 'none'];
	return order
		.map((bucket) => ({
			key: bucket,
			label: GROUP_LABELS[bucket],
			items: sorted.filter((todo) => dueBucket(todo.due_at, now) === bucket)
		}))
		.filter((group) => group.items.length > 0);
}

/** Local `YYYY-MM-DD` of an ISO instant; '' when unparseable. */
export function localDate(iso: string | null | undefined): string {
	const time = Date.parse(iso ?? '');
	if (Number.isNaN(time)) {
		return '';
	}
	const when = new Date(time);
	const month = String(when.getMonth() + 1).padStart(2, '0');
	const day = String(when.getDate()).padStart(2, '0');
	return `${when.getFullYear()}-${month}-${day}`;
}

/** Done todos grouped by local completion date, newest day first. */
export function groupByCompletion<T extends { completed_at: string | null }>(
	done: readonly T[]
): Group<T>[] {
	const by_day = new Map<string, T[]>();
	for (const todo of done) {
		const day = localDate(todo.completed_at) || 'unknown';
		by_day.set(day, [...(by_day.get(day) ?? []), todo]);
	}
	return [...by_day.entries()]
		.sort(([a], [b]) => b.localeCompare(a))
		.map(([day, items]) => ({
			key: day,
			label: day,
			items: items.sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''))
		}));
}
