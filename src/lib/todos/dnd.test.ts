import { describe, expect, it } from 'vitest';
import { dueForColumn, placeAt } from './dnd.js';

const NOW = new Date(2026, 9, 28, 10, 0, 0);

describe('dueForColumn', () => {
	it('today & overdue keeps past and today dates, pulls later ones to today', () => {
		expect(dueForColumn('now', '2026-10-20', NOW)).toBeUndefined();
		expect(dueForColumn('now', '2026-10-28', NOW)).toBeUndefined();
		expect(dueForColumn('now', '2026-11-02', NOW)).toBe('2026-10-28');
		expect(dueForColumn('now', null, NOW)).toBe('2026-10-28');
	});

	it('next 7 days keeps in-range dates, else tomorrow', () => {
		expect(dueForColumn('week', '2026-10-31', NOW)).toBeUndefined();
		expect(dueForColumn('week', '2026-11-04', NOW)).toBeUndefined();
		expect(dueForColumn('week', '2026-10-28', NOW)).toBe('2026-10-29');
		expect(dueForColumn('week', '2026-10-01', NOW)).toBe('2026-10-29');
		expect(dueForColumn('week', '2026-12-01', NOW)).toBe('2026-10-29');
		expect(dueForColumn('week', null, NOW)).toBe('2026-10-29');
	});

	it('upcoming keeps later dates, else clears', () => {
		expect(dueForColumn('later', '2026-11-20', NOW)).toBeUndefined();
		expect(dueForColumn('later', '2026-11-04', NOW)).toBeNull();
		expect(dueForColumn('later', '2026-10-20', NOW)).toBeNull();
		expect(dueForColumn('later', null, NOW)).toBeNull();
	});

	it('the two-column rest keeps any future date; one column changes nothing', () => {
		expect(dueForColumn('rest', '2026-10-30', NOW)).toBeUndefined();
		expect(dueForColumn('rest', '2026-10-28', NOW)).toBeNull();
		expect(dueForColumn('all', '2026-10-20', NOW)).toBeUndefined();
	});
});

describe('placeAt', () => {
	const rows = [
		{ id: 'a', sort_key: 1 },
		{ id: 'b', sort_key: 2 },
		{ id: 'c', sort_key: 4 }
	];
	const moved = { id: 'm', sort_key: 99 };

	it('takes the midpoint between neighbours', () => {
		expect(placeAt(moved, rows, 1)).toEqual([{ id: 'm', sort_key: 1.5 }]);
		expect(placeAt(moved, rows, 2)).toEqual([{ id: 'm', sort_key: 3 }]);
	});

	it('steps past the ends', () => {
		expect(placeAt(moved, rows, 0)).toEqual([{ id: 'm', sort_key: 0 }]);
		expect(placeAt(moved, rows, 3)).toEqual([{ id: 'm', sort_key: 5 }]);
		expect(placeAt(moved, rows, 99)).toEqual([{ id: 'm', sort_key: 5 }]);
	});

	it('renumbers when neighbours tie', () => {
		const tied = [
			{ id: 'a', sort_key: 3 },
			{ id: 'b', sort_key: 3 }
		];
		const patches = placeAt(moved, tied, 1);
		expect(patches).toContainEqual({ id: 'm', sort_key: 4 });
		expect(patches).toContainEqual({ id: 'b', sort_key: 5 });
	});

	it('does nothing for an empty column or an unchanged key', () => {
		expect(placeAt(moved, [], 0)).toEqual([]);
		expect(placeAt({ id: 'm', sort_key: 1.5 }, rows, 1)).toEqual([]);
	});
});
