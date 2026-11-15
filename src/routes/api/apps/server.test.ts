import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requiredPermission, roleCan } from '#lib/server/auth/roles.js';
import { createGrownStore } from '#lib/server/grown/store.js';
import { APP_FRAME_CSP } from '#lib/server/grown/app-spec.js';
import { initStateSchema, setGrownStore, setTodoStore } from '#lib/server/state/db.js';
import { createTodoStore, type TodoStore } from '#lib/server/todos/store.js';
import type {
	AppHistoryResponse,
	AppResponse,
	AppsResponse,
	AppActionResponse,
	AppSummary,
	AppToolCallResponse
} from '#lib/apps.js';
import { GET as LIST, POST as CREATE } from './+server.js';
import { DELETE, GET as GET_ONE, PATCH } from './[slug]/+server.js';
import { GET as HISTORY } from './[slug]/history/+server.js';
import { DELETE as UNPUBLISH, PUT as PUBLISH } from './[slug]/publish/+server.js';
import { POST as REVERT } from './[slug]/revert/+server.js';
import { GET as FRAME } from './[slug]/frame/+server.js';
import { POST as CALL } from './[slug]/call/+server.js';
import { POST as ACTION } from './[slug]/actions/+server.js';
import { GET as SURFACE_GET } from '../surfaces/[slug]/+server.js';
import { POST as VIEW_CREATE } from '../views/+server.js';

type User = { id: string; email: string; name: string; role: 'admin' | 'member' };
const OWNER: User = { id: 'acct_owner', email: 'owner@example.test', name: 'Owner', role: 'admin' };
const ADMIN2: User = { id: 'acct_admin2', email: 'a2@example.test', name: 'Other', role: 'admin' };
const MEMBER: User = { id: 'acct_member', email: 'm@example.test', name: 'Member', role: 'member' };

let todos: TodoStore;

