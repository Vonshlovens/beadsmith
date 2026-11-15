import { describe, expect, it } from 'vitest';
import type { ViewIssue, ViewSpecShape } from '#lib/views.js';
import {
	describeViewSpec,
	groupViewIssues,
	projectPageForView,
	projectPageHref,
	SAVED_VIEW_PARAM,
	sameViewSpec,
	slugFromName,
	viewBoardProjects,
	viewSpecFromProjectPage
} from './views.js';
import { readListFilters } from './issue-list-cache.js';
import { parseIssueView } from './issue-view.js';

function issue(overrides: Partial<ViewIssue> & { id: string }): ViewIssue {
	return {
		title: overrides.id,
		status: 'open',
		priority: 2,
		issue_type: 'task',
		created_at: '2026-11-01T00:00:00Z',
		updated_at: '2026-11-01T00:00:00Z',
		project_id: 'd_a',
		project_name: 'Alpha',
		...overrides
	} as ViewIssue;
}

describe('groupViewIssues', () => {
	it('is one unlabelled group with no grouping', () => {
		const rows = [issue({ id: 'a-1' }), issue({ id: 'a-2' })];
		expect(groupViewIssues(rows, undefined)).toEqual([{ key: 'all', label: '', issues: rows }]);
	});

	it('groups statuses and priorities in their natural order, keeping row order', () => {
		const rows = [
			issue({ id: 'a-1', status: 'blocked', priority: 3 }),
			issue({ id: 'a-2', status: 'open', priority: 0 }),
			issue({ id: 'a-3', status: 'blocked', priority: 0 })
		];
		const by_status = groupViewIssues(rows, 'status');
		expect(by_status.map((g) => [g.key, g.issues.map((i) => i.id)])).toEqual([
			['open', ['a-2']],
			['blocked', ['a-1', 'a-3']]
		]);
		expect(groupViewIssues(rows, 'priority').map((g) => g.label)).toEqual([
			'P0 · Critical',
			'P3 · Low'
		]);
	});

	it('puts unassigned work last', () => {
		const rows = [issue({ id: 'a-1' }), issue({ id: 'a-2', assignee: 'zed' })];
		expect(groupViewIssues(rows, 'assignee').map((g) => g.label)).toEqual(['zed', 'Unassigned']);
	});
});

describe('describeViewSpec', () => {
	it('says where, what, order and presentation', () => {
		const spec: ViewSpecShape = {
			scope: { project: 'd_a' },
			filters: { status: ['in_progress'], label: 'review', include_closed: true },
			sort: 'priority',
			presentation: 'list',
			group_by: 'assignee'
		};
		expect(describeViewSpec(spec, () => 'Alpha')).toEqual([
			'Alpha',
			'Status: in progress',
			'Label: review',
			'Includes closed',
			'Sorted: Priority',
			'List by assignee'
		]);
	});
});

describe('viewBoardProjects', () => {
	it('splits rows per project in first-seen order', () => {
		const rows = [
			issue({ id: 'b-1', project_id: 'd_b', project_name: 'Beta' }),
			issue({ id: 'a-1' }),
			issue({ id: 'b-2', project_id: 'd_b', project_name: 'Beta' })
		];
		expect(viewBoardProjects(rows).map((p) => [p.project_id, p.issues.length])).toEqual([
			['d_b', 2],
			['d_a', 1]
		]);
	});
});

describe('saving the project page as a view', () => {
	const filters = {
		status: ['in_progress', 'blocked'],
		type: ['bug'],
		priority: [0, 1],
		q: '  login ',
		include_closed: false
	};

	it('captures filters and presentation, parade as the status-grouped list', () => {
		expect(viewSpecFromProjectPage('d_a', filters, 'parade')).toEqual({
			scope: { project: 'd_a' },
			filters: { status: ['in_progress', 'blocked'], type: ['bug'], priority: [0, 1], q: 'login' },
			sort: 'updated',
			presentation: 'list',
			group_by: 'status'
		});
		const board = viewSpecFromProjectPage(
			'd_a',
			{ ...filters, q: '', include_closed: true },
			'board'
		);
		expect(board.presentation).toBe('board');
		expect(board.group_by).toBeUndefined();
		expect(board.filters.include_closed).toBe(true);
		expect(board.filters.q).toBeUndefined();
		expect(viewSpecFromProjectPage('d_a', filters, 'list').group_by).toBeUndefined();
	});

	it("keeps the open view's sort, which the page cannot change", () => {
		const base: ViewSpecShape = {
			scope: { project: 'd_a' },
			filters: {},
			sort: 'priority',
			presentation: 'list'
		};
		expect(viewSpecFromProjectPage('d_a', filters, 'list', base).sort).toBe('priority');
	});

	it('round-trips through the project page URL', () => {
		for (const view of ['parade', 'list', 'board'] as const) {
			const spec = viewSpecFromProjectPage('d_a', { ...filters, q: 'login' }, view);
			const href = projectPageHref('hot-bugs', spec);
			expect(href).not.toBeNull();
			const url = new URL(href!, 'http://x');
			expect(url.pathname).toBe('/p/d_a');
			expect(url.searchParams.get(SAVED_VIEW_PARAM)).toBe('hot-bugs');
			const again = viewSpecFromProjectPage(
				'd_a',
				readListFilters(url.searchParams),
				parseIssueView(url.searchParams.get('view'))
			);
			expect(sameViewSpec(again, spec)).toBe(true);
		}
	});

	it('offers no project page for what the page cannot show', () => {
		const base: ViewSpecShape = {
			scope: { project: 'd_a' },
			filters: {},
			sort: 'updated',
			presentation: 'list'
		};
		expect(projectPageForView(base)?.view).toBe('list');
		expect(projectPageForView({ ...base, scope: 'all' })).toBeNull();
		expect(projectPageForView({ ...base, filters: { label: 'review' } })).toBeNull();
		expect(projectPageForView({ ...base, filters: { assignee: 'ann' } })).toBeNull();
		expect(projectPageForView({ ...base, filters: { limit: 20 } })).toBeNull();
		expect(projectPageForView({ ...base, group_by: 'priority' })).toBeNull();
		expect(projectPageForView({ ...base, presentation: 'board', group_by: 'priority' })?.view).toBe(
			'board'
		);
		expect(projectPageHref('x', { ...base, scope: 'all' })).toBeNull();
	});

	it('compares specs by what they select and show', () => {
		const a = viewSpecFromProjectPage('d_a', filters, 'list');
		const reordered = viewSpecFromProjectPage(
			'd_a',
			{ ...filters, status: ['blocked', 'in_progress'], priority: [1, 0] },
			'list'
		);
		expect(sameViewSpec(a, reordered)).toBe(true);
		expect(sameViewSpec(a, { ...a, filters: { ...a.filters, include_closed: false } })).toBe(true);
		expect(sameViewSpec(a, viewSpecFromProjectPage('d_a', filters, 'parade'))).toBe(false);
		expect(sameViewSpec(a, viewSpecFromProjectPage('d_a', { ...filters, type: [] }, 'list'))).toBe(
			false
		);
		const board = viewSpecFromProjectPage('d_a', filters, 'board');
		expect(sameViewSpec(board, { ...board, group_by: 'status' })).toBe(true);
	});

	it('suggests a slug the store accepts', () => {
		expect(slugFromName('Blocked on Review!')).toBe('blocked-on-review');
		expect(slugFromName('  Café — P0s  ')).toBe('cafe-p0s');
		expect(slugFromName('???')).toBe('');
		const long = slugFromName('word '.repeat(40));
		expect(long.length).toBeLessThanOrEqual(64);
		expect(long).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
	});
});
