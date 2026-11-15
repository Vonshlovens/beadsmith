import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requiredPermission, roleCan } from '#lib/server/auth/roles.js';
import { createGrownStore, type GrownStore } from '#lib/server/grown/store.js';
import { initStateSchema, setGrownStore } from '#lib/server/state/db.js';
import type { IssueSummary, Project } from '#lib/types.js';
import type {
	ViewHistoryResponse,
	ViewResponse,
	ViewRunResponse,
	ViewsResponse,
	ViewSummary
} from '#lib/views.js';
import { GET as LIST, POST as CREATE } from './+server.js';
import { DELETE, GET as GET_ONE, PATCH } from './[slug]/+server.js';
import { GET as HISTORY } from './[slug]/history/+server.js';
import { DELETE as UNPUBLISH, PUT as PUBLISH } from './[slug]/publish/+server.js';
import { POST as REVERT } from './[slug]/revert/+server.js';
import { GET as RUN } from './[slug]/run/+server.js';

const PROJECT = { id: 'd_beads_web', name: 'Beads web', dolt_database: 'beads_web' } as Project;

const mocks = vi.hoisted(() => ({
	filters: [] as unknown[]
}));

vi.mock('#lib/server/discovery.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/discovery.js')>()),
	discoverProjects: async () => [PROJECT],
	resolveProject: async (id: string) => (id === 'd_beads_web' ? PROJECT : undefined)
}));
vi.mock('#lib/server/read-model.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/read-model.js')>()),
	listProjectIssues: async (_project: Project, filters: unknown) => {
		mocks.filters.push(filters);
		return {
			issues: [
				{
					id: 'bw-1',
					title: 'Blocked on review',
					status: 'blocked',
					priority: 1,
					issue_type: 'task',
					created_at: '2026-11-01T00:00:00Z',
					updated_at: '2026-11-02T00:00:00Z'
				} as IssueSummary
			]
		};
	}
}));

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
	mocks.filters = [];
});

afterEach(() => setGrownStore(undefined));

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

const BLOCKED = {
	slug: 'blocked',
	name: 'Blocked work',
	spec: { scope: { project: 'd_beads_web' }, filters: { status: ['blocked'] } }
};

async function create(body: unknown = BLOCKED, user: User | null = OWNER) {
	return call(CREATE, 'POST', '/api/views', { body, user });
}

async function json<T>(response: Response): Promise<T> {
	return (await response.json()) as T;
}

async function list(user: User | null): Promise<ViewSummary[]> {
	return (await json<ViewsResponse>(await call(LIST, 'GET', '/api/views', { user }))).views;
}

describe('/api/views roles', () => {
	it('lets any signed-in role read, and needs an admin for every change', () => {
		for (const path of ['/api/views', '/api/views/x', '/api/views/x/run', '/api/views/x/history']) {
			expect(requiredPermission('GET', path), path).toBeUndefined();
		}
		for (const [method, path] of [
			['POST', '/api/views'],
			['PATCH', '/api/views/x'],
			['DELETE', '/api/views/x'],
			['POST', '/api/views/x/revert'],
			['PUT', '/api/views/x/publish'],
			['DELETE', '/api/views/x/publish']
		] as const) {
			const permission = requiredPermission(method, path);
			expect(permission, `${method} ${path}`).toEqual({ console: ['manage'] });
			expect(roleCan('member', permission!)).toBe(false);
			expect(roleCan('admin', permission!)).toBe(true);
		}
	});

	it('refuses a member and a caller with no account even past the gate', async () => {
		expect((await create(BLOCKED, MEMBER)).status).toBe(403);
		expect((await create(BLOCKED, null)).status).toBe(403);
		expect(await list(OWNER)).toEqual([]);
	});
});

describe('/api/views', () => {
	it('creates a private view: its owner sees it, another admin and a member do not', async () => {
		const response = await create();
		expect(response.status).toBe(201);
		const { view } = await json<ViewResponse>(response);
		expect(view).toMatchObject({
			slug: 'blocked',
			name: 'Blocked work',
			revision: 1,
			author_kind: 'person',
			mine: true,
			published: false,
			unpublished_changes: false,
			spec: { sort: 'updated', presentation: 'list', filters: { status: ['blocked'] } }
		});
		expect((await list(OWNER)).map((v) => v.slug)).toEqual(['blocked']);
		expect(await list(ADMIN2)).toEqual([]);
		expect(await list(MEMBER)).toEqual([]);
		expect(
			(await call(GET_ONE, 'GET', '/api/views/blocked', { slug: 'blocked', user: MEMBER })).status
		).toBe(404);
	});

	it('refuses an invalid spec, extra keys, a bad slug and a taken one', async () => {
		expect((await create({ ...BLOCKED, spec: { scope: 'all', sql: 'DROP' } })).status).toBe(400);
		expect((await create({ ...BLOCKED, owner: 'someone' })).status).toBe(400);
		expect((await create({ ...BLOCKED, slug: 'Not A Slug' })).status).toBe(400);
		expect((await create()).status).toBe(201);
		expect((await create()).status).toBe(409);
	});

	it('runs a view as the viewer through the project read path', async () => {
		await create();
		const response = await call(RUN, 'GET', '/api/views/blocked/run', { slug: 'blocked' });
		expect(response.status).toBe(200);
		const { view, result } = await json<ViewRunResponse>(response);
		expect(view.slug).toBe('blocked');
		expect(result.issues).toEqual([
			expect.objectContaining({ id: 'bw-1', project_id: 'd_beads_web', project_name: 'Beads web' })
		]);
		expect(mocks.filters).toEqual([expect.objectContaining({ status: 'blocked' })]);
		// A member cannot run a view they cannot see.
		expect(
			(await call(RUN, 'GET', '/api/views/blocked/run', { slug: 'blocked', user: MEMBER })).status
		).toBe(404);
	});
});

