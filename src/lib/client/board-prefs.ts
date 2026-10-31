/**
 * Board presentation preferences: which status columns are collapsed.
 *
 * Collapse is local-only (not a URL param). View mode lives in issue-view.ts.
 * Deliberately free of `$app` imports and storage access — the board owns I/O,
 * this module owns the rules.
 *
 * Drag onto a collapsed column expands it on dragover so
 * the drop target is a real column, not a strip a card cannot land on. Keyboard
 * moves into a collapsed column use the same helper. The
 * card still stays in its source column until an agent changes Beads; expand
 * is only presentation. Call `expandCollapsedColumn` from those paths.
 */
import { STATUS_KEYS } from './format.js';
import type { StatusKey } from './format.js';

/**
 * Dropping onto a collapsed column expands it rather than rejecting the drop.
 * Documented here so mi9.3 does not have to invent a second policy.
 */
export const COLLAPSED_COLUMN_DROP = 'expand-on-dragover' as const;

/**
 * localStorage key for the collapsed status set of one project's board.
 *
 * @param project_id - Project id in the `/p/:id` path.
 */
export function boardCollapsedStorageKey(project_id: string): string {
	return `bdui:board-collapsed:${project_id}`;
}

/**
 * Whether an untrusted string names a status column. Stored preferences
 * outlive the code that wrote them, so anything read back has to be re-checked.
 *
 * @param value - Candidate status key.
 */
function isStatusKey(value: string): value is StatusKey {
	return (STATUS_KEYS as readonly string[]).includes(value);
}

/**
 * Build a set in `STATUS_KEYS` order so iteration never depends on toggle order.
 *
 * @param statuses - Keys to include; order and duplicates are ignored.
 */
function orderedSet(statuses: Iterable<StatusKey>): Set<StatusKey> {
	const wanted = new Set(statuses);
	return new Set(STATUS_KEYS.filter((status) => wanted.has(status)));
}

/**
 * Parse a stored comma-separated collapsed set. Unknown tokens are dropped.
 * Missing, empty, or wholly unrecognised input means nothing is collapsed.
 *
 * @param raw - Stored value, or null/undefined when nothing was stored.
 */
export function parseCollapsed(raw: string | null | undefined): Set<StatusKey> {
	const parsed = (raw ?? '')
		.split(',')
		.map((field) => field.trim())
		.filter(isStatusKey);

	return orderedSet(parsed);
}

/**
 * Serialize in `STATUS_KEYS` order so an unchanged set always writes the
 * same string.
 *
 * @param collapsed - Statuses currently collapsed.
 */
export function serializeCollapsed(collapsed: ReadonlySet<StatusKey>): string {
	return STATUS_KEYS.filter((status) => collapsed.has(status)).join(',');
}

/**
 * Collapse or expand one column, returning a new set so reactivity sees a
 * fresh value.
 *
 * @param collapsed - Statuses currently collapsed.
 * @param status - Column the user toggled.
 */
export function toggleCollapsed(
	collapsed: ReadonlySet<StatusKey>,
	status: StatusKey
): Set<StatusKey> {
	const next = orderedSet(collapsed);
	if (next.has(status)) {
		next.delete(status);
	} else {
		next.add(status);
	}
	return orderedSet(next);
}

/**
 * Expand one column for a dragover drop target. No-op when it was already
 * expanded. Does not move cards.
 *
 * @param collapsed - Statuses currently collapsed.
 * @param status - Column being dragged over.
 */
export function expandCollapsedColumn(
	collapsed: ReadonlySet<StatusKey>,
	status: StatusKey
): Set<StatusKey> {
	if (!collapsed.has(status)) {
		return orderedSet(collapsed);
	}
	const next = orderedSet(collapsed);
	next.delete(status);
	return orderedSet(next);
}
