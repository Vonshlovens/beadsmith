import { describe, expect, it } from 'vitest';
import {
	missionsNeedingYou,
	runsOnNote,
	startMode,
	startSuggestions,
	topReady,
	topTodos,
	workerSummary,
	type StartContext,
	type StartMission
} from './mate-start.js';

function ctx(over: Partial<StartContext> = {}): StartContext {
	return {
		admin: true,
		runner: 'e2b',
		can_launch: true,
		scope: null,
		ready: [],
		todos: [],
		missions: [],
		...over
	};
}

const ready = (project_id: string, project_name = project_id) => ({ project_id, project_name });
const todo = (routed_project_id: string | null, status: 'open' | 'done' = 'open') => ({
	status,
	routed_project_id
});
const mission = (over: Partial<StartMission>): StartMission => ({
	project_id: 'p1',
	status: 'succeeded',
	updated_at: '2026-11-09T10:00:00Z',
	...over
});

describe('startSuggestions', () => {
	it('offers nothing when there is no data to act on', () => {
		expect(startSuggestions(ctx())).toEqual([]);
	});

	it('offers nothing while data is loading', () => {
		expect(startSuggestions(ctx({ ready: null, todos: null, missions: null }))).toEqual([]);
	});

	it('offers nothing without a runner, whatever the data', () => {
		expect(
			startSuggestions(
				ctx({ runner: null, ready: [ready('a')], todos: [todo(null)], missions: [] })
			)
		).toEqual([]);
	});

	it('offers nothing to a member', () => {
		expect(startSuggestions(ctx({ admin: false, ready: [ready('a')] }))).toEqual([]);
	});

	it('points ready work at the project with the most ready issues', () => {
		const [first] = startSuggestions(
			ctx({ ready: [ready('a', 'api'), ready('b', 'web'), ready('b', 'web')] })
		);
		expect(first).toMatchObject({ id: 'ready', label: '2 ready issues in web' });
		expect(first?.prompt).toContain('web');
	});

	it("prefers the chat's scope when it has ready issues", () => {
		const [first] = startSuggestions(
			ctx({ scope: 'a', ready: [ready('a', 'api'), ready('b', 'web'), ready('b', 'web')] })
		);
		expect(first?.label).toBe('1 ready issue in api');
	});

	it('counts open unrouted todos and failed missions on Sand', () => {
		const out = startSuggestions(
			ctx({
				todos: [todo(null), todo(null), todo('p1'), todo(null, 'done')],
				missions: [mission({ issue_id: 'x-1', status: 'failed' })]
			})
		);
		expect(out.map((entry) => entry.label)).toEqual(['1 mission needs you', '2 todos not routed']);
	});

	it('asks for a plan, not routing, when missions cannot be launched', () => {
		const [routing] = startSuggestions(ctx({ can_launch: false, todos: [todo(null)] }));
		expect(routing?.prompt).not.toContain('routing');
		expect(routing?.prompt).toContain('1 unrouted todo');
	});

	it('offers only Beads questions on a runner without crew tools', () => {
		const out = startSuggestions(
			ctx({
				runner: 'remote',
				ready: [ready('a')],
				todos: [todo(null)],
				missions: [mission({ status: 'failed' })]
			})
		);
		expect(out.map((entry) => entry.id)).toEqual(['ready']);
	});
});

describe('missionsNeedingYou', () => {
	it('counts an issue only when its latest mission failed', () => {
		expect(
			missionsNeedingYou([
				mission({ issue_id: 'x-1', status: 'failed', updated_at: '2026-11-09T09:00:00Z' }),
				mission({ issue_id: 'x-1', status: 'succeeded', updated_at: '2026-11-09T10:00:00Z' }),
				mission({ issue_id: 'x-2', status: 'failed' }),
				mission({ status: 'failed' }),
				mission({ status: 'failed' })
			])
		).toBe(3);
	});
});

describe('runsOnNote', () => {
	const runners = [
		{ id: 'remote' as const, label: 'forge', terminal: false },
		{ id: 'e2b' as const, label: 'Sand', terminal: true }
	];

	it('is null without a runner', () => {
		expect(runsOnNote(null, runners)).toBeNull();
	});

	it('says crew tools are there on Sand', () => {
		expect(runsOnNote('e2b', runners)).toEqual({ label: 'Sand', crew: true, sand_offered: false });
	});

	it('points at Sand from a runner without crew tools when Sand is offered', () => {
		expect(runsOnNote('remote', runners)).toEqual({
			label: 'forge',
			crew: false,
			sand_offered: true
		});
		expect(runsOnNote('remote', [runners[0]!])?.sand_offered).toBe(false);
	});
});

describe('topTodos', () => {
	const now = new Date(2026, 10, 13, 12);
	const item = (id: string, priority: number, due_at: string | null, status = 'open' as const) => ({
		id,
		priority,
		due_at,
		status,
		routed_project_id: null
	});

	it('keeps open todos, most urgent first', () => {
		const out = topTodos(
			[
				item('later', 2, null),
				item('overdue', 2, '2026-11-10'),
				item('done', 0, '2026-11-10', 'done' as 'open'),
				item('p0', 0, null),
				item('p4', 4, null)
			],
			now
		);
		expect(out.map((todo) => todo.id)).toEqual(['overdue', 'p0', 'later']);
	});

	it('honours the limit', () => {
		expect(topTodos([item('a', 1, null), item('b', 1, null)], now, 1)).toHaveLength(1);
	});
});

describe('topReady', () => {
	it("lists the scope's issues first when it has any", () => {
		const out = topReady([ready('a'), ready('b'), ready('b')], 'b');
		expect(out.map((issue) => issue.project_id)).toEqual(['b', 'b']);
	});

	it("falls back to the deck's order when the scope has none", () => {
		const out = topReady([ready('a'), ready('b'), ready('c'), ready('d')], 'z');
		expect(out.map((issue) => issue.project_id)).toEqual(['a', 'b', 'c']);
	});
});

describe('workerSummary', () => {
	it('lists working missions, then the ones that need you', () => {
		const summary = workerSummary([
			mission({ issue_id: 'x-1', status: 'failed' }),
			mission({ issue_id: 'x-2', status: 'running' }),
			mission({ issue_id: 'x-3', status: 'succeeded' }),
			mission({ issue_id: 'x-4', status: 'queued' })
		]);
		expect(summary.working).toBe(2);
		expect(summary.needs_you).toBe(1);
		expect(summary.rows.map((row) => row.issue_id)).toEqual(['x-2', 'x-4', 'x-1']);
	});

	it('leaves out a failure someone already retried', () => {
		const summary = workerSummary([
			mission({ issue_id: 'x-1', status: 'succeeded', updated_at: '2026-11-09T11:00:00Z' }),
			mission({ issue_id: 'x-1', status: 'failed', updated_at: '2026-11-09T09:00:00Z' })
		]);
		expect(summary).toEqual({ working: 0, needs_you: 0, rows: [] });
	});
});

describe('startMode', () => {
	const base = { loaded: true, has_status: true, admin_only: false, connected: true };

	it('waits for status before saying anything', () => {
		expect(startMode({ ...base, loaded: false })).toBe('loading');
	});

	it('reports a failed status read instead of "not connected"', () => {
		expect(startMode({ ...base, has_status: false, connected: false })).toBe('error');
	});

	it('tells members, then placeholder admins, apart from a working chat', () => {
		expect(startMode({ ...base, admin_only: true })).toBe('members');
		expect(startMode({ ...base, connected: false })).toBe('placeholder');
		expect(startMode(base)).toBe('chat');
	});
});
