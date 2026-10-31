/**
 * Presentation helpers shared by every screen: relative stamps, id splitting,
 * and the status/priority vocabulary the design system encodes as beads.
 */
import type { DispatchStatus, Project } from '$lib/types';

/** Status values that have a bead and a badge in the design system. */
export const STATUS_KEYS = [
	'open',
	'in_progress',
	'blocked',
	'deferred',
	'closed',
	'pinned',
	'hooked'
] as const;

export type StatusKey = (typeof STATUS_KEYS)[number];

/**
 * Normalise a server status string to a design-system status key.
 *
 * @param status - Raw status from `bd` or SQL.
 */
export function statusKey(status: string | undefined): StatusKey {
	const normalized = (status ?? '')
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, '_');
	return (STATUS_KEYS as readonly string[]).includes(normalized)
		? (normalized as StatusKey)
		: 'open';
}

/**
 * Human-readable status label. Text always accompanies the coloured bead.
 *
 * @param status - Raw status string.
 */
export function statusLabel(status: string | undefined): string {
	return statusKey(status).replace('_', ' ');
}

/** Priority names, indexed by numeric priority. */
const PRIORITY_NAMES = ['Critical', 'High', 'Medium', 'Low', 'Backlog'];

/**
 * Describe a numeric priority in words.
 *
 * @param priority - Priority 0–4.
 */
export function priorityName(priority: number | undefined): string {
	if (priority === undefined || priority === null) {
		return 'Unset';
	}
	return PRIORITY_NAMES[priority] ?? `P${priority}`;
}

/**
 * Clamp a priority to the 0–4 chip range used for styling.
 *
 * @param priority - Priority value from the server.
 */
export function priorityClass(priority: number | undefined): string {
	if (priority === undefined || priority === null) {
		return 'prio-4';
	}
	const clamped = Math.min(4, Math.max(0, Math.trunc(priority)));
	return `prio-${clamped}`;
}

/**
 * Split an issue id into its dimmed project prefix and bright short suffix.
 *
 * @param id - Full issue id, e.g. `acme-platform-0sd`.
 */
export function splitIssueId(id: string): { prefix: string; suffix: string } {
	const index = id.lastIndexOf('-');
	if (index <= 0) {
		return { prefix: '', suffix: id };
	}
	return { prefix: id.slice(0, index + 1), suffix: id.slice(index + 1) };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Terse relative stamp used in dense rows: `6m`, `3h`, `9d`.
 *
 * @param iso - ISO timestamp.
 * @param now - Reference time, for deterministic tests.
 */
export function relativeShort(iso: string | undefined, now = Date.now()): string {
	if (!iso) {
		return '—';
	}
	const then = Date.parse(iso);
	if (Number.isNaN(then)) {
		return '—';
	}

	const delta = Math.max(0, now - then);
	if (delta < MINUTE) {
		return 'now';
	}
	if (delta < HOUR) {
		return `${Math.floor(delta / MINUTE)}m`;
	}
	if (delta < DAY) {
		return `${Math.floor(delta / HOUR)}h`;
	}
	return `${Math.floor(delta / DAY)}d`;
}

/**
 * Sentence-shaped relative stamp: `6 min ago`, `2 days ago`.
 *
 * @param iso - ISO timestamp.
 * @param now - Reference time, for deterministic tests.
 */
export function relativeLong(iso: string | undefined, now = Date.now()): string {
	if (!iso) {
		return 'never';
	}
	const then = Date.parse(iso);
	if (Number.isNaN(then)) {
		return 'never';
	}

	const delta = Math.max(0, now - then);
	if (delta < MINUTE) {
		return 'just now';
	}
	if (delta < HOUR) {
		const n = Math.floor(delta / MINUTE);
		return `${n} min ago`;
	}
	if (delta < DAY) {
		const n = Math.floor(delta / HOUR);
		return n === 1 ? '1 hour ago' : `${n} hours ago`;
	}
	const days = Math.floor(delta / DAY);
	return days === 1 ? '1 day ago' : `${days} days ago`;
}

/**
 * Absolute stamp for metadata rows: `24 Jul 2026, 16:38`.
 *
 * @param iso - ISO timestamp.
 */
export function absoluteStamp(iso: string | undefined): string {
	if (!iso) {
		return '—';
	}
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return '—';
	}
	return date.toLocaleString(undefined, {
		day: 'numeric',
		month: 'short',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit'
	});
}

export interface HealthPip {
	cls: string;
	dot: string;
	label: string;
}

/**
 * Health pip for a project card: words first, colour second.
 *
 * Remote is the only architecture, so a healthy project with issues has no
 * pip. The pip exists to distinguish an empty project from a failed count
 * load — the two used to look the same.
 *
 * @param project - The project to describe.
 */
export function projectHealth(project: Project): HealthPip | null {
	if (project.counts === undefined) {
		return { cls: 'health-warn', dot: 'dot-deferred', label: 'Unavailable' };
	}
	if (project.counts.total === 0) {
		return { cls: 'health-ok', dot: 'dot-closed', label: 'Empty' };
	}
	return null;
}

/** Dependency-type labels, in the vocabulary the rail uses. */
const DEP_LABELS: Record<string, string> = {
	blocks: 'blocks',
	'blocked-by': 'blocked by',
	blocked_by: 'blocked by',
	related: 'related',
	'parent-child': 'parent',
	parent_child: 'parent',
	parent: 'parent',
	child: 'child',
	'discovered-from': 'discovered from',
	discovered_from: 'discovered from',
	discovered: 'discovered'
};

/**
 * Label a dependency edge for the relationships rail.
 *
 * @param dep_type - Raw dependency type.
 * @param direction - `up` for things this issue waits on, `down` for the rest.
 */
export function depLabel(dep_type: string | undefined, direction: 'up' | 'down'): string {
	const key = (dep_type ?? '').trim().toLowerCase();
	if (key === 'blocks') {
		return direction === 'up' ? 'blocked by' : 'blocks';
	}
	if (key === 'parent-child' || key === 'parent_child') {
		return direction === 'up' ? 'parent' : 'child';
	}
	if (key === 'discovered-from' || key === 'discovered_from') {
		return direction === 'up' ? 'discovered from' : 'discovered';
	}
	return DEP_LABELS[key] ?? key ?? 'related';
}

const DISPATCH_BADGE: Record<DispatchStatus, StatusKey> = {
	queued: 'deferred',
	launching: 'in_progress',
	launched: 'hooked',
	running: 'in_progress',
	succeeded: 'closed',
	cancelled: 'deferred',
	failed: 'blocked'
};

/**
 * Map a File/Tackle workflow status onto an existing badge colour.
 *
 * @param status - Durable dispatch status.
 */
export function dispatchBadgeKey(status: DispatchStatus): StatusKey {
	return DISPATCH_BADGE[status] ?? 'open';
}

/**
 * Bucket the meter segments of a project card into percentages.
 *
 * @param counts - Issue counts for one project.
 */
export function meterSegments(
	counts: Project['counts']
): { key: string; pct: number; color: string }[] {
	if (!counts || counts.total <= 0) {
		return [];
	}
	const total = counts.total;
	const pct = (n: number) => Math.round((n / total) * 1000) / 10;
	return [
		{ key: 'open', pct: pct(counts.open), color: 'var(--mint)' },
		{ key: 'in_progress', pct: pct(counts.in_progress), color: 'var(--amber)' },
		{ key: 'blocked', pct: pct(counts.blocked), color: 'var(--em-500)' },
		{ key: 'closed', pct: pct(counts.closed), color: 'var(--s5)' }
	].filter((segment) => segment.pct > 0);
}
