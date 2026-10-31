import { describe, expect, it } from 'vitest';
import {
	boardCollapsedStorageKey,
	COLLAPSED_COLUMN_DROP,
	expandCollapsedColumn,
	parseCollapsed,
	serializeCollapsed,
	toggleCollapsed
} from './board-prefs.js';
import type { StatusKey } from './format.js';

describe('parseCollapsed', () => {
	it('round trips a serialized preference', () => {
		const collapsed = new Set<StatusKey>(['closed', 'deferred']);
		expect(parseCollapsed(serializeCollapsed(collapsed))).toEqual(collapsed);
	});

	it('drops tokens it does not recognise', () => {
		expect(parseCollapsed('closed,nope,deferred')).toEqual(new Set(['deferred', 'closed']));
	});

	it('falls back to nothing collapsed for empty, missing, or wholly unknown input', () => {
		expect(parseCollapsed('')).toEqual(new Set());
		expect(parseCollapsed(null)).toEqual(new Set());
		expect(parseCollapsed(undefined)).toEqual(new Set());
		expect(parseCollapsed('nope,also-nope')).toEqual(new Set());
	});

	it('tolerates whitespace and writes STATUS_KEYS order', () => {
		expect(parseCollapsed(' closed , open ')).toEqual(new Set(['open', 'closed']));
		expect(serializeCollapsed(new Set(['closed', 'open']))).toBe('open,closed');
		expect(boardCollapsedStorageKey('demo')).toBe('bdui:board-collapsed:demo');
	});
});

describe('toggleCollapsed', () => {
	it('collapses an expanded column and expands a collapsed one', () => {
		const none = new Set<StatusKey>();
		const closed = toggleCollapsed(none, 'closed');
		expect(closed).toEqual(new Set(['closed']));
		expect(toggleCollapsed(closed, 'closed')).toEqual(new Set());
	});

	it('does not mutate the input', () => {
		const collapsed = new Set<StatusKey>(['deferred']);
		toggleCollapsed(collapsed, 'closed');
		expect(collapsed).toEqual(new Set(['deferred']));
	});
});

describe('expandCollapsedColumn', () => {
	it('documents expand-on-dragover as the drop policy', () => {
		expect(COLLAPSED_COLUMN_DROP).toBe('expand-on-dragover');
	});

	it('expands a collapsed drop target and leaves others alone', () => {
		const collapsed = new Set<StatusKey>(['closed', 'deferred']);
		expect(expandCollapsedColumn(collapsed, 'closed')).toEqual(new Set(['deferred']));
		expect(expandCollapsedColumn(collapsed, 'open')).toEqual(collapsed);
		expect(collapsed).toEqual(new Set(['closed', 'deferred']));
	});
});
