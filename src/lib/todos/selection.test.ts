import { describe, expect, it } from 'vitest';
import { flipRow, moveCursor, rangeBetween, selectedIds, startVisual } from './selection.js';

const ids = ['a', 'b', 'c', 'd', 'e'];

describe('visual selection', () => {
	it('selects the anchor alone, then the range as the cursor moves', () => {
		const visual = startVisual('b');
		expect(selectedIds(visual, ids, 'b')).toEqual(['b']);
		expect(selectedIds(visual, ids, 'd')).toEqual(['b', 'c', 'd']);
		expect(selectedIds(visual, ids, 'a')).toEqual(['a', 'b']);
	});

	it('space drops a row inside the range and adds one outside', () => {
		let visual = startVisual('b');
		visual = flipRow(visual, 'c');
		expect(selectedIds(visual, ids, 'd')).toEqual(['b', 'd']);
		visual = flipRow(visual, 'e');
		expect(selectedIds(visual, ids, 'd')).toEqual(['b', 'd', 'e']);
		visual = flipRow(visual, 'c');
		expect(selectedIds(visual, ids, 'd')).toEqual(['b', 'c', 'd', 'e']);
	});

	it('survives rows leaving the list', () => {
		expect(rangeBetween(['a', 'c'], 'b', 'c')).toEqual(['c']);
		expect(rangeBetween(['a'], 'x', 'y')).toEqual([]);
		expect(selectedIds(startVisual('gone'), ['a', 'b'], 'b')).toEqual(['b']);
	});

	it('moves and clamps the cursor', () => {
		expect(moveCursor(ids, 'a', -1)).toBe('a');
		expect(moveCursor(ids, 'e', 1)).toBe('e');
		expect(moveCursor(ids, 'b', 2)).toBe('d');
		expect(moveCursor(ids, null, 1)).toBe('a');
		expect(moveCursor(ids, 'zz', -1)).toBe('e');
		expect(moveCursor([], 'a', 1)).toBeNull();
	});
});
