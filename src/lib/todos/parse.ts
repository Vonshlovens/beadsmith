/**
 * Local capture parser for the todo agenda. Pure and
 * deterministic: no network, no model. A line like
 * `ship backups doc tomorrow p1 +beadsmith` becomes a title, a priority, a
 * due date and tags. Only the first priority and the first date are
 * consumed; later ones stay in the title.
 *
 *   priority  p0–p4, !0–!4
 *   dates     today, tomorrow, mon…sunday (next one after today), next week,
 *             next <weekday>, in 3d / in 3 days / in 2 weeks, 2026-11-03,
 *             and `due:` + any single-word form (due:fri, due:2026-11-03, due:3d)
 *   tags      +project, @context
 *   rest      the title
 */
import { addDays, nextWeekday, parseDateOnly, toDateOnly, WEEKDAYS } from './dates.js';

export const DEFAULT_PRIORITY = 2;
const MAX_TAGS = 16;

export type ParsedKind = 'priority' | 'due' | 'tag';

/** One recognized token, in input order, for the preview chip row. */
export interface ParsedToken {
	kind: ParsedKind;
	/** The text as typed, e.g. `p1` or `in 3 days`. */
	source: string;
	/** What it resolved to, e.g. `P1`, `2026-10-31`, `+beadsmith`. */
	value: string;
}

export interface ParsedCapture {
	title: string;
	priority: number;
	/** True when the line named a priority; otherwise {@link DEFAULT_PRIORITY} applies. */
	priority_explicit: boolean;
	/** `YYYY-MM-DD` local date, or null. */
	due_at: string | null;
	tags: string[];
	tokens: ParsedToken[];
}

const TAG = /^[+@][A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
const PRIORITY = /^(?:p|!)([0-4])$/i;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const IN_COMPACT = /^in(\d+)([dw])$/i;
const REL_COMPACT = /^\+?(\d+)([dw])$/i;
const UNIT = /^(d|day|days|w|wk|wks|week|weeks)$/i;
/** Words that introduce a date and are dropped along with it ("by friday"). */
const LEAD_INS = new Set(['by', 'on', 'due', 'until']);

const WEEKDAY_ALIASES: Record<string, number> = {};
WEEKDAYS.forEach((name, index) => {
	WEEKDAY_ALIASES[name] = index;
	WEEKDAY_ALIASES[name.slice(0, 3)] = index;
});
WEEKDAY_ALIASES.tues = 2;
WEEKDAY_ALIASES.thur = 4;
WEEKDAY_ALIASES.thurs = 4;

function weekdayIndex(word: string): number | undefined {
	return WEEKDAY_ALIASES[word.toLowerCase()];
}

function unitDays(amount: number, unit: string): number {
	return unit.toLowerCase().startsWith('w') ? amount * 7 : amount;
}

/**
 * A single-word date form, or undefined. `bare` is false after `due:`, where
 * the compact `3d` form is also allowed.
 */
function dateFromWord(word: string, today: Date, after_due: boolean): Date | undefined {
	const lower = word.toLowerCase();
	if (lower === 'today' || lower === 'tod') {
		return today;
	}
	if (lower === 'tomorrow' || lower === 'tmrw' || lower === 'tom') {
		return addDays(today, 1);
	}
	const weekday = weekdayIndex(lower);
	if (weekday !== undefined) {
		return nextWeekday(today, weekday);
	}
	if (ISO.test(word)) {
		return parseDateOnly(word);
	}
	const compact = IN_COMPACT.exec(word) ?? (after_due ? REL_COMPACT.exec(word) : null);
	if (compact !== null) {
		return addDays(today, unitDays(Number(compact[1]), compact[2]));
	}
	return undefined;
}

interface Match {
	used: number;
	date: Date;
}

/** Match a date at `words[at]`, possibly across several words. */
function matchDate(words: string[], at: number, today: Date): Match | undefined {
	const word = words[at];
	const lower = word.toLowerCase();
	if (lower.startsWith('due:') && word.length > 4) {
		const date = dateFromWord(word.slice(4), today, true);
		return date === undefined ? undefined : { used: 1, date };
	}
	if (lower === 'next') {
		const following = (words[at + 1] ?? '').toLowerCase();
		if (following === 'week') {
			return { used: 2, date: nextWeekday(today, 1) };
		}
		const weekday = weekdayIndex(following);
		if (weekday !== undefined) {
			return { used: 2, date: nextWeekday(today, weekday) };
		}
		return undefined;
	}
	if (lower === 'in') {
		const glued = /^(\d+)([dw])$/i.exec(words[at + 1] ?? '');
		if (glued !== null) {
			return { used: 2, date: addDays(today, unitDays(Number(glued[1]), glued[2])) };
		}
		const amount = /^\d+$/.test(words[at + 1] ?? '') ? Number(words[at + 1]) : undefined;
		const unit = words[at + 2];
		if (amount !== undefined && unit !== undefined && UNIT.test(unit)) {
			return { used: 3, date: addDays(today, unitDays(amount, unit)) };
		}
		return undefined;
	}
	const date = dateFromWord(word, today, false);
	return date === undefined ? undefined : { used: 1, date };
}

/**
 * Parse one capture line.
 * @param input Raw text from the capture field.
 * @param now Reference time; "today" is its local calendar day.
 */
export function parseCapture(input: string, now: Date = new Date()): ParsedCapture {
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const words = input.split(/\s+/).filter((word) => word !== '');
	const title: string[] = [];
	const tokens: ParsedToken[] = [];
	const tags: string[] = [];
	let priority = DEFAULT_PRIORITY;
	let priority_explicit = false;
	let due_at: string | null = null;

	for (let i = 0; i < words.length; i++) {
		const word = words[i];

		const prio = PRIORITY.exec(word);
		if (prio !== null && !priority_explicit) {
			priority = Number(prio[1]);
			priority_explicit = true;
			tokens.push({ kind: 'priority', source: word, value: `P${priority}` });
			continue;
		}

		if (TAG.test(word) && tags.length < MAX_TAGS) {
			const key = word.toLowerCase();
			if (!tags.some((tag) => tag.toLowerCase() === key)) {
				tags.push(word);
				tokens.push({ kind: 'tag', source: word, value: word });
			}
			continue;
		}

		if (due_at === null) {
			const lead = LEAD_INS.has(word.toLowerCase());
			const probe = lead ? i + 1 : i;
			const match = probe < words.length ? matchDate(words, probe, today) : undefined;
			if (match !== undefined) {
				// The lead-in ("by", "on", "due") is consumed with the date.
				due_at = toDateOnly(match.date);
				const end = probe + match.used;
				tokens.push({ kind: 'due', source: words.slice(i, end).join(' '), value: due_at });
				i = end - 1;
				continue;
			}
		}

		title.push(word);
	}

	return { title: title.join(' '), priority, priority_explicit, due_at, tags, tokens };
}