describe('/api/views/:slug revisions', () => {
	it('revises, lists history newest first, and reverts by copying forward', async () => {
		await create();
		const revised = await call(PATCH, 'PATCH', '/api/views/blocked', {
			slug: 'blocked',
			body: { name: 'Blocked, as a board', spec: { ...BLOCKED.spec, presentation: 'board' } }
		});
		expect((await json<ViewResponse>(revised)).view).toMatchObject({
			revision: 2,
			name: 'Blocked, as a board',
			spec: { presentation: 'board' }
		});

		const reverted = await call(REVERT, 'POST', '/api/views/blocked/revert', {
			slug: 'blocked',
			body: { number: 1 }
		});
		expect((await json<ViewResponse>(reverted)).view).toMatchObject({
			revision: 3,
			name: 'Blocked work',
			spec: { presentation: 'list' }
		});

		const history = await json<ViewHistoryResponse>(
			await call(HISTORY, 'GET', '/api/views/blocked/history', { slug: 'blocked' })
		);
		expect(history.revisions.map((r) => [r.number, r.reverted_from])).toEqual([
			[3, 1],
			[2, undefined],
			[1, undefined]
		]);
	});

	it('refuses an empty revision, a missing revision and another admin', async () => {
		await create();
		expect(
			(await call(PATCH, 'PATCH', '/api/views/blocked', { slug: 'blocked', body: {} })).status
		).toBe(400);
		expect(
			(
				await call(REVERT, 'POST', '/api/views/blocked/revert', {
					slug: 'blocked',
					body: { number: 9 }
				})
			).status
		).toBe(404);
		expect(
			(
				await call(PATCH, 'PATCH', '/api/views/blocked', {
					slug: 'blocked',
					body: { name: 'Mine now' },
					user: ADMIN2
				})
			).status
		).toBe(404);
	});

	it('deletes a view with its history; only the owner can', async () => {
		await create();
		await call(PUBLISH, 'PUT', '/api/views/blocked/publish', { slug: 'blocked', body: {} });
		expect(
			(await call(DELETE, 'DELETE', '/api/views/blocked', { slug: 'blocked', user: ADMIN2 })).status
		).toBe(403);
		expect((await call(DELETE, 'DELETE', '/api/views/blocked', { slug: 'blocked' })).status).toBe(
			204
		);
		expect(await list(OWNER)).toEqual([]);
	});
});

describe('/api/views/:slug/publish', () => {
	it('shows members the published revision only, never a newer one', async () => {
		await create();
		const published = await call(PUBLISH, 'PUT', '/api/views/blocked/publish', {
			slug: 'blocked',
			body: {}
		});
		expect((await json<ViewResponse>(published)).view).toMatchObject({
			published: true,
			unpublished_changes: false
		});
		await call(PATCH, 'PATCH', '/api/views/blocked', {
			slug: 'blocked',
			body: { name: 'Changed later' }
		});

		const [as_member] = await list(MEMBER);
		expect(as_member).toMatchObject({ name: 'Blocked work', revision: 1, mine: false });
		expect(as_member).not.toHaveProperty('unpublished_changes');
		const [as_owner] = await list(OWNER);
		expect(as_owner).toMatchObject({
			name: 'Changed later',
			revision: 2,
			unpublished_changes: true
		});

		// A member reads and runs it, but has no history, revert or publish.
		expect(
			(await call(RUN, 'GET', '/api/views/blocked/run', { slug: 'blocked', user: MEMBER })).status
		).toBe(200);
		expect(
			(await call(HISTORY, 'GET', '/api/views/blocked/history', { slug: 'blocked', user: MEMBER }))
				.status
		).toBe(403);
		expect(
			(
				await call(PUBLISH, 'PUT', '/api/views/blocked/publish', {
					slug: 'blocked',
					body: {},
					user: MEMBER
				})
			).status
		).toBe(403);
	});

	it('publishes only for the owner, and lets any admin unpublish', async () => {
		await create();
		await call(PUBLISH, 'PUT', '/api/views/blocked/publish', { slug: 'blocked', body: {} });
		expect(
			(
				await call(PUBLISH, 'PUT', '/api/views/blocked/publish', {
					slug: 'blocked',
					body: { number: 1 },
					user: ADMIN2
				})
			).status
		).toBe(403);
		expect(
			(
				await call(UNPUBLISH, 'DELETE', '/api/views/blocked/publish', {
					slug: 'blocked',
					user: MEMBER
				})
			).status
		).toBe(403);

		const hidden = await call(UNPUBLISH, 'DELETE', '/api/views/blocked/publish', {
			slug: 'blocked',
			user: ADMIN2
		});
		expect(hidden.status).toBe(200);
		expect((await json<{ view: ViewSummary | null }>(hidden)).view).toBeNull();
		expect(await list(MEMBER)).toEqual([]);
		expect((await list(OWNER))[0]).toMatchObject({ published: false });
	});
});
