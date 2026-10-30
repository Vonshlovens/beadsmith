/**
 * Column visibility and sizing for the issues table.
 *
 * The reader chooses which columns to show. A phone-width window still hides
 * the ones that cannot fit; anything wider keeps that choice and scrolls
 * sideways. Fixed columns paint at their resolved width (the default, or a
 * drag the reader has stored). The title takes whatever slack remains and
 * never drops below its minimum, so a narrow frame scrolls instead of
 * squeezing every column.
 *
 * Deliberately free of runes, `$app` imports, and storage access — the page
 * owns the I/O and the reactive state, this module owns the rules, so all of
 * it stays plain, testable TypeScript.
 */
import { SORT_COLUMNS } from './sort.js';
import type { SortColumn } from './sort.js';

/** Columns are addressed by the same ids the sort uses; one table, one vocabulary. */
export type ColumnId = SortColumn;

/**
 * Every fixed-width column, i.e. everything but the one that absorbs the slack.
 * Private: callers say `Exclude<ColumnId, 'title'>` or ask `isResizable`.
 */
type FixedColumn = Exclude<ColumnId, 'title'>;

/** Every column the issues table can paint, in paint order. */
export const COLUMN_IDS: readonly ColumnId[] = SORT_COLUMNS;

/**
 * The column that carries the row's meaning. Hiding it would leave a table of
 * identifiers, so it is not on offer.
 */
const SLACK_COLUMN = 'title' satisfies ColumnId;

/** Columns the user may never hide. */
export const REQUIRED_COLUMNS: ReadonlySet<ColumnId> = new Set<ColumnId>([SLACK_COLUMN]);

/**
 * Status and Id stay pinned while the table scrolls sideways. Phones skip
 * pinning; there is not enough width for a frozen pair.
 */
export const STICKY_COLUMNS = ['status', 'id'] as const;

/** A column that can pin to the left edge of the scrollport. */
export type StickyColumn = (typeof STICKY_COLUMNS)[number];

/**
 * Full-word label per column, for the picker menu. The headers themselves are
 * abbreviated to save pixels; a menu has room to be plain.
 */
export const COLUMN_LABELS: Record<ColumnId, string> = {
	status: 'Status',
	id: 'Id',
	title: 'Title',
	type: 'Type',
	priority: 'Priority',
	assignee: 'Assignee',
	labels: 'Labels',
	deps: 'Dependencies',
	updated: 'Updated'
};

/** Every column is shown until the user says otherwise. */
export const DEFAULT_VISIBLE: readonly ColumnId[] = COLUMN_IDS;

/**
 * Starting pixel width for each fixed-width column. `title` takes the slack, so
 * it has no entry: whatever these leave over is what the title gets.
 */
export const DEFAULT_WIDTHS: Record<FixedColumn, number> = {
	status: 64,
	id: 120,
	type: 92,
	priority: 64,
	assignee: 132,
	labels: 150,
	deps: 80,
	updated: 88
};

/** Below this a column is narrower than its own header, and stops being a column. */
export const MIN_COLUMN_WIDTH = 48;

/** Past this a column is hoarding space it cannot use; the ceiling keeps drags sane. */
export const MAX_COLUMN_WIDTH = 420;

/**
 * The title stops being readable below this, so the table grows instead of
 * letting the title shrink further. About fifty characters at the row's font.
 */
export const MIN_TITLE_WIDTH = 360;

/** Viewports at or under this are phones: fewer columns, no pinned identity, a shorter title floor. */
export const PHONE_MAX_WIDTH = 640;

/** Title floor once the phone column set is in use. */
export const PHONE_MIN_TITLE_WIDTH = 240;

/**
 * Columns dropped automatically on a phone. Tablets and laptops keep every
 * column the reader chose and scroll sideways. Updated stays visible.
 */
export const NARROW_BREAKPOINTS: readonly { max_width: number; hides: readonly ColumnId[] }[] = [
	{ max_width: PHONE_MAX_WIDTH, hides: ['type', 'labels', 'deps', 'assignee'] }
];

/**
 * True when the column carries a drag handle. Only the slack column is
 * unresizable — its width is a consequence of the others, not a setting.
 *
 * @param column - Column being rendered.
 */
export function isResizable(column: ColumnId): boolean {
	return column !== SLACK_COLUMN;
}

/**
 * Whether an untrusted string names a column. Stored preferences outlive the
 * code that wrote them, so anything read back has to be re-checked.
 *
 * @param value - Candidate id, typically one field of a stored string.
 */
function isColumnId(value: string): value is ColumnId {
	return (COLUMN_IDS as readonly string[]).includes(value);
}

