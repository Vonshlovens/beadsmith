/**
 * A minimal five-field cron for automations (ADR-0019 rule 7): minute, hour,
 * day of month, month, day of week, evaluated in an IANA time zone.
 *
 * Each field takes `*`, a number, a range `a-b`, a step `*\/n` or `a-b/n`, and
 * comma lists of those. Months and weekdays also take three-letter English
 * names; weekday 7 is Sunday, as 0 is. Written here rather than added as a
 * dependency because Beadsmith needs only matching and slot search, and every
 * new package costs a lockfile and Nix hash refresh.
 *
 * Restricting both day of month and day of week is refused. Classic cron
 * fires when either matches, which surprises people who read the two as
 * "and"; ralph's own scheduler refuses the same combination. Write two
 * automations instead.
 *
 * Wall-clock semantics follow the zone: a time skipped by a daylight-saving
 * jump never fires that day, and a time repeated when clocks go back fires
 * at each occurrence, because a slot is an instant, not a local time.
 */

export class CronError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CronError';
	}
}

/** A parsed expression: the allowed values of each field. */
export interface CronSchedule {
	minutes: ReadonlySet<number>;
	hours: ReadonlySet<number>;
	days_of_month: ReadonlySet<number>;
	months: ReadonlySet<number>;
	/** 0 = Sunday … 6 = Saturday. */
	days_of_week: ReadonlySet<number>;
}

interface FieldSpec {
	name: string;
	min: number;
	max: number;
	names?: readonly string[];
}

const MONTH_NAMES = [
	'jan',
	'feb',
	'mar',
	'apr',
	'may',
	'jun',
	'jul',
	'aug',
	'sep',
	'oct',
	'nov',
	'dec'
] as const;
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

const FIELDS: readonly FieldSpec[] = [
	{ name: 'minute', min: 0, max: 59 },
	{ name: 'hour', min: 0, max: 23 },
	{ name: 'day of month', min: 1, max: 31 },
	// Names map to 1-12: index + min.
	{ name: 'month', min: 1, max: 12, names: MONTH_NAMES },
	// 7 is accepted as Sunday and folded to 0 after parsing.
	{ name: 'day of week', min: 0, max: 7, names: DAY_NAMES }
];

/** The longest expression accepted; generous for lists, small for storage. */
export const CRON_MAX_LENGTH = 120;

function parseValue(raw: string, spec: FieldSpec): number {
	const lower = raw.toLowerCase();
	const named = spec.names?.indexOf(lower) ?? -1;
	if (named >= 0) return named + (spec.names === MONTH_NAMES ? 1 : 0);
	if (!/^\d{1,2}$/.test(raw)) {
		throw new CronError(`${spec.name}: "${raw}" is not a number`);
	}
	const value = Number(raw);
	if (value < spec.min || value > spec.max) {
		throw new CronError(`${spec.name}: ${value} is outside ${spec.min}-${spec.max}`);
	}
	return value;
}

function parseField(raw: string, spec: FieldSpec): { values: Set<number>; star: boolean } {
	const values = new Set<number>();
	let star = false;
	for (const part of raw.split(',')) {
		if (part.length === 0) throw new CronError(`${spec.name}: empty list item`);
		const [range, step_raw, extra] = part.split('/');
		if (extra !== undefined) throw new CronError(`${spec.name}: "${part}" has two steps`);
		let step = 1;
		if (step_raw !== undefined) {
			if (!/^\d{1,2}$/.test(step_raw) || Number(step_raw) < 1) {
				throw new CronError(`${spec.name}: step "${step_raw}" must be a positive number`);
			}
			step = Number(step_raw);
		}
		let low: number;
		let high: number;
		if (range === '*') {
			low = spec.min;
			high = spec.max;
			if (step === 1) star = true;
		} else if (range.includes('-')) {
			const [a, b, more] = range.split('-');
			if (more !== undefined || a === undefined || b === undefined) {
				throw new CronError(`${spec.name}: "${range}" is not a range`);
			}
			low = parseValue(a, spec);
			high = parseValue(b, spec);
			if (low > high) throw new CronError(`${spec.name}: range "${range}" runs backwards`);
		} else {
			low = parseValue(range, spec);
			// `5/15` means from 5 to the end in steps of 15, as in Vixie cron.
			high = step_raw === undefined ? low : spec.max;
		}
		for (let value = low; value <= high; value += step) values.add(value);
	}
	return { values, star };
}

/**
 * Parse a five-field expression.
 * @throws CronError naming the field at fault.
 */
