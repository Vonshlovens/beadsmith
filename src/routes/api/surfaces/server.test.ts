import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requiredPermission, roleCan } from '#lib/server/auth/roles.js';
import { createGrownStore, type GrownStore } from '#lib/server/grown/store.js';
import { initStateSchema, setGrownStore, setTodoStore } from '#lib/server/state/db.js';
import { createTodoStore } from '#lib/server/todos/store.js';
import type {
	SurfaceDataResponse,
	SurfaceHistoryResponse,
	SurfaceResponse,
	SurfacesResponse,
	SurfaceSummary
} from '#lib/surfaces.js';
import { GET as LIST, POST as CREATE } from './+server.js';
import { DELETE, GET as GET_ONE, PATCH } from './[slug]/+server.js';
import { GET as HISTORY } from './[slug]/history/+server.js';
import { DELETE as UNPUBLISH, PUT as PUBLISH } from './[slug]/publish/+server.js';
import { POST as REVERT } from './[slug]/revert/+server.js';
import { GET as DATA } from './[slug]/data/+server.js';
import { GET as VIEW_GET, PATCH as VIEW_PATCH } from '../views/[slug]/+server.js';
import { GET as VIEW_LIST, POST as VIEW_CREATE } from '../views/+server.js';

type User = { id: string; email: string; name: string; role: 'admin' | 'member' };
const OWNER: User = { id: 'acct_owner', email: 'owner@example.test', name: 'Owner', role: 'admin' };
const ADMIN2: User = { id: 'acct_admin2', email: 'a2@example.test', name: 'Other', role: 'admin' };
const MEMBER: User = { id: 'acct_member', email: 'm@example.test', name: 'Member', role: 'member' };

let store: GrownStore;

beforeEach(async () => {
	const client = createClient({ url: ':memory:' });
	await initStateSchema(client);
	store = createGrownStore(client);
	setGrownStore(store);
	setTodoStore(createTodoStore(client));
});

afterEach(() => {
	setGrownStore(undefined);
	setTodoStore(undefined);
});

type Handler = (event: never) => Promise<Response> | Response;

function call(
	handler: Handler,
	method: string,
	path: string,
	options: { body?: unknown; slug?: string; user?: User | null } = {}
): Promise<Response> {
	const url = new URL(`http://localhost${path}`);
	const user = options.user === undefined ? OWNER : options.user;
	const event = {
		url,
		params: options.slug === undefined ? {} : { slug: options.slug },
		locals: user === null ? { role: 'member' } : { user, role: user.role },
		request: new Request(url, {
			method,
			...(options.body === undefined
				? {}
				: { body: JSON.stringify(options.body), headers: { 'content-type': 'application/json' } })
		})
	};
	return Promise.resolve(handler(event as never));
}

/** A heading over a count of ready work: one tool binding. */
function readySpec(title = 'Ready now') {
	return {
		root: 'main',
		components: [
			{ id: 'main', component: 'Stack', children: ['title', 'ready_count'] },
			{ id: 'title', component: 'Heading', text: title },
			{ id: 'ready_count', component: 'StatTile', label: 'Ready', count: 'ready' }
		],
		data: { ready: { tool: 'ready_work', input: { limit: 20 } } }
	};
}

const READY = { slug: 'ready-board', name: 'Ready board', spec: readySpec() };

async function create(body: unknown = READY, user: User | null = OWNER) {
	return call(CREATE, 'POST', '/api/surfaces', { body, user });
}

async function json<T>(response: Response): Promise<T> {
	return (await response.json()) as T;
}

async function list(user: User | null): Promise<SurfaceSummary[]> {
	return (await json<SurfacesResponse>(await call(LIST, 'GET', '/api/surfaces', { user })))
		.surfaces;
}

function at(handler: Handler, method: string, suffix = '', body?: unknown, user?: User | null) {
	return call(handler, method, `/api/surfaces/ready-board${suffix}`, {
		slug: 'ready-board',
		...(body === undefined ? {} : { body }),
		...(user === undefined ? {} : { user })
	});
}