/**
 * Build a set in `COLUMN_IDS` order, so iteration order never depends on how
 * the preference happened to be written.
 *
 * @param columns - Ids to include; order and duplicates are ignored.
 */
function orderedSet(columns: Iterable<ColumnId>): Set<ColumnId> {
	const wanted = new Set(columns);
	return new Set(COLUMN_IDS.filter((column) => wanted.has(column)));
}

/**
 * Parse a stored comma-separated preference. Unknown ids are dropped and
 * required ids forced back in; a missing, empty, or wholly unrecognised value
 * means "no preference yet" and falls back to `DEFAULT_VISIBLE` rather than to
 * an empty table.
 *
 * @param raw - Stored value, or `null`/`undefined` when nothing was stored.
 * @returns The columns to show, in `COLUMN_IDS` order.
 */
export function parseVisible(raw: string | null | undefined): Set<ColumnId> {
	const parsed = (raw ?? '')
		.split(',')
		.map((field) => field.trim())
		.filter(isColumnId);

	if (parsed.length === 0) {
		return orderedSet(DEFAULT_VISIBLE);
	}

	return orderedSet([...parsed, ...REQUIRED_COLUMNS]);
}

/**
 * Serialize in `COLUMN_IDS` order so the stored value is stable no matter which
 * order the user toggled things in.
 *
 * @param visible - Columns currently shown.
 */
export function serializeVisible(visible: ReadonlySet<ColumnId>): string {
	return COLUMN_IDS.filter((column) => visible.has(column)).join(',');
}

/**
 * Show or hide one column, returning a new set — the caller's state is left
 * alone so reactivity sees a fresh value. Required columns ignore the request.
 *
 * @param visible - Columns currently shown.
 * @param column - Column the user clicked in the picker.
 */
export function toggleVisible(visible: ReadonlySet<ColumnId>, column: ColumnId): Set<ColumnId> {
	const next = orderedSet(visible);

	if (REQUIRED_COLUMNS.has(column)) {
		return next;
	}

	if (next.has(column)) {
		next.delete(column);
	} else {
		next.add(column);
	}

	return orderedSet(next);
}

/**
 * Parse stored JSON widths. Unknown ids, non-finite values, and `title` are
 * dropped, and every survivor is clamped to the range a drag could have
 * produced; junk JSON yields no overrides at all rather than throwing at the
 * reader.
 *
 * @param raw - Stored JSON object, or `null`/`undefined` when nothing was stored.
 * @returns Overrides to layer over `DEFAULT_WIDTHS`.
 */
export function parseWidths(raw: string | null | undefined): Partial<Record<ColumnId, number>> {
	if (!raw) {
		return {};
	}

	let decoded: unknown;
	try {
		decoded = JSON.parse(raw);
	} catch {
		return {};
	}

	if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
		return {};
	}

	const widths: Partial<Record<ColumnId, number>> = {};
	for (const [key, value] of Object.entries(decoded as Record<string, unknown>)) {
		if (!isColumnId(key) || key === SLACK_COLUMN) {
			continue;
		}
		if (typeof value !== 'number' || !Number.isFinite(value)) {
			continue;
		}
		widths[key] = clamp(Math.round(value), MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH);
	}

	return widths;
}

/**
 * Serialize width overrides for storage, in `COLUMN_IDS` order so an unchanged
 * layout always produces an unchanged string.
 *
 * @param widths - Overrides to persist.
 */
export function serializeWidths(widths: Partial<Record<ColumnId, number>>): string {
	const ordered: Partial<Record<ColumnId, number>> = {};
	for (const column of COLUMN_IDS) {
		const width = widths[column];
		if (typeof width === 'number' && Number.isFinite(width)) {
			ordered[column] = width;
		}
	}
	return JSON.stringify(ordered);
}

/**
 * Merge stored overrides over `DEFAULT_WIDTHS`, so a preference for one column
 * never costs the defaults of the rest.
 *
 * @param overrides - Widths the user has dragged, typically from `parseWidths`.
 */
export function resolveWidths(
	overrides: Partial<Record<ColumnId, number>>
): Record<FixedColumn, number> {
	const widths = { ...DEFAULT_WIDTHS };

	for (const column of Object.keys(widths) as FixedColumn[]) {
		const override = overrides[column];
		if (typeof override === 'number' && Number.isFinite(override)) {
			widths[column] = override;
		}
	}

	return widths;
}

/**
 * TanStack column-visibility map for the columns currently painted. Hidden
 * columns are `false` rather than omitted, so a stale visible leftover cannot
 * linger after the viewport drops one.
 *
 * @param painted - Columns actually being drawn, from `columnsForWidth`.
 */
