import { describe, expect, it } from 'vitest';
import type { SurfaceBindingResult, SurfaceSpecShape } from '#lib/surfaces.js';
import {
	describeSurfaceSpec,
	surfaceBars,
	surfaceCount,
	surfaceIssues,
	surfaceNodes
} from './surfaces.js';

const names = (id: string) => ({ d_a: 'Alpha', d_b: 'Beta' })[id] ?? id;

function issues(data: unknown): SurfaceBindingResult {
	return { ok: true, yields: 'issues', data };
}

const row = (id: string, extra: Record<string, unknown> = {}) => ({
	id,
	title: `Title ${id}`,
	status: 'open',
	priority: 2,
	type: 'task',
	updated_at: '2026-11-01T00:00:00Z',
	...extra
});

describe('surfaceIssues', () => {
	it('takes the project from each row, as ready_work across projects and run_view return it', () => {
		const read = surfaceIssues(
			issues({
				issues: [
					row('a-1', { project_id: 'd_a' }),
					row('b-1', { project_id: 'd_b', project_name: 'Beta (named)' })
				]
			}),
			names
		);
		expect(read).toMatchObject({
			ok: true,
			value: {
				issues: [
					{ id: 'a-1', project_id: 'd_a', project_name: 'Alpha', issue_type: 'task' },
					{ id: 'b-1', project_id: 'd_b', project_name: 'Beta (named)' }
				],
				dropped: 0,
				more: false
			}
		});
	});

	it('takes the project from the result for one-project reads like list_issues', () => {
		const read = surfaceIssues(
			issues({ project: { id: 'd_a', name: 'Alpha' }, issues: [row('a-1')] }),
			names
		);
		expect(read.ok && read.value.issues[0]).toMatchObject({ project_id: 'd_a' });
	});

	it('counts rows the bridge cut to fit and notes a read that met its limit', () => {
		const read = surfaceIssues(
			issues({
				project: { id: 'd_a' },
				issues: [row('a-1'), row('a-2')],
				total: 9,
				note: 'Limit reached'
			}),
			names
		);
		expect(read).toMatchObject({ ok: true, value: { dropped: 7, more: true } });
	});

	it('leaves out rows with no id, title or project instead of drawing them half empty', () => {
		const read = surfaceIssues(
			issues({ issues: [row('a-1'), { title: 'no id', project_id: 'd_a' }, 'junk'] }),
			names
		);
		expect(read).toMatchObject({ ok: true, value: { issues: [] } });
	});

	it('passes a failed binding through as its message, never as an empty list', () => {
		expect(
			surfaceIssues({ ok: false, code: 'forbidden', message: 'needs an admin' }, names)
		).toEqual({ ok: false, message: 'needs an admin' });
		expect(surfaceIssues(undefined, names).ok).toBe(false);
	});

	it('refuses data that is not a list of issues', () => {
		expect(surfaceIssues({ ok: true, yields: 'projects', data: { projects: [] } }, names).ok).toBe(
			false
		);
		expect(surfaceIssues(issues({ issues: 'nope' }), names).ok).toBe(false);
	});
});

describe('surfaceCount', () => {
	it('counts every row read, including the ones cut to fit', () => {
		expect(
			surfaceCount({ ok: true, yields: 'todos', data: { todos: [{}, {}], total: 5 } })
		).toEqual({ ok: true, value: { count: 5, more: false } });
	});

	it('says there may be more when the read stopped at its limit', () => {
		expect(
			surfaceCount({
				ok: true,
				yields: 'projects',
				data: { projects: [{}, {}, {}], note: 'Limit reached' }
			})
		).toEqual({ ok: true, value: { count: 3, more: true } });
	});

	it('is an error, not zero, when the read failed or is a single record', () => {
		expect(surfaceCount({ ok: false, code: 'unavailable', message: 'Dolt is down' })).toEqual({
			ok: false,
			message: 'Dolt is down'
		});
		expect(surfaceCount({ ok: true, yields: 'issue', data: { issue: {} } }).ok).toBe(false);
	});
});

describe('surfaceBars', () => {
	it('counts by status in the natural status order', () => {
		const read = surfaceIssues(
			issues({
				project: { id: 'd_a' },
				issues: [
					row('a-1', { status: 'blocked' }),
					row('a-2', { status: 'open' }),
					row('a-3', { status: 'blocked' })
				]
			}),
			names
		);
		if (!read.ok) throw new Error(read.message);
		expect(surfaceBars(read.value.issues, 'status').map((b) => [b.key, b.count])).toEqual([
			['open', 1],
			['blocked', 2]
		]);
	});
});

describe('surfaceNodes and describeSurfaceSpec', () => {
	const spec = {
		root: 'main',
		components: [
			{ id: 'main', component: 'Stack', gap: 'md', children: ['t', 'a', 'b', 'list', 'c'] },
			{ id: 't', component: 'Heading', text: 'Hi', level: 2 },
			{ id: 'a', component: 'StatTile', label: 'A', count: 'x' },
			{ id: 'b', component: 'StatTile', label: 'B', count: 'x' },
			{ id: 'list', component: 'IssueList', data: 'x', limit: 25 },
			{ id: 'c', component: 'Chart', data: 'x', chart: 'bar', by: 'status' }
		],
		data: { x: { view: 'v' } },
		actions: {}
	} as SurfaceSpecShape;

	it('indexes the tree by id', () => {
		expect(surfaceNodes(spec).get('list')).toMatchObject({ component: 'IssueList' });
	});

	it('names what a surface shows in the order it first appears', () => {
		expect(describeSurfaceSpec(spec)).toBe('2 stat tiles · issue list · chart');
		expect(
			describeSurfaceSpec({
				...spec,
				components: [{ id: 'main', component: 'Text', text: 'x' }]
			} as SurfaceSpecShape)
		).toBe('Text');
	});
});