describe('/api/surfaces roles', () => {
	it('lets any signed-in role read, and needs an admin for every change', () => {
		for (const path of ['/api/surfaces', '/api/surfaces/x', '/api/surfaces/x/history']) {
			expect(requiredPermission('GET', path), path).toBeUndefined();
		}
		for (const [method, path] of [
			['POST', '/api/surfaces'],
			['PATCH', '/api/surfaces/x'],
			['DELETE', '/api/surfaces/x'],
			['POST', '/api/surfaces/x/revert'],
			['PUT', '/api/surfaces/x/publish'],
			['DELETE', '/api/surfaces/x/publish']
		] as const) {
			const permission = requiredPermission(method, path);
			expect(permission, `${method} ${path}`).toEqual({ console: ['manage'] });
			expect(roleCan('member', permission!)).toBe(false);
			expect(roleCan('admin', permission!)).toBe(true);
		}
	});

	it('refuses a member and a caller with no account even past the gate', async () => {
		expect((await create(READY, MEMBER)).status).toBe(403);
		expect((await create(READY, null)).status).toBe(403);
		expect(await list(OWNER)).toEqual([]);
	});
});

describe('/api/surfaces', () => {
	it('creates a private surface: its owner sees it, another admin and a member do not', async () => {
		const response = await create();
		expect(response.status).toBe(201);
		const { surface } = await json<SurfaceResponse>(response);
		expect(surface).toMatchObject({
			slug: 'ready-board',
			name: 'Ready board',
			revision: 1,
			author_kind: 'person',
			mine: true,
			published: false,
			unpublished_changes: false,
			spec: {
				root: 'main',
				actions: {},
				components: expect.arrayContaining([expect.objectContaining({ id: 'main', gap: 'md' })])
			}
		});
		expect((await list(OWNER)).map((s) => s.slug)).toEqual(['ready-board']);
		expect(await list(ADMIN2)).toEqual([]);
		expect(await list(MEMBER)).toEqual([]);
		expect((await at(GET_ONE, 'GET', '', undefined, MEMBER)).status).toBe(404);
		expect((await at(GET_ONE, 'GET', '', undefined, ADMIN2)).status).toBe(404);
	});

	it('refuses an unknown component, an unlisted tool, a bad tool input and extra keys', async () => {
		const unknown_component = {
			root: 'main',
			components: [{ id: 'main', component: 'Script', src: 'x.js' }]
		};
		const unlisted_tool = {
			...readySpec(),
			data: { ready: { tool: 'run_sql', input: { sql: 'DROP' } } }
		};
		const bad_input = {
			...readySpec(),
			data: { ready: { tool: 'ready_work', input: { limit: -1 } } }
		};
		for (const spec of [unknown_component, unlisted_tool, bad_input]) {
			expect((await create({ ...READY, spec })).status, JSON.stringify(spec)).toBe(400);
		}
		expect((await create({ ...READY, kind: 'view' })).status).toBe(400);
		expect((await create({ ...READY, owner: 'someone' })).status).toBe(400);
		expect((await create({ ...READY, slug: 'Not A Slug' })).status).toBe(400);
		expect(await list(OWNER)).toEqual([]);
		expect((await create()).status).toBe(201);
		expect((await create()).status).toBe(409);
	});
});

