/**
 * Presentational grouping for the project issues board.
 *
 * Columns follow STATUS_KEYS. The page already filters the issue set; this
 * module decides which columns appear and the order of cards inside them.
 * Collapse prefs live in board-prefs.ts. Drag-to-dispatch lives in
 * board-dispatch.ts. Keyboard focus and the Send-to-agent menu live in
 * board-keyboard.ts and share that same map. Column create is File dispatch
 * with an optional target status.
 */
import { statusKey, statusLabel, STATUS_KEYS } from './format.js';
import type { StatusKey } from './format.js';
import type { IssueSummary } from '$lib/types';

export interface BoardColumnOptions {
	/** Active status filter from the URL; empty means "any". */
	status_filter: readonly string[];
	/** When false, the closed column is hidden unless the status filter names it. */
	include_closed: boolean;
}

export interface BoardColumn {
	status: StatusKey;
	label: string;
	issues: IssueSummary[];
}

/** Text comparison that keeps `prj-9` before `prj-10` when timestamps tie. */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Which status columns the board should paint.
 *
 * A status filter shows only those columns (including empty ones). Otherwise
 * every STATUS_KEYS column appears, except `closed` which follows include_closed.
 *
 * @param options - Status filter and closed-visibility flags.
 */
export function visibleBoardColumns(options: BoardColumnOptions): StatusKey[] {
	if (options.status_filter.length > 0) {
		const wanted = new Set(options.status_filter);
		return STATUS_KEYS.filter((key) => wanted.has(key));
	}

	if (options.include_closed) {
		return [...STATUS_KEYS];
	}

	return STATUS_KEYS.filter((key) => key !== 'closed');
}

/**
 * Sort cards inside a column: priority ascending (P0 first), then recency
 * descending, then id so equal keys stay stable.
 *
 * @param issues - Cards in one status column.
 */
export function sortBoardCards(issues: readonly IssueSummary[]): IssueSummary[] {
	return issues.slice().sort((left, right) => {
		const left_priority = Number.isFinite(left.priority) ? left.priority : Number.MAX_SAFE_INTEGER;
		const right_priority = Number.isFinite(right.priority)
			? right.priority
			: Number.MAX_SAFE_INTEGER;
		if (left_priority !== right_priority) {
			return left_priority - right_priority;
		}

		const left_updated = Date.parse(left.updated_at) || 0;
		const right_updated = Date.parse(right.updated_at) || 0;
		if (left_updated !== right_updated) {
			return right_updated - left_updated;
		}

		return collator.compare(left.id, right.id);
	});
}

/**
 * Bucket already-filtered issues into visible status columns.
 *
 * Issues whose status is not a visible column are dropped (typically closed
 * when include_closed is off). Empty columns still appear so the board keeps
 * a stable skeleton while filters change.
 *
 * @param issues - The filtered issue set from the page.
 * @param options - Column visibility flags.
 */
export function groupBoardColumns(
	issues: readonly IssueSummary[],
	options: BoardColumnOptions
): BoardColumn[] {
	const keys = visibleBoardColumns(options);
	const buckets = new Map<StatusKey, IssueSummary[]>(keys.map((key) => [key, []]));

	for (const issue of issues) {
		const bucket = buckets.get(statusKey(issue.status));
		if (bucket) {
			bucket.push(issue);
		}
	}

	return keys.map((status) => ({
		status,
		label: statusLabel(status),
		issues: sortBoardCards(buckets.get(status) ?? [])
	}));
}

/**
 * Status to send on File after `bd create`. Open is the create default, so
 * the worker skips the follow-up update.
 *
 * @param status - Column the operator clicked, or undefined from the header File button.
 */
export function fileStatusAfterCreate(status: StatusKey | undefined): StatusKey | undefined {
	return status === undefined || status === 'open' ? undefined : status;
}

/**
 * Dialog heading when filing into a named column.
 *
 * @param status - Column the operator clicked.
 */
export function boardCreateHeading(status: StatusKey): string {
	return `New ${statusLabel(status)} issue`;
}

/**
 * Whether a board column should offer File-into-this-column.
 * Projects are always SQL-readonly; "writable" means File dispatch is allowed.
 *
 * @param file_enabled - Effective File allow (key + arm + per-project file).
 */
export function boardColumnCreateEnabled(file_enabled: boolean): boolean {
	return file_enabled;
}