export function parseCron(expression: string): CronSchedule {
	const trimmed = expression.trim();
	if (trimmed.length === 0) throw new CronError('the schedule is empty');
	if (trimmed.length > CRON_MAX_LENGTH) throw new CronError('the schedule is too long');
	const parts = trimmed.split(/\s+/);
	if (parts.length !== 5) {
		throw new CronError(
			`a schedule has five fields (minute hour day-of-month month day-of-week), not ${parts.length}`
		);
	}
	const [minutes, hours, dom, months, dow] = parts.map((part, index) =>
		parseField(part, FIELDS[index] as FieldSpec)
	) as [
		ReturnType<typeof parseField>,
		ReturnType<typeof parseField>,
		ReturnType<typeof parseField>,
		ReturnType<typeof parseField>,
		ReturnType<typeof parseField>
	];
	if (!dom.star && !dow.star) {
		throw new CronError(
			'restrict day of month or day of week, not both: cron would fire on either, not both'
		);
	}
	const days_of_week = new Set([...dow.values].map((day) => day % 7));
	return {
		minutes: minutes.values,
		hours: hours.values,
		days_of_month: dom.values,
		months: months.values,
		days_of_week
	};
}

/**
 * Whether `zone` is an IANA time zone this runtime knows.
 * @param zone For example `Europe/London` or `UTC`.
 */
export function isTimeZone(zone: string): boolean {
	if (zone.length === 0 || zone.length > 64) return false;
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: zone });
		return true;
	} catch {
		return false;
	}
}

interface WallClock {
	month: number;
	day: number;
	weekday: number;
	hour: number;
	minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
	let formatter = formatters.get(zone);
	if (formatter === undefined) {
		formatter = new Intl.DateTimeFormat('en-US', {
			timeZone: zone,
			hourCycle: 'h23',
			month: 'numeric',
			day: 'numeric',
			weekday: 'short',
			hour: 'numeric',
			minute: 'numeric'
		});
		formatters.set(zone, formatter);
	}
	return formatter;
}

function wallClock(instant_ms: number, zone: string): WallClock {
	const fields: Record<string, string> = {};
	for (const part of formatterFor(zone).formatToParts(instant_ms)) fields[part.type] = part.value;
	return {
		month: Number(fields.month),
		day: Number(fields.day),
		weekday: DAY_NAMES.indexOf((fields.weekday ?? '').toLowerCase() as (typeof DAY_NAMES)[number]),
		hour: Number(fields.hour),
		minute: Number(fields.minute)
	};
}

const MINUTE_MS = 60_000;

/** Floor an instant to its UTC minute; slots are whole minutes. */
export function floorToMinute(instant_ms: number): number {
	return Math.floor(instant_ms / MINUTE_MS) * MINUTE_MS;
}

/**
 * How far to search for a slot. Five years covers a 29 February schedule
 * across any leap-year gap; an expression that never matches (30 February)
 * returns undefined after that.
 */
const SEARCH_LIMIT_MS = 5 * 366 * 24 * 60 * MINUTE_MS;

/**
 * Walk minute instants from `start_ms` (inclusive) in `direction` to the
 * first one the schedule matches in `zone`. Whole hours whose day or hour
 * cannot match are skipped at once, so a search costs hours, not minutes.
 * The skip is measured from the zone's wall-clock minute, so it lands on the
 * zone's hour boundary whatever its offset (half-hour zones included); across
 * a daylight-saving jump it lands on the first wall-clock minute that exists.
 */
function search(
	schedule: CronSchedule,
	zone: string,
	start_ms: number,
	direction: 1 | -1
): Date | undefined {
	let at = floorToMinute(start_ms);
	const limit = at + direction * SEARCH_LIMIT_MS;
	while (direction === 1 ? at <= limit : at >= limit) {
		const wall = wallClock(at, zone);
		const day_ok =
			schedule.months.has(wall.month) &&
			schedule.days_of_month.has(wall.day) &&
			schedule.days_of_week.has(wall.weekday);
		if (!day_ok || !schedule.hours.has(wall.hour)) {
			// Next hour's first minute, or the previous hour's last minute.
			at += direction === 1 ? (60 - wall.minute) * MINUTE_MS : -(wall.minute + 1) * MINUTE_MS;
			continue;
		}
		if (schedule.minutes.has(wall.minute)) return new Date(at);
		at += direction * MINUTE_MS;
	}
	return undefined;
}

/** The first slot strictly after `after`, or undefined if none in five years. */
export function nextSlot(schedule: CronSchedule, zone: string, after: Date): Date | undefined {
	return search(schedule, zone, floorToMinute(after.getTime()) + MINUTE_MS, 1);
}

/** The latest slot at or before `at`, or undefined if none in five years. */
export function latestSlot(schedule: CronSchedule, zone: string, at: Date): Date | undefined {
	return search(schedule, zone, at.getTime(), -1);
}

/** The next `count` slots after `after`, for previews. */
export function upcomingSlots(
	schedule: CronSchedule,
	zone: string,
	after: Date,
	count: number
): Date[] {
	const slots: Date[] = [];
	let cursor = after;
	while (slots.length < count) {
		const next = nextSlot(schedule, zone, cursor);
		if (next === undefined) break;
		slots.push(next);
		cursor = next;
	}
	return slots;
}
