import { describe, expect, it } from 'vitest';
import { compareByUrgency, dueBucket, MAX_URGENCY, urgency, urgencyRatio } from './urgency.js';

// Local noon: the buckets are local calendar days, so tests build local dates.
const NOW = new Date(2026, 9, 28, 12, 0, 0);
const local = (y: number, m: number, d: number, h = 0, min = 0) =>
	new Date(y, m - 1, d, h, min).toISOString();

describe('dueBucket', () => {
	it.each([
		[undefined, 'none'],
		[null, 'none'],
		['', 'none'],
		['garbage', 'none'],
		['2026-10-27', 'overdue'],
		['2026-10-28', 'today'],
		['2026-10-29', 'soon'],
		['2026-11-04', 'soon'],
		['2026-11-05', 'later'],
		[local(2026, 10, 28, 11, 59), 'overdue'],
		[local(2026, 10, 28, 18), 'today'],
		[local(2026, 11, 4, 23), 'soon']
	] as const)('%s → %s', (due, bucket) => {
		expect(dueBucket(due, NOW)).toBe(bucket);
	});
});

describe('urgency', () => {
	it('is 4 − priority with no due date', () => {
		expect([0, 1, 2, 3, 4].map((p) => urgency(p, null, NOW))).toEqual([4, 3, 2, 1, 0]);
	});

	it.each([
		['2026-10-20', 3],
		['2026-10-28', 2],
		['2026-11-02', 1],
		['2027-01-01', 0]
	])('adds the due bucket for %s', (due, points) => {
		expect(urgency(2, due, NOW)).toBe(2 + points);
	});

	it('peaks at 7 for an overdue P0 and floors at 0 for a far P4', () => {
		expect(urgency(0, '2026-01-01', NOW)).toBe(MAX_URGENCY);
		expect(urgency(4, '2030-01-01', NOW)).toBe(0);
	});

	it('clamps an out-of-range priority', () => {
		expect(urgency(-3, null, NOW)).toBe(4);
		expect(urgency(9, null, NOW)).toBe(0);
	});

	it('scales to a 0–1 ratio', () => {
		expect(urgencyRatio(0)).toBe(0);
		expect(urgencyRatio(MAX_URGENCY)).toBe(1);
		expect(urgencyRatio(99)).toBe(1);
	});
});

describe('compareByUrgency', () => {
	const sort = (items: { id: string; priority: number; due_at?: string; sort_key?: number }[]) =>
		[...items].sort(compareByUrgency(NOW)).map((i) => i.id);

	it('orders by urgency first', () => {
		expect(
			sort([
				{ id: 'p3', priority: 3 },
				{ id: 'overdue-p2', priority: 2, due_at: '2026-10-01' },
				{ id: 'p0', priority: 0 }
			])
		).toEqual(['overdue-p2', 'p0', 'p3']);
	});

	it('breaks ties by earlier due date, undated last', () => {
		// both P2 with due in later bucket (urgency 2) → by due; undated also urgency 2
		expect(
			sort([
				{ id: 'none', priority: 2 },
				{ id: 'far-b', priority: 2, due_at: '2027-03-01' },
				{ id: 'far-a', priority: 2, due_at: '2027-02-01' }
			])
		).toEqual(['far-a', 'far-b', 'none']);
	});

	it('breaks remaining ties by sort_key', () => {
		expect(
			sort([
				{ id: 'b', priority: 2, sort_key: 2 },
				{ id: 'a', priority: 2, sort_key: 1 }
			])
		).toEqual(['a', 'b']);
	});
});

describe('local calendar days', () => {
	it('keeps "today" for the whole local day, late evening included', () => {
		const late = new Date(2026, 9, 28, 23, 45);
		expect(dueBucket('2026-10-28', late)).toBe('today');
		expect(dueBucket('2026-10-29', late)).toBe('soon');
		expect(dueBucket(local(2026, 10, 28, 23, 50), late)).toBe('today');
		expect(dueBucket('2026-10-28', new Date(2026, 9, 28, 0, 5))).toBe('today');
	});

	it('orders a date-only due before a same-day evening datetime', () => {
		const sort = [
			{ priority: 2, due_at: local(2026, 10, 30, 18) },
			{ priority: 2, due_at: '2026-10-30' }
		].sort(compareByUrgency(NOW));
		expect(sort[0].due_at).toBe('2026-10-30');
	});
});
