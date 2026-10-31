/**
 * Local-calendar date helpers for todos. Date-only values
 * (`2026-10-31`) are local dates, matching `urgency.ts`.
 */
import { localDayIndex } from './urgency.js';

const DAY_MS = 86_400_000;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

export const WEEKDAYS = [
	'sunday',
	'monday',
	'tuesday',
	'wednesday',
	'thursday',
	'friday',
	'saturday'
] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `YYYY-MM-DD` of a date's local calendar day. */
export function toDateOnly(when: Date): string {
	const y = String(when.getFullYear()).padStart(4, '0');
	const m = String(when.getMonth() + 1).padStart(2, '0');
	const d = String(when.getDate()).padStart(2, '0');
	return `${y}-${m}-${d}`;
}

/** Local midnight of `date` moved by `days` calendar days. */
export function addDays(date: Date, days: number): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/**
 * The next occurrence of a weekday strictly after `from` (so "fri" on a Friday is a week out).
 * @param weekday 0 = Sunday … 6 = Saturday.
 */
export function nextWeekday(from: Date, weekday: number): Date {
	const ahead = ((weekday - from.getDay() + 6) % 7) + 1;
	return addDays(from, ahead);
}

/** A real calendar date for `YYYY-MM-DD` (rejects `2026-02-31`), or undefined. */
export function parseDateOnly(value: string): Date | undefined {
	const match = DATE_ONLY.exec(value);
	if (match === null) {
		return undefined;
	}
	const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
	const date = new Date(y, m - 1, d);
	return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d
		? date
		: undefined;
}

/** Whole local days from `now`'s day to the day of `due_at`; undefined when unset or invalid. */
export function daysUntil(due_at: string | null | undefined, now: Date): number | undefined {
	if (!due_at) {
		return undefined;
	}
	const date = parseDateOnly(due_at) ?? new Date(due_at);
	if (Number.isNaN(date.getTime())) {
		return undefined;
	}
	return localDayIndex(date) - localDayIndex(now);
}

/** `HH:MM` suffix for a datetime due value, empty for a date-only one. */
function timeSuffix(due_at: string): string {
	if (DATE_ONLY.test(due_at)) {
		return '';
	}
	const date = new Date(due_at);
	const hh = String(date.getHours()).padStart(2, '0');
	const mm = String(date.getMinutes()).padStart(2, '0');
	return ` ${hh}:${mm}`;
}

/**
 * Short human due label: `today`, `tomorrow`, `3d overdue`, `fri`, `Nov 3`.
 * @param due_at ISO date or datetime.
 * @param now Reference time.
 */
export function dueLabel(due_at: string | null | undefined, now: Date): string {
	const diff = daysUntil(due_at, now);
	if (diff === undefined || !due_at) {
		return 'no date';
	}
	const time = timeSuffix(due_at);
	if (diff < 0) {
		return diff === -1 ? `yesterday${time}` : `${-diff}d overdue`;
	}
	if (diff === 0) {
		return `today${time}`;
	}
	if (diff === 1) {
		return `tomorrow${time}`;
	}
	const date = parseDateOnly(due_at) ?? new Date(due_at);
	if (diff < 7) {
		return `${WEEKDAYS[date.getDay()].slice(0, 3)}${time}`;
	}
	const year = date.getFullYear() === now.getFullYear() ? '' : ` ${date.getFullYear()}`;
	return `${MONTHS[date.getMonth()]} ${date.getDate()}${year}${time}`;
}

export { DAY_MS };