beforeEach(async () => {
	const client = createClient({ url: ':memory:' });
	await initStateSchema(client);
	setGrownStore(createGrownStore(client));
	todos = createTodoStore(client);
	setTodoStore(todos);
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

const DOC_1 = '<h1>Burndown</h1><script>document.title = "one"</script>';
const DOC_2 = '<h1>Burndown v2</h1>';
const BURNDOWN = { slug: 'burndown', name: 'Burndown', spec: { html: DOC_1 } };

function create(body: unknown = BURNDOWN, user: User | null = OWNER) {
	return call(CREATE, 'POST', '/api/apps', { body, user });
}

async function json<T>(response: Response): Promise<T> {
	return (await response.json()) as T;
}

async function list(user: User | null): Promise<AppSummary[]> {
	return (await json<AppsResponse>(await call(LIST, 'GET', '/api/apps', { user }))).apps;
}

function at(handler: Handler, method: string, suffix = '', body?: unknown, user?: User | null) {
	return call(handler, method, `/api/apps/burndown${suffix}`, {
		slug: 'burndown',
		...(body === undefined ? {} : { body }),
		...(user === undefined ? {} : { user })
	});
}

function frame(user: User | null = OWNER, query = '') {
	return at(FRAME, 'GET', `/frame${query}`, undefined, user);
}

describe('/api/apps roles', () => {
	it('lets any signed-in role read, and needs an admin for every change', () => {
		for (const path of ['/api/apps', '/api/apps/x', '/api/apps/x/history', '/api/apps/x/frame']) {
			expect(requiredPermission('GET', path), path).toBeUndefined();
		}
		for (const [method, path] of [
			['POST', '/api/apps'],
			['PATCH', '/api/apps/x'],
			['DELETE', '/api/apps/x'],
			['POST', '/api/apps/x/revert'],
			['PUT', '/api/apps/x/publish'],
			['DELETE', '/api/apps/x/publish']
		] as const) {
			const permission = requiredPermission(method, path);
			expect(permission, `${method} ${path}`).toEqual({ console: ['manage'] });
			expect(roleCan('member', permission!)).toBe(false);
			expect(roleCan('admin', permission!)).toBe(true);
		}
	});

	it('refuses a member and a caller with no account even past the gate', async () => {
		expect((await create(BURNDOWN, MEMBER)).status).toBe(403);
		expect((await create(BURNDOWN, null)).status).toBe(403);
		expect(await list(OWNER)).toEqual([]);
	});

	it('lets only the owner change, see the history of, revert or delete an app', async () => {
		await create();
		await at(PUBLISH, 'PUT', '/publish', {});
		for (const user of [ADMIN2, MEMBER]) {
			expect((await at(PATCH, 'PATCH', '', { spec: { html: 'x' } }, user)).status).not.toBe(200);
			expect((await at(HISTORY, 'GET', '/history', undefined, user)).status).toBe(403);
			expect((await at(REVERT, 'POST', '/revert', { number: 1 }, user)).status).not.toBe(200);
			expect((await at(DELETE, 'DELETE', '', undefined, user)).status).not.toBe(204);
		}
		// A member cannot publish or unpublish even an app they can see.
		expect((await at(PUBLISH, 'PUT', '/publish', {}, MEMBER)).status).toBe(403);
		expect((await at(UNPUBLISH, 'DELETE', '/publish', undefined, MEMBER)).status).toBe(403);
		expect((await frame(MEMBER)).status).toBe(200);
	});
});

describe('/api/apps', () => {
	it('creates a private app with the design tokens by default', async () => {
		const response = await create();
		expect(response.status).toBe(201);
		const { app } = await json<AppResponse>(response);
		expect(app).toMatchObject({
			slug: 'burndown',
			revision: 1,
			mine: true,
			published: false,
			spec: { html: DOC_1, libraries: ['beadsmith-tokens'] }
		});
		expect((await list(OWNER)).map((a) => a.slug)).toEqual(['burndown']);
		expect(await list(ADMIN2)).toEqual([]);
		expect(await list(MEMBER)).toEqual([]);
		expect((await at(GET_ONE, 'GET', '', undefined, MEMBER)).status).toBe(404);
	});

	it('refuses an unknown library, extra keys, an empty or oversized document', async () => {
		for (const spec of [
			{ html: DOC_1, libraries: ['https://cdn.example/x.js'] },
			{ html: DOC_1, src: 'x.js' },
			{ html: '' },
			{ html: 'a'.repeat(256 * 1024 + 1) }
		]) {
			expect((await create({ ...BURNDOWN, spec })).status).toBe(400);
		}
		expect(await list(OWNER)).toEqual([]);
		expect((await create()).status).toBe(201);
		expect((await create()).status).toBe(409);
	});

	it('revises, keeps the history, reverts forward and deletes', async () => {
		await create();
		const revised = await at(PATCH, 'PATCH', '', { spec: { html: DOC_2 } });
		expect((await json<AppResponse>(revised)).app.revision).toBe(2);
		expect(await (await frame()).text()).toContain(DOC_2);

		const reverted = await json<AppResponse>(await at(REVERT, 'POST', '/revert', { number: 1 }));
		expect(reverted.app).toMatchObject({ revision: 3, spec: { html: DOC_1 } });
		const { revisions } = await json<AppHistoryResponse>(await at(HISTORY, 'GET', '/history'));
		expect(revisions.map((r) => [r.number, r.reverted_from ?? null])).toEqual([
			[3, 1],
			[2, null],
			[1, null]
		]);
		expect(await (await frame()).text()).toContain(DOC_1);

		expect((await at(DELETE, 'DELETE')).status).toBe(204);
		expect((await frame()).status).toBe(404);
	});
});

describe('/api/apps/:slug/frame', () => {
	it("serves the app's document with its own CSP, never cached", async () => {
		await create();
		const response = await frame();
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
		expect(response.headers.get('content-security-policy')).toBe(APP_FRAME_CSP);
		expect(response.headers.get('cache-control')).toBe('no-store');
		const text = await response.text();
		expect(text).toContain('<style data-library="beadsmith-tokens">');
		expect(text.endsWith(DOC_1)).toBe(true);
		expect(text).toContain('<html lang="en">');
		expect(await (await frame(OWNER, '?theme=dark')).text()).toContain(
			'<html lang="en" class="dark">'
		);
		expect(await (await frame(OWNER, '?theme=<x>')).text()).toContain('<html lang="en">');
	});

	it('shows a member only the published revision, and nothing once unpublished', async () => {
		await create();
		expect((await frame(MEMBER)).status).toBe(404);
		expect((await frame(ADMIN2)).status).toBe(404);
		expect((await frame(null)).status).toBe(404);

		await at(PUBLISH, 'PUT', '/publish', {});
		await at(PATCH, 'PATCH', '', { spec: { html: DOC_2 } });
		// The owner sees the new revision; a member still sees the published one.
		expect(await (await frame(OWNER)).text()).toContain(DOC_2);
		const member = await (await frame(MEMBER)).text();
		expect(member).toContain(DOC_1);
		expect(member).not.toContain(DOC_2);

		// Any admin may unpublish what members see; then only the owner can load it.
		expect((await at(UNPUBLISH, 'DELETE', '/publish', undefined, ADMIN2)).status).toBe(200);
		expect((await frame(MEMBER)).status).toBe(404);
		expect((await frame(OWNER)).status).toBe(200);
	});
});

describe('apps and other kinds stay apart', () => {
	it('never serves a view or surface as an app, nor an app as a surface', async () => {
		const view = await call(VIEW_CREATE, 'POST', '/api/views', {
			body: { slug: 'burndown', name: 'Blocked', spec: { scope: 'all', filters: {} } }
		});
		expect(view.status).toBe(201);
		expect((await frame()).status).toBe(404);
		expect((await create()).status).toBe(409); // slugs are unique across kinds

		await create({ ...BURNDOWN, slug: 'other' });
		const surface = await call(SURFACE_GET, 'GET', '/api/surfaces/other', { slug: 'other' });
		expect(surface.status).toBe(404);
	});
});

describe('/api/apps/:slug/call', () => {
	function tool(name: string, args: unknown = {}, user: User | null = OWNER, slug = 'burndown') {
		return call(CALL, 'POST', `/api/apps/${slug}/call`, {
			slug,
			user,
			body: { name, arguments: args }
		});
	}

	async function publish() {
		expect((await at(PUBLISH, 'PUT', '/publish', {})).status).toBe(200);
	}

	it('is a read any signed-in role may make, and only that path is', () => {
		expect(requiredPermission('POST', '/api/apps/x/call')).toBeUndefined();
		for (const path of ['/api/apps/x/call/more', '/api/apps/x/callx', '/api/apps/call']) {
			expect(requiredPermission('POST', path), path).toEqual({ console: ['manage'] });
		}
	});

	it("answers as the viewer: a member reading an admin's app is refused list_todos", async () => {
		await create();
		expect((await tool('list_todos', {}, MEMBER)).status).toBe(404); // not published yet
		await publish();

		const as_member = await tool('list_todos', {}, MEMBER);
		expect(as_member.status).toBe(200);
		expect(await json<AppToolCallResponse>(as_member)).toEqual({
			slug: 'burndown',
			revision: 1,
			name: 'list_todos',
			result: {
				ok: false,
				code: 'forbidden',
				message: 'list_todos needs an admin account; this app reads as you.'
			}
		});

		const as_owner = await json<AppToolCallResponse>(await tool('list_todos'));
		expect(as_owner.result).toMatchObject({ ok: true, yields: 'todos' });
	});

	it('refuses anything but an allowlisted read, before it runs', async () => {
		await create();
		for (const name of ['create_todo', 'tackle_issue', 'define_app', 'remember', 'run_sql']) {
			const refused = await tool(name);
			expect(refused.status, name).toBe(400);
		}
	});

	it('refuses bad arguments with the tool’s own reasons, and a read missing its project', async () => {
		await create();
		const bad = await json<AppToolCallResponse>(await tool('list_todos', { status: 'nope' }));
		expect(bad.result).toMatchObject({ ok: false, code: 'bad_request' });
		const no_project = await json<AppToolCallResponse>(await tool('show_issue', { id: 'x-1' }));
		expect(no_project.result).toMatchObject({
			ok: false,
			code: 'bad_request',
			message: 'show_issue needs a project: an app has no chat project to default to.'
		});
	});

	it('refuses a malformed, oversized or extra-key body', async () => {
		await create();
		const huge = await tool('list_todos', { pad: 'x'.repeat(70 * 1024) });
		expect(huge.status).toBe(400);
		const extra = await call(CALL, 'POST', '/api/apps/burndown/call', {
			slug: 'burndown',
			body: { name: 'list_todos', arguments: {}, as: 'admin' }
		});
		expect(extra.status).toBe(400);
		const not_object = await call(CALL, 'POST', '/api/apps/burndown/call', {
			slug: 'burndown',
			body: { name: 'list_todos', arguments: [1] }
		});
		expect(not_object.status).toBe(400);
	});

	it('refuses an app the viewer cannot see, and a surface or view under the slug', async () => {
		await create();
		expect((await tool('list_todos', {}, ADMIN2)).status).toBe(404);
		expect((await tool('list_todos', {}, OWNER, 'missing')).status).toBe(404);
		await call(VIEW_CREATE, 'POST', '/api/views', {
			body: { slug: 'a-view', name: 'A view', spec: { scope: 'all', filters: {} } }
		});
		expect((await tool('list_todos', {}, OWNER, 'a-view')).status).toBe(404);
	});

	it('allows 60 calls a minute per viewer and app, then 429 with Retry-After', async () => {
		await create({ ...BURNDOWN, slug: 'rate-app' });
		for (let index = 0; index < 60; index += 1) {
			expect((await tool('list_todos', {}, OWNER, 'rate-app')).status).toBe(200);
		}
		const refused = await tool('list_todos', {}, OWNER, 'rate-app');
		expect(refused.status).toBe(429);
		expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
	});
});

describe('/api/apps/:slug/actions', () => {
	const KEY = '00000000-0000-4000-8000-000000000001';
	const ADD = { name: 'create_todo', arguments: { title: 'Follow up' }, revision: 1, key: KEY };

	function act(user: User | null, body: unknown = ADD, slug = 'burndown') {
		return call(ACTION, 'POST', `/api/apps/${slug}/actions`, { slug, user, body });
	}

	async function publish() {
		expect((await at(PUBLISH, 'PUT', '/publish', {})).status).toBe(200);
	}

	it('needs an admin at the gate; only the read route is open to members', () => {
		const permission = requiredPermission('POST', '/api/apps/x/actions');
		expect(permission).toEqual({ console: ['manage'] });
		expect(roleCan('member', permission!)).toBe(false);
		expect(roleCan('admin', permission!)).toBe(true);
	});

	it('runs the confirmed call as the viewer', async () => {
		await create();
		const response = await act(OWNER);
		expect(response.status).toBe(200);
		expect(await json<AppActionResponse>(response)).toMatchObject({
			slug: 'burndown',
			revision: 1,
			name: 'create_todo',
			result: { todo: { title: 'Follow up' } }
		});
		const [todo] = await todos.list({ limit: 10 });
		expect(todo.created_by).toBe(OWNER.id);
	});

	it("runs an admin's published app as the admin who confirmed it", async () => {
		await create();
		expect((await act(ADMIN2)).status).toBe(404); // owner-private until published
		await publish();
		expect((await act(ADMIN2, { ...ADD, key: 'second-key-0001' })).status).toBe(200);
		const [todo] = await todos.list({ limit: 10 });
		expect(todo.created_by).toBe(ADMIN2.id);
	});

	it('refuses a member past the gate, and a caller with no account', async () => {
		await create();
		await publish();
		const member = await act(MEMBER);
		expect(member.status).toBe(403);
		expect(await member.text()).toContain('needs an admin account; this app acts as you');
		expect((await act(null)).status).toBe(403);
		expect(await todos.list({ limit: 10 })).toHaveLength(0);
	});

	it('refuses a stale revision, a read or unknown tool, bad arguments and a malformed body', async () => {
		await create();
		expect((await act(OWNER, { ...ADD, revision: 2 })).status).toBe(409);
		for (const name of ['list_todos', 'define_app', 'run_sql']) {
			expect((await act(OWNER, { ...ADD, name })).status, name).toBe(400);
		}
		const bad = await act(OWNER, { ...ADD, arguments: { title: 'x', as: 'admin' } });
		expect(bad.status).toBe(400);
		expect(await bad.text()).toContain('The arguments for create_todo are not valid');
		const no_project = await act(OWNER, {
			...ADD,
			name: 'tackle_issue',
			arguments: { issue_id: 'alpha-1' }
		});
		expect(no_project.status).toBe(400);
		expect(await no_project.text()).toContain('an app has no chat project');
		expect((await act(OWNER, { ...ADD, key: 'short' })).status).toBe(400);
		expect((await act(OWNER, { name: 'create_todo', revision: 1 })).status).toBe(400);
		expect((await act(OWNER, { ...ADD, arguments: { title: 'x'.repeat(70 * 1024) } })).status).toBe(
			400
		);
		expect(await todos.list({ limit: 10 })).toHaveLength(0);
	});

	it('never runs a surface or view action under the slug', async () => {
		await call(VIEW_CREATE, 'POST', '/api/views', {
			body: { slug: 'a-view', name: 'A view', spec: { scope: 'all', filters: {} } }
		});
		expect((await act(OWNER, ADD, 'a-view')).status).toBe(404);
	});
});
