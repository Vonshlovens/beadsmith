/**
 * Fold the raw event stream into something a person can scan. Beads records
 * one event per change (claimed, commented, label added), so a busy issue
 * floods the feed. The drawer shows one line per issue per day instead,
 * listing who did what to it, newest first. The raw events stay on
 * /activity.
 */
import type { ActivityEvent } from '#lib/types.js';

export interface ActivityIssueGroup {
	key: string;
	project_id: string;
	project_name: string;
	issue_id: string;
	issue_title?: string;
	/** Distinct actors, most recent first. */
	actors: string[];
	/** Distinct verbs, most recent first. */
	verbs: string[];
	/** Newest event in the group (ISO). */
	latest_at: string;
	count: number;
}

export interface ActivityDay {
	/** Local calendar day, YYYY-MM-DD. */
	day: string;
	label: string;
	groups: ActivityIssueGroup[];
}

/**
 * Read an event type as a verb: `label_added` → `label added`.
 *
 * @param event_type - Raw event type.
 */
export function eventVerb(event_type: string): string {
	return event_type.replace(/[_.]/g, ' ').toLowerCase();
}

function localDay(at: Date): string {
	const month = String(at.getMonth() + 1).padStart(2, '0');
	const day = String(at.getDate()).padStart(2, '0');
	return `${at.getFullYear()}-${month}-${day}`;
}

/**
 * "Today", "Yesterday", else a short date.
 *
 * @param day - YYYY-MM-DD in local time.
 * @param now - Reference time.
 */
export function dayLabel(day: string, now: Date = new Date()): string {
	const today = localDay(now);
	const yesterday = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
	if (day === today) return 'Today';
	if (day === yesterday) return 'Yesterday';
	const [year, month, date] = day.split('-').map(Number);
	const at = new Date(year ?? 1970, (month ?? 1) - 1, date ?? 1);
	return at.toLocaleDateString(undefined, {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' })
	});
}

/**
 * Group events by local day, then by issue within the day.
 *
 * @param events - Any order; the result is newest first.
 * @param now - Reference time for day labels.
 */
export function groupActivity(events: ActivityEvent[], now: Date = new Date()): ActivityDay[] {
	const sorted = [...events].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
	const days: ActivityDay[] = [];
	const by_day = new Map<string, { day: ActivityDay; by_issue: Map<string, ActivityIssueGroup> }>();
	for (const event of sorted) {
		const at = new Date(event.created_at);
		const day = Number.isNaN(at.getTime()) ? 'unknown' : localDay(at);
		let bucket = by_day.get(day);
		if (!bucket) {
			const entry: ActivityDay = {
				day,
				label: day === 'unknown' ? 'Undated' : dayLabel(day, now),
				groups: []
			};
			bucket = { day: entry, by_issue: new Map() };
			by_day.set(day, bucket);
			days.push(entry);
		}
		const key = `${event.project_id}:${event.issue_id}`;
		let group = bucket.by_issue.get(key);
		if (!group) {
			group = {
				key: `${day}:${key}`,
				project_id: event.project_id,
				project_name: event.project_name,
				issue_id: event.issue_id,
				issue_title: event.issue_title,
				actors: [],
				verbs: [],
				latest_at: event.created_at,
				count: 0
			};
			bucket.by_issue.set(key, group);
			bucket.day.groups.push(group);
		}
		group.count += 1;
		group.issue_title ??= event.issue_title;
		if (!group.actors.includes(event.actor)) group.actors.push(event.actor);
		const verb = eventVerb(event.event_type);
		if (!group.verbs.includes(verb)) group.verbs.push(verb);
	}
	return days;
}

/**
 * The newest activity across projects, for the unseen marker on the drawer button.
 *
 * @param stamps - Last-activity ISO stamps, any may be missing.
 */
export function newestStamp(stamps: (string | undefined)[]): number {
	let newest = 0;
	for (const stamp of stamps) {
		const at = stamp ? Date.parse(stamp) : Number.NaN;
		if (!Number.isNaN(at) && at > newest) newest = at;
	}
	return newest;
}
