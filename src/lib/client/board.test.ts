import { describe, expect, it } from 'vitest';
import {
	boardColumnCreateEnabled,
	boardCreateHeading,
	fileStatusAfterCreate,
	groupBoardColumns,
	sortBoardCards,
	visibleBoardColumns
} from './board.js';
import { STATUS_KEYS } from './format.js';
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

describe('visibleBoardColumns', () => {
	it('hides closed unless include_closed is on', () => {
		expect(visibleBoardColumns({ status_filter: [], include_closed: false })).toEqual(
			STATUS_KEYS.filter((key) => key !== 'closed')
		);
		expect(visibleBoardColumns({ status_filter: [], include_closed: true })).toEqual([
			...STATUS_KEYS
		]);
	});

	it('shows only the statuses named by the filter, including closed', () => {
		expect(
			visibleBoardColumns({ status_filter: ['blocked', 'closed'], include_closed: false })
		).toEqual(['blocked', 'closed']);
	});

	it('keeps STATUS_KEYS order when the filter is shuffled', () => {
		expect(
			visibleBoardColumns({
				status_filter: ['hooked', 'open', 'in_progress'],
				include_closed: false
			})
		).toEqual(['open', 'in_progress', 'hooked']);
	});

	it('drops unknown status filter tokens', () => {
		expect(visibleBoardColumns({ status_filter: ['nope', 'open'], include_closed: true })).toEqual([
			'open'
		]);
	});
});

describe('sortBoardCards', () => {
	it('orders by priority ascending, then updated_at descending', () => {
		const rows = [
			issue({ id: 'p-old-p0', priority: 0, updated_at: '2026-07-01T00:00:00Z' }),
			issue({ id: 'p-new-p2', priority: 2, updated_at: '2026-07-04T00:00:00Z' }),
			issue({ id: 'p-new-p0', priority: 0, updated_at: '2026-07-03T00:00:00Z' }),
			issue({ id: 'p-mid-p0', priority: 0, updated_at: '2026-07-02T00:00:00Z' })
		];

		expect(sortBoardCards(rows).map((row) => row.id)).toEqual([
			'p-new-p0',
			'p-mid-p0',
			'p-old-p0',
			'p-new-p2'
		]);
	});

	it('does not mutate the input', () => {
		const rows = [issue({ id: 'b', priority: 3 }), issue({ id: 'a', priority: 1 })];
		sortBoardCards(rows);
		expect(rows.map((row) => row.id)).toEqual(['b', 'a']);
	});
});

describe('groupBoardColumns', () => {
	const rows = [
		issue({ id: 'a', status: 'open', priority: 2 }),
		issue({ id: 'b', status: 'in_progress', priority: 1 }),
		issue({ id: 'c', status: 'closed', priority: 0 }),
		issue({ id: 'd', status: 'blocked', priority: 3 })
	];

	it('buckets by statusKey and keeps empty columns', () => {
		const columns = groupBoardColumns(rows, { status_filter: [], include_closed: true });
		const by_status = Object.fromEntries(
			columns.map((column) => [column.status, column.issues.map((item) => item.id)])
		);

		expect(columns.map((column) => column.status)).toEqual([...STATUS_KEYS]);
		expect(by_status.open).toEqual(['a']);
		expect(by_status.in_progress).toEqual(['b']);
		expect(by_status.blocked).toEqual(['d']);
		expect(by_status.closed).toEqual(['c']);
		expect(by_status.deferred).toEqual([]);
		expect(columns.find((column) => column.status === 'in_progress')?.label).toBe('in progress');
	});

	it('drops closed issues when the closed column is hidden', () => {
		const columns = groupBoardColumns(rows, { status_filter: [], include_closed: false });
		expect(columns.some((column) => column.status === 'closed')).toBe(false);
		expect(columns.flatMap((column) => column.issues).map((item) => item.id)).toEqual([
			'a',
			'b',
			'd'
		]);
	});

	it('keeps an empty filtered column so the board skeleton stays stable', () => {
		const columns = groupBoardColumns(rows, {
			status_filter: ['open', 'deferred'],
			include_closed: false
		});
		expect(columns.map((column) => ({ status: column.status, n: column.issues.length }))).toEqual([
			{ status: 'open', n: 1 },
			{ status: 'deferred', n: 0 }
		]);
	});
});

describe('fileStatusAfterCreate', () => {
	it('omits open so the worker can skip the follow-up status write', () => {
		expect(fileStatusAfterCreate(undefined)).toBeUndefined();
		expect(fileStatusAfterCreate('open')).toBeUndefined();
		expect(fileStatusAfterCreate('in_progress')).toBe('in_progress');
		expect(fileStatusAfterCreate('closed')).toBe('closed');
	});
});

describe('boardCreateHeading', () => {
	it('names the column status in the File dialog title', () => {
		expect(boardCreateHeading('in_progress')).toBe('New in progress issue');
		expect(boardCreateHeading('open')).toBe('New open issue');
	});
});

describe('boardColumnCreateEnabled', () => {
	it('follows File allow, not Project.readonly', () => {
		expect(boardColumnCreateEnabled(false)).toBe(false);
		expect(boardColumnCreateEnabled(true)).toBe(true);
	});
});