export function visibilityState(painted: ReadonlySet<ColumnId>): Record<ColumnId, boolean> {
	const visibility = {} as Record<ColumnId, boolean>;
	for (const column of COLUMN_IDS) {
		visibility[column] = painted.has(column);
	}
	return visibility;
}

/**
 * Whether a viewport measurement is usable. Server render and the first frame
 * report nothing, and guessing there would flash columns away and back.
 *
 * @param viewport - Measured viewport width in pixels.
 */
function knownViewport(viewport: number): boolean {
	return Number.isFinite(viewport) && viewport > 0;
}

/**
 * Which columns actually paint: the user's choice minus anything a phone
 * viewport is too narrow for. A `viewport` of 0 or a non-finite number means
 * "unknown", and nothing is dropped.
 *
 * @param visible - Columns the user has chosen to show.
 * @param viewport - Measured viewport width in pixels.
 */
export function columnsForWidth(visible: ReadonlySet<ColumnId>, viewport: number): Set<ColumnId> {
	const painted = orderedSet(visible);

	if (!knownViewport(viewport)) {
		return painted;
	}

	for (const breakpoint of NARROW_BREAKPOINTS) {
		if (viewport <= breakpoint.max_width) {
			for (const column of breakpoint.hides) {
				painted.delete(column);
			}
		}
	}

	return painted;
}

/**
 * True when the viewport, not the user, is hiding this column — the picker uses
 * it to explain why a checked box is not painting anything.
 *
 * @param column - Column being described.
 * @param viewport - Measured viewport width in pixels.
 */
export function hiddenByWidth(column: ColumnId, viewport: number): boolean {
	if (!knownViewport(viewport)) {
		return false;
	}

	return NARROW_BREAKPOINTS.some(
		(breakpoint) => viewport <= breakpoint.max_width && breakpoint.hides.includes(column)
	);
}

/**
 * Constrain a number to a range.
 *
 * @param value - Number to constrain.
 * @param low - Inclusive lower bound.
 * @param high - Inclusive upper bound.
 */
function clamp(value: number, low: number, high: number): number {
	return Math.min(high, Math.max(low, value));
}

/**
 * Title floor for a viewport. Phones use the shorter floor; an unknown
 * viewport uses the desktop floor so the first paint does not jump.
 *
 * @param viewport - Measured viewport width in pixels.
 */
export function titleMinWidth(viewport: number): number {
	if (knownViewport(viewport) && viewport <= PHONE_MAX_WIDTH) {
		return PHONE_MIN_TITLE_WIDTH;
	}
	return MIN_TITLE_WIDTH;
}

/**
 * Minimum table width: every painted fixed column at its resolved width, plus
 * the title floor. The table is `max(100%, this)` so the title absorbs slack
 * on a wide screen and the frame scrolls once the floor no longer fits.
 *
 * @param widths - Resolved width per fixed column, from `resolveWidths`.
 * @param painted - Columns actually being drawn, from `columnsForWidth`.
 * @param viewport - Measured viewport width in pixels.
 */
export function tableMinWidth(
	widths: Record<FixedColumn, number>,
	painted: ReadonlySet<ColumnId>,
	viewport: number
): number {
	let fixed = 0;
	for (const column of COLUMN_IDS) {
		if (column === SLACK_COLUMN || !painted.has(column)) {
			continue;
		}
		fixed += widths[column];
	}
	return fixed + titleMinWidth(viewport);
}

/**
 * Left offsets for the pinned identity columns, in paint order. A hidden
 * column is omitted and the next pin starts where it would have. Returns
 * `null` on a phone, where pinning is off. An unknown viewport pins, matching
 * `columnsForWidth` (unknown means "do not assume a phone").
 *
 * @param painted - Columns actually being drawn.
 * @param widths - Resolved width per fixed column.
 * @param viewport - Measured viewport width in pixels.
 */
export function stickyLeft(
	painted: ReadonlySet<ColumnId>,
	widths: Record<FixedColumn, number>,
	viewport: number
): Partial<Record<StickyColumn, number>> | null {
	if (knownViewport(viewport) && viewport <= PHONE_MAX_WIDTH) {
		return null;
	}

	const left: Partial<Record<StickyColumn, number>> = {};
	let offset = 0;
	for (const column of STICKY_COLUMNS) {
		if (!painted.has(column)) {
			continue;
		}
		left[column] = offset;
		offset += widths[column];
	}
	return left;
}

/**
 * Clamp a drag to the column's own limits. Widening a column widens the table,
 * so nothing here protects the title or consults the other columns.
 *
 * @param desired - Width the pointer is asking for.
 */
export function clampWidth(desired: number): number {
	const width = Math.max(MIN_COLUMN_WIDTH, Math.round(desired));
	return Math.min(MAX_COLUMN_WIDTH, width);
}
