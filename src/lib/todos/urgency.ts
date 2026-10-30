/**
 * Derived todo urgency. Pure and shared by client and server;
 * never stored, so a priority or due-date edit cannot leave a stale score.
 *
 * score = (4 − priority) + due bucket, so P0 is 4 and P4 is 0, and the due
 * bucket adds overdue +3, due today +2, due within the next 7 days +1.
 * The maximum is 7 (a P0 that is overdue). Days are the runtime's local
 * calendar days (the viewer's in the browser): a date-only `due_at`
 * (`2026-10-31`) is that whole local day; a datetime is overdue once its
 * instant has passed and "today" while later on the same local day.
 */

export const MIN_PRIORITY = 0;
export const MAX_PRIORITY = 4;
export const MAX_URGENCY = 7;

/** Days ahead (after today) that still earn the "soon" bucket. */
export const SOON_DAYS = 7;

const DAY_MS = 86_400_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export type DueBucket = 'none' | 'later' | 'soon' | 'today' | 'overdue';

/** The fields urgency and ordering read; `Todo` satisfies it. */
export interface UrgencyInput {
	priority: number;
	due_at?: string | null;
	sort_key?: number;
}

/**
 * A local calendar day as a day index, stable across DST changes.
 * @param year Local year.
 * @param month Local month, 0-based.
 * @param date Local day of month.
 */
function dayIndex(year: number, month: number, date: number): number {
	return Math.floor(Date.UTC(year, month, date) / DAY_MS);
}

/** Local day index of an instant. */
export function localDayIndex(when: Date): number {
	return dayIndex(when.getFullYear(), when.getMonth(), when.getDate());
}

/**
 * Parse a stored `due_at` into `{ day, instant }`: the local day index and,
 * for a datetime, the exact instant (undefined for date-only values, which
 * are local dates rather than UTC midnights).
 * @param due_at ISO date or datetime.
 */
function parseDue(due_at: string): { day: number; instant?: number } | undefined {
	if (DATE_ONLY.test(due_at)) {
		const [y, m, d] = due_at.split('-').map(Number);
		return Number.isNaN(Date.parse(due_at)) ? undefined : { day: dayIndex(y, m - 1, d) };
	}
	const time = Date.parse(due_at);
	if (Number.isNaN(time)) {
		return undefined;
	}
	return { day: localDayIndex(new Date(time)), instant: time };
}

/**
 * Where a due date sits relative to `now`. An unset or unparseable date is `none`.
 * @param due_at ISO date or datetime, if any.
 * @param now Reference time.
 */
export function dueBucket(due_at: string | null | undefined, now: Date): DueBucket {
	if (due_at === null || due_at === undefined || due_at === '') {
		return 'none';
	}
	const due = parseDue(due_at);
	if (due === undefined) {
		return 'none';
	}
	const today = localDayIndex(now);
	if (
		due.day < today ||
		(due.day === today && due.instant !== undefined && due.instant < now.getTime())
	) {
		return 'overdue';
	}
	if (due.day === today) {
		return 'today';
	}
	return due.day - today <= SOON_DAYS ? 'soon' : 'later';
}

const BUCKET_POINTS: Record<DueBucket, number> = {
	none: 0,
	later: 0,
	soon: 1,
	today: 2,
	overdue: 3
};

/**
 * Urgency score from 0 to {@link MAX_URGENCY}. A priority outside P0–P4 is clamped.
 * @param priority P0 (most urgent) to P4.
 * @param due_at ISO date or datetime, if any.
 * @param now Reference time.
 */
export function urgency(priority: number, due_at: string | null | undefined, now: Date): number {
	const clamped = Math.min(MAX_PRIORITY, Math.max(MIN_PRIORITY, Math.round(priority)));
	return MAX_PRIORITY - clamped + BUCKET_POINTS[dueBucket(due_at, now)];
}

/**
 * Urgency scaled to 0–1 for a progress bar (agenda.dev's urgency/5 bar).
 * @param score Value from {@link urgency}.
 */
export function urgencyRatio(score: number): number {
	return Math.min(1, Math.max(0, score / MAX_URGENCY));
}

/** Sortable instant for a due value; date-only means local midnight. NaN when unset. */
function dueTime(due_at: string | null | undefined): number {
	if (!due_at) {
		return Number.NaN;
	}
	const due = parseDue(due_at);
	if (due === undefined) {
		return Number.NaN;
	}
	return due.instant ?? due.day * DAY_MS;
}

/**
 * Sort comparator, most urgent first: higher urgency, then earlier `due_at`
 * (undated last), then lower `sort_key` (manual order).
 * @param now Reference time, fixed once per sort.
 */
export function compareByUrgency(now: Date): (a: UrgencyInput, b: UrgencyInput) => number {
	return (a, b) => {
		const diff = urgency(b.priority, b.due_at, now) - urgency(a.priority, a.due_at, now);
		if (diff !== 0) {
			return diff;
		}
		const a_due = dueTime(a.due_at);
		const b_due = dueTime(b.due_at);
		if (a_due !== b_due && !(Number.isNaN(a_due) && Number.isNaN(b_due))) {
			if (Number.isNaN(a_due)) return 1;
			if (Number.isNaN(b_due)) return -1;
			return a_due - b_due;
		}
		return (a.sort_key ?? 0) - (b.sort_key ?? 0);
	};
}
