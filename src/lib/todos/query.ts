/**
 * Search, tag filters and saved searches of the tuxedo list view. Pure. A query is whitespace-separated terms, all of which
 * must match: `+project` / `@context` tags, `p0`–`p4` priority, `due:` (a date,
 * or tuxedo's range grammar `due:+1w` / `due:-3d`; units d, w, m), and plain
 * words against the title. Only the first `due:` term counts.
 */
import { addDays, parseDateOnly, toDateOnly } from './dates.js';

export interface Searchable {
	title: string;
	priority: number;
	due_at: string | null;
	tags: string[];
}

const RANGE = /^due:([+-]?)(\d+)([dwm])$/i;

/** Inclusive `[from, to]` local dates for an offset term, or undefined. */
export function dueRange(term: string, now: Date): [string, string] | undefined {
	const match = RANGE.exec(term);
	if (match === null) {
		return undefined;
	}
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const amount = Number(match[2]);
	const days =
		match[3].toLowerCase() === 'd' ? amount : match[3].toLowerCase() === 'w' ? amount * 7 : 0;
	let end: Date;
	if (match[3].toLowerCase() === 'm') {
		end = new Date(today);
		end.setMonth(end.getMonth() + (match[1] === '-' ? -amount : amount));
	} else {
		end = addDays(today, match[1] === '-' ? -days : days);
	}
	const [from, to] = end < today ? [end, today] : [today, end];
	return [toDateOnly(from), toDateOnly(to)];
}

function dueDay(due_at: string | null): string | undefined {
	if (due_at === null || due_at === '') return undefined;
	const date = parseDateOnly(due_at) ?? new Date(due_at);
	return Number.isNaN(date.getTime()) ? undefined : toDateOnly(date);
}

/**
 * Does `todo` satisfy `query`? An empty query matches everything.
 * @param now Reference time for relative `due:` terms.
 */
export function matchesQuery(todo: Searchable, query: string, now: Date): boolean {
	const terms = query
		.trim()
		.split(/\s+/)
		.filter((term) => term !== '');
	let used_due = false;
	for (const term of terms) {
		const lower = term.toLowerCase();
		if (lower.startsWith('due:') && !used_due) {
			used_due = true;
			const day = dueDay(todo.due_at);
			const range = dueRange(lower, now);
			if (range !== undefined) {
				if (day === undefined || day < range[0] || day > range[1]) return false;
			} else if (day === undefined || !day.startsWith(lower.slice(4))) {
				return false;
			}
			continue;
		}
		if (/^p[0-4]$/.test(lower)) {
			if (todo.priority !== Number(lower[1])) return false;
			continue;
		}
		if (lower[0] === '+' || lower[0] === '@') {
			if (!todo.tags.some((tag) => tag.toLowerCase() === lower)) return false;
			continue;
		}
		if (!todo.title.toLowerCase().includes(lower)) return false;
	}
	return true;
}

export interface TagCount {
	tag: string;
	count: number;
}

/** Tag counts for the sidebar: `+` projects and `@` contexts, busiest first. */
export function tagCounts(todos: readonly { tags: string[] }[], sigil: '+' | '@'): TagCount[] {
	const counts = new Map<string, number>();
	for (const todo of todos) {
		for (const tag of todo.tags) {
			if (tag.startsWith(sigil)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
		}
	}
	return [...counts.entries()]
		.map(([tag, count]) => ({ tag, count }))
		.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/**
 * Next value in a cycle `[none, ...options]` (`fp` / `fc` / `ff`), where null
 * means "no filter". `step` −1 goes back; wraps through none.
 */
export function cycleFilter(
	options: readonly string[],
	current: string | null,
	step: 1 | -1
): string | null {
	const ring: (string | null)[] = [null, ...options];
	const at = Math.max(0, ring.indexOf(current));
	return ring[(at + step + ring.length) % ring.length];
}

/** Saved searches: name → query, as stored under settings `todos.filters`. */
export type SavedFilters = Record<string, string>;

/** Parse the stored JSON defensively; junk yields no filters. */
export function parseSavedFilters(raw: string | null | undefined): SavedFilters {
	try {
		const value: unknown = JSON.parse(raw ?? '{}');
		if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
		const out: SavedFilters = {};
		for (const [name, query] of Object.entries(value)) {
			if (typeof query === 'string' && name.length > 0 && name.length <= 60) out[name] = query;
		}
		return out;
	} catch {
		return {};
	}
}

/** A short name for an unnamed save: the query itself, trimmed. */
export function defaultFilterName(query: string): string {
	return query.trim().replace(/\s+/g, ' ').slice(0, 40);
}
