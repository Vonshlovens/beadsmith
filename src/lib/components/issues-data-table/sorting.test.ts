import { describe, expect, it } from 'vitest';
import { UNSORTED } from '$lib/client/sort.js';
import { fromSortingState, toSortingState } from './sorting.js';

describe('toSortingState', () => {
	it('encodes an unsorted table as an empty array', () => {
		expect(toSortingState(UNSORTED)).toEqual([]);
	});

	it('encodes a single column and its direction', () => {
		expect(toSortingState({ column: 'priority', direction: 'asc' })).toEqual([
			{ id: 'priority', desc: false }
		]);
		expect(toSortingState({ column: 'updated', direction: 'desc' })).toEqual([
			{ id: 'updated', desc: true }
		]);
	});
});

describe('fromSortingState', () => {
	it('treats an empty array as unsorted', () => {
		expect(fromSortingState([])).toEqual(UNSORTED);
	});

	it('reads the first sort entry', () => {
		expect(fromSortingState([{ id: 'title', desc: false }])).toEqual({
			column: 'title',
			direction: 'asc'
		});
		expect(fromSortingState([{ id: 'deps', desc: true }])).toEqual({
			column: 'deps',
			direction: 'desc'
		});
	});

	it('ignores unknown column ids', () => {
		expect(fromSortingState([{ id: 'not-a-column', desc: true }])).toEqual(UNSORTED);
	});
});
