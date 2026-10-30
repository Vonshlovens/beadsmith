import { createClient } from '@libsql/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { initStateSchema } from '../state/db.js';
import { createTodoStore, type TodoStore } from './store.js';

let store: TodoStore;
let tick: number;

beforeEach(async () => {
	const client = createClient({ url: ':memory:' });
	await initStateSchema(client);
	tick = 0;
	store = createTodoStore(client, () => new Date(Date.UTC(2026, 9, 28, 12, 0, tick++)));
});

describe('todo store', () => {
	it('creates with defaults and appends to the manual order', async () => {
		const a = await store.create({ title: 'a', created_by: 'u1' });
		const b = await store.create({ title: 'b', created_by: 'u1', tags: ['+web', '@home'] });

		expect(a).toMatchObject({ priority: 2, status: 'open', body: null, due_at: null, tags: [] });
		expect(a.id).toMatch(/^td_[a-f0-9]{24}$/);
		expect(b.sort_key).toBeGreaterThan(a.sort_key);
		expect(b.tags).toEqual(['+web', '@home']);
		expect((await store.list({ limit: 10 })).map((t) => t.title)).toEqual(['a', 'b']);
	});

	it('filters by status, tag and q (wildcards are literal)', async () => {
		const a = await store.create({ title: 'Buy milk', tags: ['@errand'], created_by: 'u' });
		await store.create({ title: '100% done', body: 'sale', tags: ['+web'], created_by: 'u' });
		await store.update(a.id, { status: 'done' });

		expect((await store.list({ status: 'done', limit: 10 })).map((t) => t.id)).toEqual([a.id]);
		expect(await store.list({ status: 'open', tag: '@errand', limit: 10 })).toEqual([]);
		expect((await store.list({ tag: '+web', limit: 10 })).map((t) => t.title)).toEqual([
			'100% done'
		]);
		expect((await store.list({ q: 'MILK', limit: 10 })).map((t) => t.title)).toEqual(['Buy milk']);
		expect((await store.list({ q: 'SALE', limit: 10 })).length).toBe(1);
		expect((await store.list({ q: '%', limit: 10 })).map((t) => t.title)).toEqual(['100% done']);
		expect(await store.list({ q: '_', limit: 10 })).toEqual([]);
	});

	it('stamps completed_at on done, clears it on reopen, keeps it on archive', async () => {
		const t = await store.create({ title: 't', created_by: 'u' });
		const done = await store.update(t.id, { status: 'done' });
		expect(done?.completed_at).not.toBeNull();
		const archived = await store.update(t.id, { status: 'archived' });
		expect(archived?.completed_at).toBe(done?.completed_at);
		const reopened = await store.update(t.id, { status: 'open' });
		expect(reopened?.completed_at).toBeNull();
	});

	it('patches fields, clears nullable ones, and reports a missing id', async () => {
		const t = await store.create({
			title: 't',
			body: 'b',
			due_at: '2026-11-01',
			created_by: 'u'
		});
		const updated = await store.update(t.id, { body: null, due_at: null, priority: 0 });
		expect(updated).toMatchObject({ body: null, due_at: null, priority: 0, title: 't' });
		expect(updated!.updated_at > t.updated_at).toBe(true);
		expect(await store.update('td_missing', { title: 'x' })).toBeUndefined();
	});

	it('stores routing references only', async () => {
		const t = await store.create({ title: 't', created_by: 'u' });
		const routed = await store.update(t.id, {
			routed_project_id: 'd_beads_web',
			routed_dispatch_id: 'dq_1',
			routed_issue_id: 'beads-web-1'
		});
		expect(routed).toMatchObject({
			routed_project_id: 'd_beads_web',
			routed_dispatch_id: 'dq_1',
			routed_issue_id: 'beads-web-1'
		});
	});

	it('threads comments oldest first and refuses an unknown todo', async () => {
		const t = await store.create({ title: 't', created_by: 'u' });
		await store.addComment(t.id, { author: 'a@x', text: 'one' });
		await store.addComment(t.id, { author: 'b@x', text: 'two' });
		expect((await store.listComments(t.id)).map((c) => c.text)).toEqual(['one', 'two']);
		expect((await store.get(t.id))?.comment_count).toBe(2);
		expect((await store.list({ limit: 10 }))[0].comment_count).toBe(2);
		expect(await store.addComment('td_missing', { author: 'a', text: 'x' })).toBeUndefined();
	});
});
