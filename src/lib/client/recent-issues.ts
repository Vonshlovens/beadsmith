/**
 * The issues this browser opened lately, for the palette's Recent group.
 * Kept in localStorage (a UI preference, like the rail width): never sent
 * anywhere, and a missing or unreadable store is just an empty list.
 */
import { browser } from '$app/env';

export interface RecentIssue {
	project_id: string;
	issue_id: string;
	title: string;
	/** Epoch ms of the last visit. */
	at: number;
}

export const RECENT_ISSUES_KEY = 'bdui:recent-issues';
export const RECENT_ISSUES_MAX = 8;

/**
 * Put `entry` first, dropping its older visit and anything past `max`.
 *
 * @param list - Current list, newest first.
 * @param entry - The visit to record.
 * @param max - How many to keep.
 */
export function pushRecent(
	list: readonly RecentIssue[],
	entry: RecentIssue,
	max = RECENT_ISSUES_MAX
): RecentIssue[] {
	const rest = list.filter(
		(item) => !(item.project_id === entry.project_id && item.issue_id === entry.issue_id)
	);
	return [entry, ...rest].slice(0, max);
}

/**
 * Parse a stored list, keeping only well-formed entries.
 *
 * @param raw - The stored JSON, or null.
 */
export function parseRecent(raw: string | null): RecentIssue[] {
	if (!raw) return [];
	try {
		const value: unknown = JSON.parse(raw);
		if (!Array.isArray(value)) return [];
		return value
			.filter((item): item is RecentIssue => {
				return (
					typeof item === 'object' &&
					item !== null &&
					typeof item.project_id === 'string' &&
					typeof item.issue_id === 'string' &&
					typeof item.title === 'string' &&
					typeof item.at === 'number'
				);
			})
			.slice(0, RECENT_ISSUES_MAX);
	} catch {
		return [];
	}
}

/** The stored list, newest first. */
export function loadRecentIssues(): RecentIssue[] {
	if (!browser) return [];
	try {
		return parseRecent(window.localStorage.getItem(RECENT_ISSUES_KEY));
	} catch {
		return [];
	}
}

/**
 * Record a visit to an issue.
 *
 * @param entry - The issue; `at` defaults to now.
 */
export function rememberIssue(entry: Omit<RecentIssue, 'at'> & { at?: number }): void {
	if (!browser || entry.title.length === 0) return;
	try {
		const next = pushRecent(loadRecentIssues(), { ...entry, at: entry.at ?? Date.now() });
		window.localStorage.setItem(RECENT_ISSUES_KEY, JSON.stringify(next));
	} catch {
		/* storage disabled */
	}
}
