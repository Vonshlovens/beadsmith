import { describe, expect, it } from 'vitest';
import { ariaSort, nextSort, sortIssues, UNSORTED } from './sort.js';
import type { SortState } from './sort.js';
import type { IssueSummary } from '$lib/types.js';

/**
 * Build a row with only the fields a test cares about.
 *
 * @param overrides - Fields under test.
 */
function issue(overrides: Partial<IssueSummary> & { id: string }): IssueSummary {
	return {
		title: 'untitled',
		status: 'open',
		priority: 2,
		issue_type: 'task',
		labels: [],
		created_at: '2026-07-01T00:00:00Z',
		updated_at: '2026-07-01T00:00:00Z',
		dependency_count: 0,
		dependent_count: 0,
		comment_count: 0,
		...overrides
	};
}

/** Sort and return just the ids, which is all any assertion here needs. */
function ids(issues: IssueSummary[], state: SortState): string[] {
	return sortIssues(issues, state).map((row) => row.id);
}

describe('nextSort', () => {
	it('cycles ascending → descending → unsorted for a text column', () => {
		let state = nextSort(UNSORTED, 'title');
		expect(state).toEqual({ column: 'title', direction: 'asc' });

		state = nextSort(state, 'title');
		expect(state).toEqual({ column: 'title', direction: 'desc' });

		expect(nextSort(state, 'title')).toEqual(UNSORTED);
	});

	it('opens recency and dependency columns descending', () => {
		expect(nextSort(UNSORTED, 'updated').direction).toBe('desc');
		expect(nextSort(UNSORTED, 'deps').direction).toBe('desc');
		expect(nextSort({ column: 'updated', direction: 'desc' }, 'updated').direction).toBe('asc');
		expect(nextSort({ column: 'updated', direction: 'asc' }, 'updated')).toEqual(UNSORTED);
	});

	it('switching columns starts a fresh cycle', () => {
		const state = nextSort({ column: 'title', direction: 'desc' }, 'priority');
		expect(state).toEqual({ column: 'priority', direction: 'asc' });
	});
});

describe('ariaSort', () => {
	it('describes only the active column', () => {
		const state: SortState = { column: 'priority', direction: 'desc' };
		expect(ariaSort(state, 'priority')).toBe('descending');
		expect(ariaSort(state, 'title')).toBe('none');
		expect(ariaSort(UNSORTED, 'title')).toBe('none');
	});
});

describe('sortIssues', () => {
	const rows = [
		issue({ id: 'p-c', priority: 0, status: 'closed', updated_at: '2026-07-03T00:00:00Z' }),
		issue({ id: 'p-a', priority: 3, status: 'open', updated_at: '2026-07-01T00:00:00Z' }),
		issue({ id: 'p-b', priority: 1, status: 'blocked', updated_at: '2026-07-02T00:00:00Z' })
	];

	it('returns the input order when unsorted', () => {
		expect(ids(rows, UNSORTED)).toEqual(['p-c', 'p-a', 'p-b']);
	});

	it('does not mutate the input', () => {
		const input = rows.slice();
		sortIssues(input, { column: 'priority', direction: 'asc' });
		expect(input.map((row) => row.id)).toEqual(['p-c', 'p-a', 'p-b']);
	});

	it('sorts priority numerically, most urgent first when ascending', () => {
		expect(ids(rows, { column: 'priority', direction: 'asc' })).toEqual(['p-c', 'p-b', 'p-a']);
		expect(ids(rows, { column: 'priority', direction: 'desc' })).toEqual(['p-a', 'p-b', 'p-c']);
	});

	it('sorts status by the workflow order, not the alphabet', () => {
		expect(ids(rows, { column: 'status', direction: 'asc' })).toEqual(['p-a', 'p-b', 'p-c']);
	});

	it('sorts updated by instant, newest first when descending', () => {
		expect(ids(rows, { column: 'updated', direction: 'desc' })).toEqual(['p-c', 'p-b', 'p-a']);
	});

	it('orders ids numerically inside a shared prefix', () => {
		const numeric = [issue({ id: 'p-10' }), issue({ id: 'p-9' }), issue({ id: 'p-2' })];
		expect(ids(numeric, { column: 'id', direction: 'asc' })).toEqual(['p-2', 'p-9', 'p-10']);
	});

	it('puts unassigned and unlabelled rows last when ascending', () => {
		const mixed = [
			issue({ id: 'p-1' }),
			issue({ id: 'p-2', assignee: 'eric', labels: ['ui'] }),
			issue({ id: 'p-3', assignee: 'agent', labels: ['api'] })
		];
		expect(ids(mixed, { column: 'assignee', direction: 'asc' })).toEqual(['p-3', 'p-2', 'p-1']);
		expect(ids(mixed, { column: 'labels', direction: 'asc' })).toEqual(['p-3', 'p-2', 'p-1']);
	});

	it('ranks dependencies above dependents, and breaks ties by id', () => {
		const deps = [
			issue({ id: 'p-2', dependency_count: 0, dependent_count: 9 }),
			issue({ id: 'p-1', dependency_count: 1, dependent_count: 0 }),
			issue({ id: 'p-3', dependency_count: 1, dependent_count: 0 })
		];
		expect(ids(deps, { column: 'deps', direction: 'desc' })).toEqual(['p-1', 'p-3', 'p-2']);
	});
});
