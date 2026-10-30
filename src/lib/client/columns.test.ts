import { describe, expect, it } from 'vitest';
import {
	clampWidth,
	columnsForWidth,
	COLUMN_IDS,
	DEFAULT_WIDTHS,
	hiddenByWidth,
	isResizable,
	MAX_COLUMN_WIDTH,
	MIN_COLUMN_WIDTH,
	MIN_TITLE_WIDTH,
	PHONE_MAX_WIDTH,
	PHONE_MIN_TITLE_WIDTH,
	parseVisible,
	parseWidths,
	resolveWidths,
	serializeVisible,
	serializeWidths,
	stickyLeft,
	tableMinWidth,
	toggleVisible,
	visibilityState
} from './columns.js';
import type { ColumnId } from './columns.js';

/** Every fixed column, which is the usual `painted` argument. */
const ALL_FIXED = COLUMN_IDS.filter((column) => column !== 'title');

describe('parseVisible', () => {
	it('round trips a serialized preference', () => {
		const visible = new Set<ColumnId>(['status', 'title', 'updated']);
		expect(parseVisible(serializeVisible(visible))).toEqual(visible);
	});

	it('drops ids it does not recognise', () => {
		expect(parseVisible('status,gibberish,title')).toEqual(new Set(['status', 'title']));
	});

	it('falls back to every column for empty, missing, or wholly unknown input', () => {
		const all = new Set(COLUMN_IDS);
		expect(parseVisible('')).toEqual(all);
		expect(parseVisible(null)).toEqual(all);
		expect(parseVisible(undefined)).toEqual(all);
		expect(parseVisible('nope,also-nope')).toEqual(all);
	});

	it('forces title back in when the stored value omits it', () => {
		expect(parseVisible('status,id')).toEqual(new Set(['status', 'id', 'title']));
	});

	it('tolerates whitespace around the ids', () => {
		expect(parseVisible(' status , title ')).toEqual(new Set(['status', 'title']));
	});
});

describe('serializeVisible', () => {
	it('writes column order, not toggle order', () => {
		const visible = new Set<ColumnId>(['updated', 'status', 'title']);
		expect(serializeVisible(visible)).toBe('status,title,updated');
	});

	it('writes every column when nothing is hidden', () => {
		expect(serializeVisible(new Set(COLUMN_IDS))).toBe(COLUMN_IDS.join(','));
	});
});

describe('toggleVisible', () => {
	it('removes a shown column and adds a hidden one', () => {
		const shown = new Set<ColumnId>(['status', 'title']);
		expect(toggleVisible(shown, 'status')).toEqual(new Set(['title']));
		expect(toggleVisible(shown, 'updated')).toEqual(new Set(['status', 'title', 'updated']));
	});

	it('refuses to hide title', () => {
		const shown = new Set<ColumnId>(['status', 'title']);
		expect(toggleVisible(shown, 'title')).toEqual(shown);
	});

	it('returns a new set and leaves the input alone', () => {
		const shown = new Set<ColumnId>(['status', 'title']);

		const next = toggleVisible(shown, 'status');

		expect(next).not.toBe(shown);
		expect([...shown]).toEqual(['status', 'title']);
		expect(toggleVisible(shown, 'title')).not.toBe(shown);
	});
});

describe('parseWidths', () => {
	it('reads back what it wrote', () => {
		expect(parseWidths(serializeWidths({ id: 200, updated: 90 }))).toEqual({
			id: 200,
			updated: 90
		});
	});

	it('clamps to the drag range', () => {
		expect(parseWidths('{"id":9999,"status":1}')).toEqual({
			id: MAX_COLUMN_WIDTH,
			status: MIN_COLUMN_WIDTH
		});
	});

	it('yields no overrides for junk', () => {
		expect(parseWidths('not json')).toEqual({});
		expect(parseWidths('[120,64]')).toEqual({});
		expect(parseWidths('null')).toEqual({});
		expect(parseWidths('')).toEqual({});
		expect(parseWidths(null)).toEqual({});
		expect(parseWidths(undefined)).toEqual({});
	});

	it('strips title, which has no width of its own', () => {
		expect(parseWidths('{"title":300,"id":200}')).toEqual({ id: 200 });
	});

	it('drops unknown ids and values that are not finite numbers', () => {
		expect(parseWidths('{"bogus":100,"id":null,"status":"64","deps":1e999}')).toEqual({});
	});
});

