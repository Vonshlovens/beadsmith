import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { roleCan, requiredPermission } from '$lib/server/auth/roles.js';
import { initStateSchema, setTodoStore } from '$lib/server/state/db.js';
import { createTodoStore } from '$lib/server/todos/store.js';
import type { ApiErrorBody } from '$lib/types.js';
import { DELETE, GET as GET_ONE, PATCH } from './[id]/+server.js';
import { GET as GET_COMMENTS, POST as POST_COMMENT } from './[id]/comments/+server.js';
import { DELETE as DELETE_COMMENT } from './[id]/comments/[cid]/+server.js';
import { POST as COMPLETE } from './[id]/complete/+server.js';
import { POST as UNCOMPLETE } from './[id]/uncomplete/+server.js';
import { GET, POST } from './+server.js';

const USER = { id: 'u1', email: 'admin@example.com', name: 'Admin', role: 'admin' };

beforeEach(async () => {
	const client = createClient({ url: ':memory:' });
	await initStateSchema(client);
	setTodoStore(createTodoStore(client));
});

afterEach(() => {
	setTodoStore(undefined);
});

function json(body: unknown, method = 'POST'): Request {
	return new Request('http://localhost/api/todos', { method, body: JSON.stringify(body) });
}

async function create(body: unknown): Promise<{ id: string; [k: string]: unknown }> {
	const response = await POST({
		request: json(body),
		locals: { user: USER }
	} as unknown as Parameters<typeof POST>[0]);
	expect(response.status).toBe(201);
	return ((await response.json()) as { todo: { id: string } }).todo;
}

function withId<H extends (e: never) => unknown>(handler: H, id: string, request?: Request) {
	return handler({
		params: { id },
		request: request ?? new Request('http://localhost/'),
		locals: { user: USER }
	} as never) as Promise<Response>;
}

describe('admin gate', () => {
	it('requires console:manage for every todos method, reads included', () => {
		for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
			for (const path of [
				'/api/todos',
				'/api/todos/td_1',
				'/api/todos/td_1/comments',
				'/api/todos/td_1/comments/tc_1'
			]) {
				const permission = requiredPermission(method, path);
				expect(permission, `${method} ${path}`).toEqual({ console: ['manage'] });
				expect(roleCan('member', permission!)).toBe(false);
				expect(roleCan(undefined, permission!)).toBe(false);
				expect(roleCan('admin', permission!)).toBe(true);
			}
		}
	});
});

