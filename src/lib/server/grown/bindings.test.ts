import { createClient } from '@libsql/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { initStateSchema } from '../state/db.js';
import { createTodoStore } from '../todos/store.js';
import { createLaunchLimiter } from '../crew/launch-limit.js';
import { defineTool, RESULT_MAX_CHARS, type CrewContext, type CrewTool } from '../crew/registry.js';
import type { DoltClient } from '../dolt/client.js';
import type { IssueSummary, Project } from '#lib/types.js';
import { createGrownStore, type GrownStore, type GrownThing } from './store.js';
import {
	bridgeContext,
	resolveSurfaceBindings,
	surfaceBindingNames,
	takeBridgeCalls,
	type BindingDeps,
	type BridgeViewer
} from './bindings.js';
import { GrownError } from './errors.js';

const OWNER: BridgeViewer = { account_id: 'acct_owner', role: 'admin', actor: 'o@example.test' };
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

function issue(id: string, overrides: Partial<IssueSummary> = {}): IssueSummary {
	return {
		id,
		title: `Issue ${id}`,
		status: 'open',
		priority: 2,
		issue_type: 'task',
		labels: [],
		created_at: '2026-11-01T00:00:00Z',
		updated_at: '2026-11-01T00:00:00Z',
		dependency_count: 0,
		dependent_count: 0,
		comment_count: 0,
		...overrides
	};
}

let store: GrownStore;
let rows: IssueSummary[];
let deps: BindingDeps;

beforeEach(async () => {
	const client = createClient({ url: ':memory:' });
	await initStateSchema(client);
	store = createGrownStore(client);
	rows = [issue('alpha-1'), issue('alpha-2', { status: 'blocked' })];
	const todos = createTodoStore(client);
	const dolt: Partial<DoltClient> = { browseIssues: async () => rows };
	deps = {
		crew: {
			projects: async () => [PROJECT],
			read: { dolt: dolt as DoltClient, dolt_configured: true },
			todos: async () => todos
		}
	};
});

/** A surface over the given bindings, each shown by a stat tile. */
function surfaceSpec(data: Record<string, unknown>) {
	const names = Object.keys(data);
	return {
		root: 'main',
		components: [
			{ id: 'main', component: 'Stack', children: names.map((name) => `t_${name}`) },
			...names.map((name) => ({
				id: `t_${name}`,
				component: 'StatTile',
				label: name,
				count: name
			}))
		],
		data
	};
}

async function surface(data: Record<string, unknown>, slug = 'board'): Promise<GrownThing> {
	return store.create(OWNER, {
		kind: 'surface',
		slug,
		name: 'Board',
		spec: surfaceSpec(data),
		author: AUTHOR
	});
}

async function view(slug = 'blocked', publish = false) {
	await store.create(OWNER, {
		kind: 'view',
		slug,
		name: 'Blocked',
		spec: { scope: { project: 'd_alpha' }, filters: { status: ['blocked'] } },
		author: AUTHOR
	});
	if (publish) await store.publish(OWNER, slug);
}

/** The surface as `viewer` sees it, as the route reads it. */
async function asSeen(viewer: BridgeViewer, slug = 'board'): Promise<GrownThing> {
	const thing = await store.read(viewer, slug);
	if (thing === undefined) throw new Error(`${viewer.account_id} cannot see ${slug}`);
	return thing;
}

