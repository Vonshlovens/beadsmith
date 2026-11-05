import { createClient, type Client } from '@libsql/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { initStateSchema } from '../state/db.js';
import { createMateStore, THINKING_TEXT_MAX, type MateStore } from './store.js';

let client: Client;
let store: MateStore;
let tick = 0;

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	await initStateSchema(client);
	tick = 0;
	store = createMateStore(client, () => new Date(Date.UTC(2026, 10, 5, 0, 0, tick++)));
});

describe('chats', () => {
	it('belong to one owner', async () => {
		const chat = await store.createChat('u1', { title: 'What is ready?', scope: 'd_web' });
		expect(chat.id).toMatch(/^mc_[a-f0-9]{24}$/);
		expect(await store.getChat('u2', chat.id)).toBeUndefined();
		expect(await store.listChats('u2', 10)).toEqual([]);
		expect(await store.updateChat('u2', chat.id, { scope: null })).toBeUndefined();
		expect(await store.deleteChat('u2', chat.id)).toBe(false);

		const stored = await store.getChat('u1', chat.id);
		expect(stored?.session_id).toMatch(/^[0-9a-f-]{36}$/);
		expect(await store.listChats('u1', 10)).toEqual([chat]);
		expect(await store.countChats('u1')).toBe(1);
	});

	it('gives every chat its own stable session id', async () => {
		const a = await store.createChat('u1', { title: 'a', scope: null });
		const b = await store.createChat('u1', { title: 'b', scope: null });
		const sa = (await store.getChat('u1', a.id))?.session_id;
		await store.updateChat('u1', a.id, { scope: 'd_web', title: 'renamed' });
		expect((await store.getChat('u1', a.id))?.session_id).toBe(sa);
		expect((await store.getChat('u1', b.id))?.session_id).not.toBe(sa);
		expect(await store.getChat('u1', a.id)).toMatchObject({ title: 'renamed', scope: 'd_web' });
	});

	it('lists the most recently active first and deletes events with the chat', async () => {
		const a = await store.createChat('u1', { title: 'a', scope: null });
		const b = await store.createChat('u1', { title: 'b', scope: null });
		await store.appendEvents(a.id, [{ type: 'user', id: 'e1', text: 'hi' }], 'runner');
		expect((await store.listChats('u1', 10)).map((chat) => chat.id)).toEqual([a.id, b.id]);
		expect(await store.deleteChat('u1', a.id)).toBe(true);
		const left = await client.execute('SELECT COUNT(*) AS n FROM mate_events');
		expect(Number((left.rows[0] as Record<string, unknown>).n)).toBe(0);
	});
});

describe('events', () => {
	it('keeps order, skips repeats, and stores compact fields only', async () => {
		const chat = await store.createChat('u1', { title: 't', scope: null });
		const first = await store.appendEvents(
			chat.id,
			[
				{ type: 'user', id: 'e1', text: 'go' },
				{ type: 'thinking', id: 'e2', text: 'x'.repeat(THINKING_TEXT_MAX + 50) },
				{ type: 'tool_call', id: 'e3', call_id: 'c1', name: 'Bash', status: 'running' },
				{ type: 'tool_call', id: 'e4', call_id: 'c1', name: 'Bash', status: 'completed' },
				{ type: 'assistant', id: 'e5', text: 'PR ready, captain.' },
				{
					type: 'result',
					id: 'e6',
					status: 'succeeded',
					duration_ms: 1500,
					git_pr_url: 'https://github.com/o/r/pull/1'
				},
				{ type: 'error', id: 'e7', message: 'worker crashed' }
			],
			'runner'
		);
		expect(first).toHaveLength(7);
		const again = await store.appendEvents(
			chat.id,
			[{ type: 'user', id: 'e1', text: 'go' }],
			'runner'
		);
		expect(again).toEqual([]);

		const events = await store.listEvents(chat.id, { limit: 100 });
		expect(events.map((event) => event.id)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7']);
		expect(events[1]).toMatchObject({ type: 'thinking' });
		expect((events[1] as { text: string }).text).toHaveLength(THINKING_TEXT_MAX);
		expect(events[3]).toMatchObject({ type: 'tool_call', name: 'Bash', status: 'completed' });
		expect(events[5]).toMatchObject({
			type: 'result',
			status: 'succeeded',
			duration_ms: 1500,
			git_pr_url: 'https://github.com/o/r/pull/1'
		});
		expect(events[6]).toMatchObject({ type: 'error', message: 'worker crashed' });
		expect(events.every((event) => typeof event.at === 'string')).toBe(true);
	});

	it('replays after a known id, everything for an unknown one, and caps to the newest', async () => {
		const chat = await store.createChat('u1', { title: 't', scope: null });
		await store.appendEvents(
			chat.id,
			['e1', 'e2', 'e3'].map((id) => ({ type: 'assistant' as const, id, text: id })),
			'runner'
		);
		expect((await store.listEvents(chat.id, { after: 'e1', limit: 10 })).map((e) => e.id)).toEqual([
			'e2',
			'e3'
		]);
		expect((await store.listEvents(chat.id, { after: 'zz', limit: 10 })).map((e) => e.id)).toEqual([
			'e1',
			'e2',
			'e3'
		]);
		expect((await store.listEvents(chat.id, { limit: 2 })).map((e) => e.id)).toEqual(['e2', 'e3']);
	});

	it('the catch-up cursor ignores local events', async () => {
		const chat = await store.createChat('u1', { title: 't', scope: null });
		expect(await store.lastRunnerEventId(chat.id)).toBeUndefined();
		await store.appendEvents(chat.id, [{ type: 'user', id: 'e1', text: 'a' }], 'runner');
		await store.appendEvents(chat.id, [{ type: 'user', id: 'local-m-u', text: 'b' }], 'local');
		expect(await store.lastRunnerEventId(chat.id)).toBe('e1');
	});
});
