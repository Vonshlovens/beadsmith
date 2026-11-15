import { createClient } from '@libsql/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initStateSchema } from '../state/db.js';
import { createDispatchStore, type DispatchStore } from '../dispatch/store.js';
import type { AgentProvider } from '../dispatch/provider.js';
import type { DispatchDeps } from '../dispatch/service.js';
import { DISARMED_DISPATCH_MESSAGE } from '../dispatch/policy.js';
import { createTodoStore, type TodoStore } from '../todos/store.js';
import { createLaunchLimiter } from '../crew/launch-limit.js';
import type { CrewDeps } from '../crew/registry.js';
import type { DoltClient } from '../dolt/client.js';
import type { IssueDetail, Project } from '#lib/types.js';
import { createGrownStore, type GrownStore, type GrownThing } from './store.js';
import type { BridgeViewer } from './bindings.js';
import { runSurfaceAction, surface_action_request_schema, type ActionDeps } from './actions.js';

const OWNER: BridgeViewer = { account_id: 'acct_owner', role: 'admin', actor: 'o@example.test' };
const ADMIN2: BridgeViewer = { account_id: 'acct_admin2', role: 'admin', actor: 'a2@example.test' };
const MEMBER: BridgeViewer = { account_id: 'acct_member', role: 'member', actor: 'm@example.test' };
const AUTHOR = { kind: 'person', account_id: OWNER.account_id, chat_id: null } as const;

const PROJECT: Project = {
	id: 'd_alpha',
	name: 'alpha',
	state: 'remote',
	dolt_database: 'alpha',
	backend: 'server-sql',
	readonly: true
};

const ISSUE: IssueDetail = {
	id: 'alpha-1',
	title: 'Issue alpha-1',
	status: 'open',
	priority: 2,
	issue_type: 'task',
	labels: [],
	created_at: '2026-11-01T00:00:00Z',
	updated_at: '2026-11-01T00:00:00Z',
	dependency_count: 0,
	dependent_count: 0,
	comment_count: 0,
	description: 'Do it.',
	dependencies: [],
	dependents: [],
	comments: []
};

let store: GrownStore;
let dispatch_store: DispatchStore;
let todo_store: TodoStore;
let launches: ReturnType<typeof vi.fn<AgentProvider['launch']>>;
let dispatch: DispatchDeps;
let deps: ActionDeps;

beforeEach(async () => {
	const client = createClient({ url: ':memory:' });
	await initStateSchema(client);
	store = createGrownStore(client);
	dispatch_store = createDispatchStore(client);
	todo_store = createTodoStore(client);
	let n = 0;
	launches = vi.fn<AgentProvider['launch']>(async () => ({
		agent_id: `agent-${++n}`,
		run_id: `run-${n}`
	}));
	const provider: AgentProvider = {
		id: 'e2b',
		label: 'Sand',
		launch: launches,
		getLatestRunId: vi.fn(async () => undefined),
		getRun: vi.fn(async () => ({ status: 'succeeded' as const })),
		createRun: vi.fn(async () => ({ run_id: 'run-follow' })),
		cancelRun: vi.fn(async () => undefined)
	};
	dispatch = {
		store: dispatch_store,
		providers: [provider],
		policy: { armed: true, allow: { file: true, tackle: true } },
		repositories: {
			d_alpha: { url: 'https://github.com/example-org/alpha', ref: 'main', auto_create_pr: true }
		},
		sqlite_maps: {},
		file_maps: {},
		schedule_background: () => {}
	};
	const dolt: Partial<DoltClient> = {
		issueDetail: async (_database, id) => (id === ISSUE.id ? ISSUE : undefined)
	};
	const crew: CrewDeps = {
		projects: async () => [PROJECT],
		read: { dolt: dolt as DoltClient, dolt_configured: true },
		dispatch,
		todos: async () => todo_store,
		launch_limiter: createLaunchLimiter({ count: 3, window_ms: 600_000 })
	};
	deps = { crew };
});

/** A surface with one button per action. */
async function surface(
	actions: Record<string, { tool: string; input: Record<string, unknown> }>,
	publish = false
): Promise<void> {
	const names = Object.keys(actions);
	await store.create(OWNER, {
		kind: 'surface',
		slug: 'board',
		name: 'Board',
		spec: {
			root: 'main',
			components: [
				{ id: 'main', component: 'Stack', children: names.map((name) => `b_${name}`) },
				...names.map((name) => ({
					id: `b_${name}`,
					component: 'Button',
					label: 'Refresh',
					action: name
				}))
			],
			actions
		},
		author: AUTHOR
	});
	if (publish) await store.publish(OWNER, 'board');
}

const TACKLE = {
	tackle: { tool: 'tackle_issue', input: { project: 'd_alpha', issue_id: 'alpha-1' } }
};

async function asSeen(viewer: BridgeViewer): Promise<GrownThing> {
	const thing = await store.read(viewer, 'board');
	if (thing === undefined) throw new Error(`${viewer.account_id} cannot see board`);
	return thing;
}