describe('/api/todos', () => {
	it('creates and lists with filters', async () => {
		const todo = await create({
			title: ' Ship it ',
			priority: 1,
			tags: ['+web'],
			due_at: '2026-11-01'
		});
		expect(todo).toMatchObject({ title: 'Ship it', priority: 1, created_by: 'u1' });
		await create({ title: 'other' });

		const list = await GET({
			url: new URL('http://localhost/api/todos?tag=%2Bweb&q=ship')
		} as unknown as Parameters<typeof GET>[0]);
		expect(((await list.json()) as { todos: { id: string }[] }).todos.map((t) => t.id)).toEqual([
			todo.id
		]);
	});

	it('rejects bad input', async () => {
		for (const body of [
			{},
			{ title: '' },
			{ title: 'x', priority: 5 },
			{ title: 'x', due_at: 'soon' },
			{ title: 'x', extra: 1 },
			{ title: 'x', tags: ['bad tag'] }
		]) {
			const response = await POST({
				request: json(body),
				locals: { user: USER }
			} as unknown as Parameters<typeof POST>[0]);
			expect(response.status, JSON.stringify(body)).toBe(400);
		}
		const unauth = await POST({
			request: json({ title: 'x' }),
			locals: {}
		} as unknown as Parameters<typeof POST>[0]);
		expect(unauth.status).toBe(401);
		const query = await GET({
			url: new URL('http://localhost/api/todos?status=nope')
		} as unknown as Parameters<typeof GET>[0]);
		expect(query.status).toBe(400);
	});

	it('defaults to open todos and honours status=all', async () => {
		const t = await create({ title: 'a' });
		await withId(COMPLETE, t.id);
		const call = async (qs: string) =>
			(
				(await (
					await GET({ url: new URL(`http://localhost/api/todos${qs}`) } as unknown as Parameters<
						typeof GET
					>[0])
				).json()) as { todos: unknown[] }
			).todos.length;
		expect(await call('')).toBe(0);
		expect(await call('?status=done')).toBe(1);
		expect(await call('?status=all')).toBe(1);
	});

	it('gets, patches, completes, uncompletes and archives', async () => {
		const t = await create({ title: 'a' });

		const got = await withId(GET_ONE, t.id);
		expect(((await got.json()) as { comments: unknown[] }).comments).toEqual([]);

		const patched = await withId(
			PATCH,
			t.id,
			json({ title: 'b', due_at: null, priority: 0 }, 'PATCH')
		);
		expect(((await patched.json()) as { todo: unknown }).todo).toMatchObject({
			title: 'b',
			priority: 0
		});

		const done = (await (await withId(COMPLETE, t.id)).json()) as {
			todo: { status: string; completed_at: string };
		};
		expect(done.todo.status).toBe('done');
		expect(done.todo.completed_at).toBeTruthy();

		const reopened = (await (await withId(UNCOMPLETE, t.id)).json()) as {
			todo: { status: string; completed_at: null };
		};
		expect(reopened.todo).toMatchObject({ status: 'open', completed_at: null });

		const archived = await withId(DELETE, t.id);
		expect(((await archived.json()) as { todo: { status: string } }).todo.status).toBe('archived');
		// Archived, not removed.
		expect((await withId(GET_ONE, t.id)).status).toBe(200);
	});

	it('returns 404 for an unknown id and 400 for a malformed one or empty patch', async () => {
		const missing = 'td_' + 'a'.repeat(24);
		for (const handler of [GET_ONE, COMPLETE, UNCOMPLETE, DELETE]) {
			const response = await withId(handler as never, missing);
			expect(response.status).toBe(404);
			expect(((await response.json()) as ApiErrorBody).error.code).toBe('not_found');
		}
		expect((await withId(PATCH, missing, json({ title: 'x' }, 'PATCH'))).status).toBe(404);
		expect((await withId(GET_ONE, 'nope')).status).toBe(400);
		const t = await create({ title: 'a' });
		expect((await withId(PATCH, t.id, json({}, 'PATCH'))).status).toBe(400);
		expect((await withId(PATCH, t.id, json({ routed_issue_id: 'x' }, 'PATCH'))).status).toBe(400);
	});

	it('adds and lists comments authored by the caller', async () => {
		const t = await create({ title: 'a' });
		const posted = await withId(POST_COMMENT, t.id, json({ text: ' hello ' }));
		expect(posted.status).toBe(201);
		expect(((await posted.json()) as { comment: unknown }).comment).toMatchObject({
			author: 'admin@example.com',
			text: 'hello'
		});
		const list = (await (await withId(GET_COMMENTS, t.id)).json()) as { comments: unknown[] };
		expect(list.comments).toHaveLength(1);

		expect((await withId(POST_COMMENT, t.id, json({ text: '' }))).status).toBe(400);
		expect((await withId(POST_COMMENT, 'td_' + 'b'.repeat(24), json({ text: 'x' }))).status).toBe(
			404
		);
		expect((await withId(GET_COMMENTS, 'td_' + 'b'.repeat(24))).status).toBe(404);
	});

	it('deletes one comment of a todo and 404s otherwise', async () => {
		const a = await create({ title: 'a' });
		const b = await create({ title: 'b' });
		const posted = (await (await withId(POST_COMMENT, a.id, json({ text: 'x' }))).json()) as {
			comment: { id: string };
		};
		const cid = posted.comment.id;
		const call = (todo: string, comment: string) =>
			DELETE_COMMENT({
				params: { id: todo, cid: comment },
				request: new Request('http://localhost/', { method: 'DELETE' }),
				locals: { user: USER }
			} as never) as Promise<Response>;

		expect((await call(b.id, cid)).status).toBe(404);
		expect((await call(a.id, 'nope')).status).toBe(400);
		expect((await call(a.id, cid)).status).toBe(200);
		expect((await call(a.id, cid)).status).toBe(404);
		const list = (await (await withId(GET_COMMENTS, a.id)).json()) as { comments: unknown[] };
		expect(list.comments).toEqual([]);
		const todo = (await (await withId(GET_ONE, a.id)).json()) as {
			todo: { comment_count: number };
		};
		expect(todo.todo.comment_count).toBe(0);
	});
});
