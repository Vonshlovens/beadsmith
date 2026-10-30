import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requiredPermission, roleCan } from '$lib/server/auth/roles.js';
import { DispatchError } from '$lib/server/dispatch/types.js';
import { initStateSchema, setTodoStore } from '$lib/server/state/db.js';
import { createTodoStore, type TodoStore } from '$lib/server/todos/store.js';
import type { Project } from '$lib/types.js';
import { GET, POST } from './+server.js';

const mocks = vi.hoisted(() => ({
	resolveProject: vi.fn<(id: string) => Promise<Project | undefined>>(),
	enqueueDispatch: vi.fn(),
	getDispatch: vi.fn()
}));

vi.mock('$lib/server/discovery.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/discovery.js')>()),
	resolveProject: mocks.resolveProject
}));
vi.mock('$lib/server/dispatch/service.js', () => ({
	enqueueDispatch: mocks.enqueueDispatch,
	getDispatch: mocks.getDispatch
}));

const PROJECT: Project = {
	id: 'd_beads_web',
	name: 'beads_web',
	state: 'remote',
	dolt_database: 'beads_web',
	backend: 'server-sql',
	readonly: true
};
const USER = { id: 'u1', email: 'admin@example.com', name: 'Admin', role: 'admin' };
const REQUEST = {
	id: 'dq_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	project_id: PROJECT.id,
	operation: 'file',
	status: 'launched',
	created_at: '2026-10-28T00:00:00.000Z',
	updated_at: '2026-10-28T00:00:00.000Z'
};

let store: TodoStore;

beforeEach(async () => {
	const client = createClient({ url: ':memory:' });
	await initStateSchema(client);
	store = createTodoStore(client);
	setTodoStore(store);
	mocks.resolveProject.mockReset().mockResolvedValue(PROJECT);
	mocks.enqueueDispatch.mockReset();
	mocks.getDispatch.mockReset();
});

afterEach(() => setTodoStore(undefined));

function post(id: string, body: unknown) {
	return POST({
		params: { id },
		locals: { user: USER },
		request: new Request('http://localhost/', { method: 'POST', body: JSON.stringify(body) })
	} as never) as Promise<Response>;
}

describe('POST /api/todos/:id/route', () => {
	it('is admin-only', () => {
		for (const method of ['GET', 'POST']) {
			const permission = requiredPermission(method, '/api/todos/td_1/route');
			expect(permission).toEqual({ console: ['manage'] });
			expect(roleCan('member', permission!)).toBe(false);
			expect(roleCan('admin', permission!)).toBe(true);
		}
	});

	it('enqueues a server-built File payload and stores the routing', async () => {
		const todo = await store.create({
			title: 'Ship it',
			priority: 0,
			tags: ['+web'],
			created_by: 'u1'
		});
		mocks.enqueueDispatch.mockResolvedValue({ created: true, request: REQUEST });

		const response = await post(todo.id, { project_id: PROJECT.id, notes: 'extra' });

		expect(response.status).toBe(201);
		const call = mocks.enqueueDispatch.mock.calls[0][0];
		expect(call.project).toBe(PROJECT);
		expect(call.actor).toBe('admin@example.com');
		expect(call.payload).toMatchObject({
			operation: 'file',
			title: 'Ship it',
			priority: 0,
			labels: ['web']
		});
		expect(call.payload.notes).toContain('extra');
		expect(call.idempotency_key).toBe(`todo-route:${todo.id}:first`);
		const body = (await response.json()) as { todo: { routed_dispatch_id: string } };
		expect(body.todo.routed_dispatch_id).toBe(REQUEST.id);
	});

	it('does not enqueue again for an already routed todo', async () => {
		const todo = await store.create({ title: 'Ship it', created_by: 'u1' });
		mocks.enqueueDispatch.mockResolvedValue({ created: true, request: REQUEST });
		await post(todo.id, { project_id: PROJECT.id });
		mocks.getDispatch.mockResolvedValue(REQUEST);

		const again = await post(todo.id, { project_id: PROJECT.id });

		expect(again.status).toBe(200);
		expect(mocks.enqueueDispatch).toHaveBeenCalledOnce();
	});

	it('surfaces the policy refusal and leaves the todo unrouted', async () => {
		const todo = await store.create({ title: 'Ship it', created_by: 'u1' });
		mocks.enqueueDispatch.mockRejectedValue(
			new DispatchError('forbidden', 'Agent dispatch is disarmed.')
		);

		const response = await post(todo.id, { project_id: PROJECT.id });

		expect(response.status).toBe(403);
		expect(((await response.json()) as { error: { message: string } }).error.message).toBe(
			'Agent dispatch is disarmed.'
		);
		expect((await store.get(todo.id))?.routed_dispatch_id).toBeNull();
	});

	it('404s an unknown todo or project and 400s a bad body', async () => {
		const todo = await store.create({ title: 'Ship it', created_by: 'u1' });
		expect((await post('td_000000000000000000000000', { project_id: PROJECT.id })).status).toBe(
			404
		);
		mocks.resolveProject.mockResolvedValue(undefined);
		expect((await post(todo.id, { project_id: PROJECT.id })).status).toBe(404);
		expect((await post(todo.id, { project_id: PROJECT.id, extra: 1 })).status).toBe(400);
		expect((await post('nope', { project_id: PROJECT.id })).status).toBe(400);
		expect(mocks.enqueueDispatch).not.toHaveBeenCalled();
	});
});

describe('GET /api/todos/:id/route', () => {
	it('returns a null request for an unrouted todo and the refreshed dispatch otherwise', async () => {
		const todo = await store.create({ title: 'Ship it', created_by: 'u1' });
		const read = () =>
			GET({ params: { id: todo.id }, locals: { user: USER } } as never) as Promise<Response>;
		expect(((await (await read()).json()) as { request: unknown }).request).toBeNull();

		await store.update(todo.id, { routed_project_id: PROJECT.id, routed_dispatch_id: REQUEST.id });
		mocks.getDispatch.mockImplementation(async () => {
			await store.linkRoutedIssue(REQUEST.id, 'beads-web-9');
			return { ...REQUEST, status: 'succeeded' };
		});
		const body = (await (await read()).json()) as {
			todo: { routed_issue_id: string };
			request: { status: string };
		};
		expect(body.request.status).toBe('succeeded');
		expect(body.todo.routed_issue_id).toBe('beads-web-9');
	});
});
