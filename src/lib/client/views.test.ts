import { describe, expect, it } from 'vitest';
import type { ViewIssue, ViewSpecShape } from '#lib/views.js';
import { describeViewSpec, groupViewIssues, viewBoardProjects } from './views.js';

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