describe('surfaces and views stay apart', () => {
	it('never reads or changes a view through /api/surfaces, nor a surface through /api/views', async () => {
		const view = await call(VIEW_CREATE, 'POST', '/api/views', {
			body: { slug: 'blocked', name: 'Blocked', spec: { scope: 'all', filters: {} } }
		});
		expect(view.status).toBe(201);
		await create();

		// A view spec is not a surface, and a surface spec is not a view.
		expect(
			(await create({ slug: 'other', name: 'x', spec: { scope: 'all', filters: {} } })).status
		).toBe(400);
		expect(
			(await call(VIEW_CREATE, 'POST', '/api/views', { body: { ...READY, slug: 'other' } })).status
		).toBe(400);

		// Each list shows only its own kind.
		expect((await list(OWNER)).map((s) => s.slug)).toEqual(['ready-board']);
		const views = await json<{ views: { slug: string }[] }>(
			await call(VIEW_LIST, 'GET', '/api/views')
		);
		expect(views.views.map((v) => v.slug)).toEqual(['blocked']);

		// The other kind's slug is "not found", for reads and for every write.
		const on_view = { slug: 'blocked' };
		expect((await call(GET_ONE, 'GET', '/api/surfaces/blocked', on_view)).status).toBe(404);
		expect(
			(await call(PATCH, 'PATCH', '/api/surfaces/blocked', { ...on_view, body: { name: 'x' } }))
				.status
		).toBe(404);
		expect((await call(HISTORY, 'GET', '/api/surfaces/blocked/history', on_view)).status).toBe(404);
		expect(
			(
				await call(REVERT, 'POST', '/api/surfaces/blocked/revert', {
					...on_view,
					body: { number: 1 }
				})
			).status
		).toBe(404);
		expect(
			(await call(PUBLISH, 'PUT', '/api/surfaces/blocked/publish', { ...on_view, body: {} })).status
		).toBe(404);
		expect((await call(UNPUBLISH, 'DELETE', '/api/surfaces/blocked/publish', on_view)).status).toBe(
			404
		);
		expect((await call(DELETE, 'DELETE', '/api/surfaces/blocked', on_view)).status).toBe(404);

		const on_surface = { slug: 'ready-board' };
		expect((await call(VIEW_GET, 'GET', '/api/views/ready-board', on_surface)).status).toBe(404);
		expect(
			(
				await call(VIEW_PATCH, 'PATCH', '/api/views/ready-board', {
					...on_surface,
					body: { name: 'x' }
				})
			).status
		).toBe(404);

		// Both are untouched.
		expect((await store.read({ account_id: OWNER.id, role: 'admin' }, 'blocked'))?.kind).toBe(
			'view'
		);
		expect((await list(OWNER))[0]).toMatchObject({ revision: 1, name: 'Ready board' });
	});
});

describe('/api/surfaces/:slug revisions', () => {
	it('revises, lists history newest first, and reverts by copying forward', async () => {
		await create();
		const revised = await at(PATCH, 'PATCH', '', {
			name: 'Ready, renamed',
			spec: readySpec('Ready to pick up')
		});
		expect(revised.status).toBe(200);
		expect((await json<SurfaceResponse>(revised)).surface).toMatchObject({
			revision: 2,
			name: 'Ready, renamed'
		});

		const reverted = await at(REVERT, 'POST', '/revert', { number: 1 });
		const { surface } = await json<SurfaceResponse>(reverted);
		expect(surface).toMatchObject({ revision: 3, name: 'Ready board' });
		expect(surface.spec.components[1]).toMatchObject({ text: 'Ready now' });

		const history = await json<SurfaceHistoryResponse>(await at(HISTORY, 'GET', '/history'));
		expect(history.revisions.map((r) => [r.number, r.reverted_from])).toEqual([
			[3, 1],
			[2, undefined],
			[1, undefined]
		]);
	});

	it('refuses an empty or invalid revision, a missing revision and another admin', async () => {
		await create();
		expect((await at(PATCH, 'PATCH', '', {})).status).toBe(400);
		expect((await at(PATCH, 'PATCH', '', { spec: { root: 'gone', components: [] } })).status).toBe(
			400
		);
		expect((await at(REVERT, 'POST', '/revert', { number: 9 })).status).toBe(404);
		expect((await at(PATCH, 'PATCH', '', { name: 'Mine now' }, ADMIN2)).status).toBe(404);
		expect((await at(HISTORY, 'GET', '/history', undefined, ADMIN2)).status).toBe(404);
		expect((await list(OWNER))[0]).toMatchObject({ revision: 1 });
	});

	it('deletes a surface with its history; only the owner can', async () => {
		await create();
		await at(PUBLISH, 'PUT', '/publish', {});
		expect((await at(DELETE, 'DELETE', '', undefined, ADMIN2)).status).toBe(403);
		expect((await at(DELETE, 'DELETE', '', undefined, MEMBER)).status).toBe(403);
		expect((await at(DELETE, 'DELETE')).status).toBe(204);
		expect(await list(OWNER)).toEqual([]);
		expect(await list(MEMBER)).toEqual([]);
	});
});

