import { describe, expect, it } from 'vitest';
import {
	missionsNeedingYou,
	runsOnNote,
	startSuggestions,
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
		{ id: 'remote' as const, label: 'forge' },
		{ id: 'e2b' as const, label: 'Sand' }
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