function run(viewer: BridgeViewer, thing: GrownThing, name: string, key = 'confirm-1') {
	return runSurfaceAction(
		store,
		viewer,
		thing,
		name,
		{ revision: thing.revision.number, key },
		deps
	);
}

describe('runSurfaceAction', () => {
	it('launches as the viewer and records the surface on the mission, not a chat', async () => {
		await surface(TACKLE);
		const result = (await run(OWNER, await asSeen(OWNER), 'tackle')) as Record<string, unknown>;
		expect(result).toMatchObject({ launched: true, operation: 'tackle', issue_id: 'alpha-1' });

		const [mission] = await dispatch_store.list({ limit: 10 });
		expect(mission.grown_slug).toBe('board');
		expect(mission.chat_id).toBeUndefined();
		expect(mission.actor).toBe(OWNER.actor);
		expect(launches).toHaveBeenCalledTimes(1);
	});

	it('replays a retried confirmation and starts a new mission for a new one', async () => {
		await surface(TACKLE);
		const thing = await asSeen(OWNER);
		await run(OWNER, thing, 'tackle', 'confirm-1');
		const replay = (await run(OWNER, thing, 'tackle', 'confirm-1')) as Record<string, unknown>;
		expect(replay.launched).toBe(false);
		expect(launches).toHaveBeenCalledTimes(1);

		await run(OWNER, thing, 'tackle', 'confirm-2');
		expect(launches).toHaveBeenCalledTimes(2);
	});

	it("runs an admin's published button as the admin who pressed it", async () => {
		await surface(TACKLE, true);
		await run(ADMIN2, await asSeen(ADMIN2), 'tackle');
		const [mission] = await dispatch_store.list({ limit: 10 });
		expect(mission.actor).toBe(ADMIN2.actor);
		expect(mission.grown_slug).toBe('board');
	});

	it('refuses a member: the author’s role never carries over', async () => {
		await surface({ ...TACKLE, add: { tool: 'create_todo', input: { title: 'Follow up' } } }, true);
		const thing = await asSeen(MEMBER);
		for (const name of ['tackle', 'add']) {
			await expect(run(MEMBER, thing, name)).rejects.toMatchObject({ code: 'forbidden' });
		}
		expect(launches).not.toHaveBeenCalled();
		expect(await todo_store.list({ limit: 10 })).toHaveLength(0);
	});

	it('refuses a revision other than the one on screen', async () => {
		await surface(TACKLE);
		const thing = await asSeen(OWNER);
		await expect(
			runSurfaceAction(store, OWNER, thing, 'tackle', { revision: 2, key: 'confirm-1' }, deps)
		).rejects.toMatchObject({ code: 'conflict' });
		expect(launches).not.toHaveBeenCalled();
	});

	it('refuses an action the surface does not have', async () => {
		await surface(TACKLE);
		await expect(run(OWNER, await asSeen(OWNER), 'nope')).rejects.toMatchObject({
			code: 'not_found'
		});
	});

	it('keeps dispatch policy: a disarmed service refuses the launch', async () => {
		await surface(TACKLE);
		dispatch.policy = { armed: false, allow: { file: true, tackle: true } };
		await expect(run(OWNER, await asSeen(OWNER), 'tackle')).rejects.toThrow(
			DISARMED_DISPATCH_MESSAGE
		);
		expect(launches).not.toHaveBeenCalled();
	});

	it('keeps the launch limit per viewer and surface, and says so for a person', async () => {
		await surface(TACKLE, true);
		const thing = await asSeen(OWNER);
		for (const key of ['k-000001', 'k-000002', 'k-000003']) await run(OWNER, thing, 'tackle', key);
		await expect(run(OWNER, thing, 'tackle', 'k-000004')).rejects.toMatchObject({
			code: 'bad_request',
			message: expect.stringContaining('this surface may start for you 3 missions')
		});
		// Another admin's budget is their own.
		await run(ADMIN2, await asSeen(ADMIN2), 'tackle', 'k-000005');
		expect(launches).toHaveBeenCalledTimes(4);
	});

	it('changes todos as the viewer', async () => {
		await surface({ add: { tool: 'create_todo', input: { title: 'Follow up' } } });
		const result = (await run(OWNER, await asSeen(OWNER), 'add')) as { todo: { title: string } };
		expect(result.todo.title).toBe('Follow up');
		const [todo] = await todo_store.list({ limit: 10 });
		expect(todo.created_by).toBe(OWNER.account_id);
	});
});

describe('surface_action_request_schema', () => {
	it('takes a revision and a confirmation key, nothing else', () => {
		const key = '9b2f8c1e-7a4d-4e1b-9c3a-2f6d8e0b1a5c';
		expect(surface_action_request_schema.safeParse({ revision: 1, key }).success).toBe(true);
		for (const body of [
			{ revision: 0, key },
			{ revision: 1, key: 'short' },
			{ revision: 1, key: 'has space in it' },
			{ revision: 1, key, input: { issue_id: 'alpha-2' } }
		]) {
			expect(surface_action_request_schema.safeParse(body).success, JSON.stringify(body)).toBe(
				false
			);
		}
	});
});
