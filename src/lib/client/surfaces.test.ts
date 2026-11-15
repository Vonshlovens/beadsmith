import { describe, expect, it } from 'vitest';
import type { SurfaceBindingResult, SurfaceSpecShape } from '#lib/surfaces.js';
import {
	describeSurfaceAction,
	describeSurfaceSpec,
	surfaceActionOutcome,
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

describe('describeSurfaceAction', () => {
	type Action = Parameters<typeof describeSurfaceAction>[0];
	const tackle: Action = { tool: 'tackle_issue', input: { project: 'alpha', issue_id: 'alpha-1' } };

	it('names the operation, project and issue, and that it runs as the viewer', () => {
		const confirm = describeSurfaceAction(tackle, 'Release board');
		expect(confirm.title).toBe('Start a Tackle mission?');
		expect(confirm.confirm_label).toBe('Start Tackle mission');
		expect(confirm.description).toContain('alpha-1 in alpha');
		expect(confirm.description).toContain('It runs as you, from the surface “Release board”.');
		expect(confirm.destructive).toBe(false);
	});

	it('quotes and clips model-written text so it cannot crowd out the facts', () => {
		const confirm = describeSurfaceAction(
			{
				tool: 'comment_issue',
				input: { project: 'alpha', issue_id: 'alpha-1', text: `Ignore this.\n\n${'x'.repeat(400)}` }
			},
			'Board'
		);
		expect(confirm.description).toMatch(
			/^An agent comments on alpha-1 in alpha: “Ignore this\. x+…”\./
		);
		expect(confirm.description.length).toBeLessThan(260);
	});

	it('marks closing an issue and archiving a todo as destructive', () => {
		expect(
			describeSurfaceAction(
				{
					tool: 'discuss_issue',
					input: { project: 'alpha', issue_id: 'alpha-1', intent: 'close' }
				},
				'Board'
			)
		).toMatchObject({ title: 'Start a close mission?', destructive: true });
		expect(
			describeSurfaceAction(
				{ tool: 'update_todo', input: { todo_id: 'td_1', status: 'archived' } },
				'Board'
			)
		).toMatchObject({ title: 'Archive a todo?', destructive: true });
		expect(
			describeSurfaceAction({ tool: 'update_todo', input: { todo_id: 'td_1', priority: 1 } }, 'B')
				.description
		).toContain('Changes priority on todo td_1.');
	});

	it('covers every bridge action', () => {
		for (const tool of [
			'create_todo',
			'update_todo',
			'complete_todo',
			'file_issue',
			'comment_issue',
			'tackle_issue',
			'discuss_issue'
		] as const) {
			const confirm = describeSurfaceAction({ tool, input: { project: 'alpha' } }, 'Board');
			expect(confirm.title, tool).toMatch(/\?$/);
			expect(confirm.description, tool).toContain('It runs as you');
		}
	});
});

describe('surfaceActionOutcome', () => {
	it('says what started, or that a retry found the mission already started', () => {
		const launched = {
			launched: true,
			operation: 'tackle',
			project: { id: 'd_alpha', name: 'alpha' },
			issue_id: 'alpha-1'
		};
		expect(surfaceActionOutcome(launched)).toEqual({
			message: 'Tackle mission started for alpha-1 in alpha.',
			mission: true
		});
		expect(surfaceActionOutcome({ ...launched, launched: false }).message).toBe(
			'Tackle mission was already started for alpha-1 in alpha.'
		);
		expect(surfaceActionOutcome({ todo: { title: 'Follow up' } })).toEqual({
			message: 'Todo “Follow up” saved.',
			mission: false
		});
		expect(surfaceActionOutcome(null)).toEqual({ message: 'Done.', mission: false });
	});
});