describe('resolveWidths', () => {
	it('returns the defaults when nothing was stored', () => {
		expect(resolveWidths({})).toEqual(DEFAULT_WIDTHS);
	});

	it('layers one override without disturbing the rest', () => {
		expect(resolveWidths({ id: 200 })).toEqual({ ...DEFAULT_WIDTHS, id: 200 });
	});

	it('ignores overrides for title and for non-finite values', () => {
		expect(resolveWidths({ title: 300, id: Number.NaN })).toEqual(DEFAULT_WIDTHS);
	});
});

describe('columnsForWidth', () => {
	const visible = new Set(COLUMN_IDS);

	it('drops nothing on a wide or tablet viewport', () => {
		expect(columnsForWidth(visible, 1400)).toEqual(visible);
		expect(columnsForWidth(visible, 900)).toEqual(visible);
		expect(columnsForWidth(visible, 768)).toEqual(visible);
		expect(columnsForWidth(visible, PHONE_MAX_WIDTH + 1)).toEqual(visible);
	});

	it('drops type, labels, deps and assignee on a phone, and keeps updated', () => {
		expect([...columnsForWidth(visible, PHONE_MAX_WIDTH)]).toEqual([
			'status',
			'id',
			'title',
			'priority',
			'updated'
		]);
		expect([...columnsForWidth(visible, 390)]).toEqual([
			'status',
			'id',
			'title',
			'priority',
			'updated'
		]);
	});

	it('drops nothing when the viewport is unknown', () => {
		expect(columnsForWidth(visible, 0)).toEqual(visible);
		expect(columnsForWidth(visible, Number.NaN)).toEqual(visible);
	});

	it('never re-adds a column the user hid', () => {
		expect(columnsForWidth(new Set<ColumnId>(['title', 'id']), 1400)).toEqual(
			new Set(['id', 'title'])
		);
	});
});

describe('hiddenByWidth', () => {
	it('reports the phone breakpoint that is doing the hiding', () => {
		expect(hiddenByWidth('type', 800)).toBe(false);
		expect(hiddenByWidth('updated', 800)).toBe(false);
		expect(hiddenByWidth('updated', 600)).toBe(false);
		expect(hiddenByWidth('type', 600)).toBe(true);
		expect(hiddenByWidth('labels', PHONE_MAX_WIDTH)).toBe(true);
		expect(hiddenByWidth('assignee', 390)).toBe(true);
		expect(hiddenByWidth('deps', 390)).toBe(true);
	});

	it('hides nothing on a wide or unknown viewport', () => {
		expect(hiddenByWidth('type', 1400)).toBe(false);
		expect(hiddenByWidth('type', 0)).toBe(false);
		expect(hiddenByWidth('type', Number.NaN)).toBe(false);
	});

	it('never claims the always-painted columns are hidden', () => {
		expect(hiddenByWidth('title', 400)).toBe(false);
		expect(hiddenByWidth('status', 400)).toBe(false);
		expect(hiddenByWidth('updated', 400)).toBe(false);
	});
});

describe('clampWidth', () => {
	it('floors a drag that would erase the column', () => {
		expect(clampWidth(10)).toBe(MIN_COLUMN_WIDTH);
		expect(clampWidth(-200)).toBe(MIN_COLUMN_WIDTH);
	});

	it('caps a drag that has run away', () => {
		expect(clampWidth(9999)).toBe(MAX_COLUMN_WIDTH);
	});

	it('leaves a drag that fits, rounded to whole pixels', () => {
		expect(clampWidth(160.4)).toBe(160);
		expect(clampWidth(300)).toBe(300);
	});

	it('does not consult the title or the other columns', () => {
		expect(clampWidth(300)).toBe(300);
		expect(clampWidth(MAX_COLUMN_WIDTH)).toBe(MAX_COLUMN_WIDTH);
	});
});