describe('/api/surfaces/:slug/publish', () => {
	it('shows members the published revision only, never a newer one', async () => {
		await create();
		const published = await at(PUBLISH, 'PUT', '/publish', {});
		expect((await json<SurfaceResponse>(published)).surface).toMatchObject({
			published: true,
			unpublished_changes: false
		});
		await at(PATCH, 'PATCH', '', { name: 'Changed later' });

		const [as_member] = await list(MEMBER);
		expect(as_member).toMatchObject({ name: 'Ready board', revision: 1, mine: false });
		expect(as_member).not.toHaveProperty('unpublished_changes');
		const [as_owner] = await list(OWNER);
		expect(as_owner).toMatchObject({
			name: 'Changed later',
			revision: 2,
			unpublished_changes: true
		});

		// A member reads it, but has no history, revision, revert or publish.
		expect((await at(GET_ONE, 'GET', '', undefined, MEMBER)).status).toBe(200);
		expect((await at(HISTORY, 'GET', '/history', undefined, MEMBER)).status).toBe(403);
		expect((await at(PATCH, 'PATCH', '', { name: 'x' }, MEMBER)).status).toBe(403);
		expect((await at(REVERT, 'POST', '/revert', { number: 1 }, MEMBER)).status).toBe(403);
		expect((await at(PUBLISH, 'PUT', '/publish', {}, MEMBER)).status).toBe(403);
	});

	it('publishes only for the owner, and lets any admin unpublish', async () => {
		await create();
		await at(PUBLISH, 'PUT', '/publish', {});
		expect((await at(PUBLISH, 'PUT', '/publish', { number: 1 }, ADMIN2)).status).toBe(403);
		expect((await at(UNPUBLISH, 'DELETE', '/publish', undefined, MEMBER)).status).toBe(403);

		const hidden = await at(UNPUBLISH, 'DELETE', '/publish', undefined, ADMIN2);
		expect(hidden.status).toBe(200);
		expect((await json<{ surface: SurfaceSummary | null }>(hidden)).surface).toBeNull();
		expect(await list(MEMBER)).toEqual([]);
		expect((await list(OWNER))[0]).toMatchObject({ published: false });
	});
});

describe('/api/surfaces/:slug/data', () => {
	/** An admin's dashboard counting the todo list, which only admins may read. */
	const TODOS = {
		slug: 'todo-board',
		name: 'Todo board',
		spec: {
			root: 'main',
			components: [
				{ id: 'main', component: 'Stack', children: ['open'] },
				{ id: 'open', component: 'StatTile', label: 'Open todos', count: 'todos' }
			],
			data: { todos: { tool: 'list_todos', input: {} } }
		}
	};

	function data(user: User | null, query = '', slug = 'todo-board') {
		return call(DATA, 'GET', `/api/surfaces/${slug}/data${query}`, { slug, user });
	}

	it('is a read any signed-in role may make', () => {
		expect(requiredPermission('GET', '/api/surfaces/x/data')).toBeUndefined();
	});

	it("reads an admin's published surface as a member: the list_todos binding is refused", async () => {
		expect((await create(TODOS)).status).toBe(201);
		expect((await data(MEMBER)).status).toBe(404); // not published yet
		expect(
			(
				await call(PUBLISH, 'PUT', '/api/surfaces/todo-board/publish', {
					slug: 'todo-board',
					body: {}
				})
			).status
		).toBe(200);

		const as_member = await data(MEMBER);
		expect(as_member.status).toBe(200);
		expect(await json<SurfaceDataResponse>(as_member)).toEqual({
			slug: 'todo-board',
			revision: 1,
			bindings: {
				todos: {
					ok: false,
					code: 'forbidden',
					message: 'list_todos needs an admin account; this surface reads as you.'
				}
			}
		});

		const as_owner = await json<SurfaceDataResponse>(await data(OWNER));
		expect(as_owner.bindings.todos).toMatchObject({ ok: true, yields: 'todos' });
	});

	it('refuses an unknown binding and a surface the viewer cannot see', async () => {
		await create(TODOS);
		expect((await data(OWNER, '?binding=nope')).status).toBe(400);
		expect((await data(ADMIN2)).status).toBe(404);
		expect((await data(OWNER, '', 'missing')).status).toBe(404);
	});

	it('allows 60 binding reads a minute per viewer and surface, then 429 with Retry-After', async () => {
		await create({ ...TODOS, slug: 'rate-board' });
		for (let index = 0; index < 60; index += 1) {
			expect((await data(OWNER, '', 'rate-board')).status).toBe(200);
		}
		const refused = await data(OWNER, '', 'rate-board');
		expect(refused.status).toBe(429);
		expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
		// Another viewer's budget is their own (this one cannot see it: 404, not 429).
		expect((await data(ADMIN2, '', 'rate-board')).status).toBe(404);
	});
});