describe('surface bindings resolve as the viewer', () => {
	it('runs a view binding through run_view, in the issues shape a tool read gives', async () => {
		await view();
		const thing = await surface({ blocked: { view: 'blocked' } });
		const out = await resolveSurfaceBindings(store, OWNER, thing, undefined, deps);
		expect(out.blocked).toMatchObject({
			ok: true,
			yields: 'issues',
			data: {
				issues: [
					expect.objectContaining({ id: 'alpha-1', project_id: 'd_alpha', project_name: 'alpha' }),
					expect.objectContaining({ id: 'alpha-2', status: 'blocked', type: 'task' })
				]
			}
		});
	});

	it('runs a bridge read tool through its crew handler', async () => {
		const thing = await surface({ projects: { tool: 'list_projects', input: {} } });
		const out = await resolveSurfaceBindings(store, MEMBER, thing, undefined, deps);
		expect(out.projects).toMatchObject({
			ok: true,
			yields: 'projects',
			data: { projects: [expect.objectContaining({ id: 'd_alpha', name: 'alpha' })] }
		});
	});

	it("reads an admin's published surface as a member: list_todos is refused", async () => {
		await view('blocked', true);
		await surface({
			todos: { tool: 'list_todos', input: {} },
			blocked: { view: 'blocked' }
		});
		await store.publish(OWNER, 'board');

		const as_member = await resolveSurfaceBindings(
			store,
			MEMBER,
			await asSeen(MEMBER),
			undefined,
			deps
		);
		expect(as_member.todos).toEqual({
			ok: false,
			code: 'forbidden',
			message: 'list_todos needs an admin account; this surface reads as you.'
		});
		// The other binding still resolves: one refusal does not blank the surface.
		expect(as_member.blocked).toMatchObject({ ok: true, yields: 'issues' });

		const as_owner = await resolveSurfaceBindings(
			store,
			OWNER,
			await asSeen(OWNER),
			undefined,
			deps
		);
		expect(as_owner.todos).toMatchObject({ ok: true, yields: 'todos', data: { todos: [] } });
	});

	it('refuses a member a view the admin has not published, even through a published surface', async () => {
		await view('blocked', false);
		await surface({ blocked: { view: 'blocked' } });
		await store.publish(OWNER, 'board');
		const out = await resolveSurfaceBindings(store, MEMBER, await asSeen(MEMBER), undefined, deps);
		expect(out.blocked).toEqual({
			ok: false,
			code: 'bad_request',
			message: 'There is no view called "blocked".'
		});
	});

	it('resolves the bindings of the revision the viewer sees', async () => {
		await surface({ projects: { tool: 'list_projects', input: {} } });
		await store.publish(OWNER, 'board');
		await store.revise(OWNER, 'board', {
			spec: surfaceSpec({ todos: { tool: 'list_todos', input: {} } }),
			author: AUTHOR
		});
		expect(surfaceBindingNames(await asSeen(MEMBER))).toEqual(['projects']);
		expect(surfaceBindingNames(await asSeen(OWNER))).toEqual(['todos']);
	});

	it('gives the tool a context built from the viewer, never the author', async () => {
		const seen: CrewContext[] = [];
		const spy: CrewTool = defineTool({
			name: 'list_projects',
			description: 'spy',
			input: z.strictObject({}),
			async handler(ctx) {
				seen.push(ctx);
				return { projects: [] };
			}
		});
		await surface({ projects: { tool: 'list_projects', input: {} } });
		await store.publish(OWNER, 'board');
		await resolveSurfaceBindings(store, MEMBER, await asSeen(MEMBER), undefined, {
			...deps,
			tool: async () => spy
		});
		expect(seen).toEqual([bridgeContext(MEMBER, 'board')]);
		expect(seen[0]).toMatchObject({ account_id: 'acct_member', role: 'member', scope: null });
	});

	it('resolves only the named bindings and refuses an unknown name', async () => {
		const thing = await surface({
			projects: { tool: 'list_projects', input: {} },
			ready: { tool: 'ready_work', input: {} }
		});
		expect(surfaceBindingNames(thing, ['ready', 'ready'])).toEqual(['ready']);
		expect(() => surfaceBindingNames(thing, ['nope'])).toThrow(GrownError);
		const out = await resolveSurfaceBindings(store, OWNER, thing, ['projects'], deps);
		expect(Object.keys(out)).toEqual(['projects']);
	});

	it('turns a failing read into an error value with no driver detail', async () => {
		await view();
		const thing = await surface({ blocked: { view: 'blocked' } });
		const broken: Partial<DoltClient> = {
			browseIssues: async () => {
				throw new Error('connect ECONNREFUSED 10.0.0.1:3306 password=hunter2');
			}
		};
		const out = await resolveSurfaceBindings(store, OWNER, thing, undefined, {
			...deps,
			crew: { ...deps.crew, read: { dolt: broken as DoltClient, dolt_configured: true } }
		});
		expect(out.blocked).toMatchObject({ ok: false });
		expect(JSON.stringify(out.blocked)).not.toContain('hunter2');
		expect(JSON.stringify(out.blocked)).not.toContain('10.0.0.1');
	});

	it('bounds a large result by dropping whole rows and keeps the full count', async () => {
		rows = Array.from({ length: 400 }, (_, i) => issue(`alpha-${i}`, { title: 'x'.repeat(120) }));
		await view();
		const thing = await surface({ blocked: { view: 'blocked' } });
		const out = await resolveSurfaceBindings(store, OWNER, thing, undefined, deps);
		expect(out.blocked).toMatchObject({ ok: true, truncated: true });
		const data = (out.blocked as { data: { issues: unknown[]; total: number } }).data;
		expect(data.total).toBe(200); // the view's default row limit
		expect(data.issues.length).toBeLessThan(200);
		expect(JSON.stringify(data).length).toBeLessThanOrEqual(RESULT_MAX_CHARS);
	});
});

describe('bridge call limit', () => {
	it('allows 60 calls a minute per viewer and surface, all or none per request', () => {
		let now = 0;
		const limiter = createLaunchLimiter({ count: 60, window_ms: 60_000, now: () => now });
		expect(takeBridgeCalls(limiter, MEMBER, 'board', 50)).toEqual({ ok: true });
		// Twelve more would cross 60: refused whole, nothing taken.
		expect(takeBridgeCalls(limiter, MEMBER, 'board', 12)).toEqual({
			ok: false,
			retry_after_ms: 60_000
		});
		expect(takeBridgeCalls(limiter, MEMBER, 'board', 10)).toEqual({ ok: true });
		expect(takeBridgeCalls(limiter, MEMBER, 'board', 1).ok).toBe(false);
		// Another surface, or another viewer of this one, has its own budget.
		expect(takeBridgeCalls(limiter, MEMBER, 'other', 1).ok).toBe(true);
		expect(takeBridgeCalls(limiter, OWNER, 'board', 1).ok).toBe(true);
		now = 60_000;
		expect(takeBridgeCalls(limiter, MEMBER, 'board', 60).ok).toBe(true);
	});
});