describe('tableMinWidth', () => {
	const widths = resolveWidths({});
	const painted = new Set(COLUMN_IDS);

	it('is the fixed columns plus the title floor at the defaults', () => {
		const fixed = ALL_FIXED.reduce(
			(sum, column) => sum + DEFAULT_WIDTHS[column as Exclude<ColumnId, 'title'>],
			0
		);
		expect(tableMinWidth(widths, painted, 1440)).toBe(fixed + MIN_TITLE_WIDTH);
		expect(tableMinWidth(widths, painted, 1440)).toBe(1150);
	});

	it('uses the phone title floor and only the columns still painted', () => {
		const phone = columnsForWidth(painted, 390);
		expect(tableMinWidth(widths, phone, 390)).toBe(
			DEFAULT_WIDTHS.status +
				DEFAULT_WIDTHS.id +
				DEFAULT_WIDTHS.priority +
				DEFAULT_WIDTHS.updated +
				PHONE_MIN_TITLE_WIDTH
		);
	});

	it('uses the desktop title floor when the viewport is unknown', () => {
		expect(tableMinWidth(widths, painted, 0)).toBe(
			ALL_FIXED.reduce(
				(sum, column) => sum + DEFAULT_WIDTHS[column as Exclude<ColumnId, 'title'>],
				0
			) + MIN_TITLE_WIDTH
		);
	});

	it('honours a dragged width', () => {
		const dragged = resolveWidths({ id: 200 });
		expect(tableMinWidth(dragged, painted, 1440)).toBe(1150 - DEFAULT_WIDTHS.id + 200);
	});
});

describe('stickyLeft', () => {
	const widths = resolveWidths({});

	it('pins status at 0 and id just after it', () => {
		expect(stickyLeft(new Set(COLUMN_IDS), widths, 1440)).toEqual({
			status: 0,
			id: DEFAULT_WIDTHS.status
		});
	});

	it('puts id at 0 when status is hidden', () => {
		expect(stickyLeft(new Set<ColumnId>(['id', 'title', 'updated']), widths, 1280)).toEqual({
			id: 0
		});
	});

	it('pins only status when id is hidden', () => {
		expect(stickyLeft(new Set<ColumnId>(['status', 'title']), widths, 1024)).toEqual({
			status: 0
		});
	});

	it('follows a dragged status width', () => {
		expect(stickyLeft(new Set(COLUMN_IDS), resolveWidths({ status: 80 }), 1440)).toEqual({
			status: 0,
			id: 80
		});
	});

	it('turns pinning off on a phone', () => {
		expect(stickyLeft(new Set(COLUMN_IDS), widths, PHONE_MAX_WIDTH)).toBeNull();
		expect(stickyLeft(new Set(COLUMN_IDS), widths, 390)).toBeNull();
	});

	it('pins when the viewport is unknown', () => {
		expect(stickyLeft(new Set(COLUMN_IDS), widths, 0)).toEqual({
			status: 0,
			id: DEFAULT_WIDTHS.status
		});
	});
});

describe('visibilityState', () => {
	it('marks every column, hidden ones false rather than omitted', () => {
		const painted = new Set<ColumnId>(['status', 'title', 'updated']);
		const visibility = visibilityState(painted);

		expect(visibility.status).toBe(true);
		expect(visibility.title).toBe(true);
		expect(visibility.updated).toBe(true);
		expect(visibility.id).toBe(false);
		expect(Object.keys(visibility)).toEqual([...COLUMN_IDS]);
	});
});

describe('isResizable', () => {
	it('gives every column but the slack column a handle', () => {
		expect(isResizable('title')).toBe(false);
		for (const column of ALL_FIXED) {
			expect(isResizable(column)).toBe(true);
		}
	});
});
