import { createClient, type Client } from '@libsql/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { initStateSchema } from '../state/db.js';
import { CREW_CALL_ARGUMENTS_MAX, CREW_CALL_REASON_MAX, CREW_CALLS_PER_CHAT } from '#lib/mate.js';
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
	it('upgrades existing event tables without losing history and persists message identities', async () => {
		const chat = await store.createChat('u1', { title: 't', scope: null });
		await store.appendEvents(
			chat.id,
			[{ type: 'user', id: 'old', text: 'before upgrade' }],
			'runner'
		);
		await client.execute('ALTER TABLE mate_events DROP COLUMN message_id');
		await initStateSchema(client);
		await initStateSchema(client);
		await store.appendEvents(
			chat.id,
			[{ type: 'user', id: 'new', text: 'after upgrade', message_id: 'message-1' }],
			'runner'
		);
		const events = await store.listEvents(chat.id, { limit: 10 });
		expect(events).toMatchObject([
			{ id: 'old', text: 'before upgrade' },
			{ id: 'new', text: 'after upgrade', message_id: 'message-1' }
		]);
		expect(events[0]).not.toHaveProperty('message_id');
	});

	it('keeps order, skips repeats, and stores compact fields only', async () => {
		const chat = await store.createChat('u1', { title: 't', scope: null });
		const first = await store.appendEvents(
			chat.id,
			[
				{ type: 'user', id: 'e1', text: 'go' },
				{ type: 'thinking', id: 'e2', text: 'x'.repeat(THINKING_TEXT_MAX + 50) },
				{ type: 'tool_call', id: 'e3', call_id: 'c1', name: 'Bash', status: 'running' },
				{ type: 'tool_call', id: 'e4', call_id: 'c1', name: 'Bash', status: 'completed' },
				{ type: 'tool_call', id: 'e4b', call_id: 'c2', name: 'Read', status: 'failed' },
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
		expect(first).toHaveLength(8);
		const again = await store.appendEvents(
			chat.id,
			[{ type: 'user', id: 'e1', text: 'go' }],
			'runner'
		);
		expect(again).toEqual([]);

		const events = await store.listEvents(chat.id, { limit: 100 });
		expect(events.map((event) => event.id)).toEqual([
			'e1',
			'e2',
			'e3',
			'e4',
			'e4b',
			'e5',
			'e6',
			'e7'
		]);
		expect(events[1]).toMatchObject({ type: 'thinking' });
		expect((events[1] as { text: string }).text).toHaveLength(THINKING_TEXT_MAX);
		expect(events[3]).toMatchObject({ type: 'tool_call', name: 'Bash', status: 'completed' });
		expect(events[4]).toMatchObject({ type: 'tool_call', name: 'Read', status: 'failed' });
		expect(events[6]).toMatchObject({
			type: 'result',
			status: 'succeeded',
			duration_ms: 1500,
			git_pr_url: 'https://github.com/o/r/pull/1'
		});
		expect(events[7]).toMatchObject({ type: 'error', message: 'worker crashed' });
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

describe('crewCaller', () => {
	async function addUser(id: string, role: string | null, banned = 0, ban_expires?: number) {
		await client.execute({
			sql: `INSERT INTO auth_user (id, name, email, role, banned, ban_expires, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, 0, 0)`,
			args: [id, id, `${id}@example.test`, role, banned, ban_expires ?? null]
		});
	}

	it('names the chat, its owner and the owner’s current role', async () => {
		await addUser('u1', 'admin');
		const chat = await store.createChat('u1', { title: 't', scope: 'd_web' });
		const session = (await store.getChat('u1', chat.id))!.session_id;
		expect(await store.crewCaller(session)).toEqual({
			chat_id: chat.id,
			owner_id: 'u1',
			owner_email: 'u1@example.test',
			role: 'admin',
			scope: 'd_web'
		});
		// A demotion applies on the next call.
		await client.execute("UPDATE auth_user SET role = 'member' WHERE id = 'u1'");
		expect((await store.crewCaller(session))?.role).toBe('member');
	});

	it('refuses an unknown session, a deleted chat and a banned owner', async () => {
		await addUser('u1', 'admin');
		await addUser('u2', 'admin', 1);
		await addUser('u3', 'admin', 1, Date.UTC(2020, 0, 1));
		expect(await store.crewCaller('no-such-session')).toBeUndefined();
		const own = async (owner: string) => {
			const chat = await store.createChat(owner, { title: 't', scope: null });
			return { chat, session: (await store.getChat(owner, chat.id))!.session_id };
		};
		const one = await own('u1');
		await store.deleteChat('u1', one.chat.id);
		expect(await store.crewCaller(one.session)).toBeUndefined();
		expect(await store.crewCaller((await own('u2')).session)).toBeUndefined();
		// A ban that has expired no longer refuses.
		expect((await store.crewCaller((await own('u3')).session))?.owner_id).toBe('u3');
	});
});

describe('crew calls', () => {
	const base = { tool: 'tackle_issue', arguments: '{"issue_id":"web-1"}', result: '{}' };

	it('lists summaries with a refusal reason and reads bodies on demand', async () => {
		const chat = await store.createChat('u1', { title: 't', scope: null });
		await store.recordCrewCall(chat.id, {
			...base,
			call_id: 'toolu_a',
			result: '{"mission_id":"m1"}',
			is_error: false,
			mission_id: 'm1'
		});
		const reason = 'Launch limit reached: '.padEnd(CREW_CALL_REASON_MAX + 50, 'x');
		await store.recordCrewCall(chat.id, {
			...base,
			call_id: 'toolu_b',
			result: reason,
			is_error: true
		});
		const calls = await store.listCrewCalls(chat.id);
		expect(calls).toEqual([
			{
				call_id: 'toolu_a',
				tool: 'tackle_issue',
				is_error: false,
				mission_id: 'm1',
				at: expect.any(String)
			},
			{
				call_id: 'toolu_b',
				tool: 'tackle_issue',
				is_error: true,
				reason: reason.slice(0, CREW_CALL_REASON_MAX),
				at: expect.any(String)
			}
		]);
		expect(JSON.stringify(calls)).not.toContain('web-1');
		expect(await store.getCrewCall(chat.id, 'toolu_b')).toMatchObject({
			arguments: base.arguments,
			result: reason
		});
		expect(await store.getCrewCall('mc_other', 'toolu_b')).toBeUndefined();
	});

	it('replaces a retried call, bounds bodies, prunes old calls and goes with the chat', async () => {
		const chat = await store.createChat('u1', { title: 't', scope: null });
		await store.recordCrewCall(chat.id, { ...base, call_id: 'toolu_r', is_error: true });
		await store.recordCrewCall(chat.id, {
			...base,
			call_id: 'toolu_r',
			arguments: 'y'.repeat(CREW_CALL_ARGUMENTS_MAX + 10),
			is_error: false
		});
		const retried = await store.getCrewCall(chat.id, 'toolu_r');
		expect(retried?.is_error).toBe(false);
		expect(retried?.arguments).toMatch(/… \[cut 10 chars\]$/);

		for (let i = 0; i < CREW_CALLS_PER_CHAT + 5; i++) {
			await store.recordCrewCall(chat.id, { ...base, call_id: `toolu_${i}`, is_error: false });
		}
		const calls = await store.listCrewCalls(chat.id);
		expect(calls).toHaveLength(CREW_CALLS_PER_CHAT);
		expect(calls.at(-1)?.call_id).toBe(`toolu_${CREW_CALLS_PER_CHAT + 4}`);
		expect(calls.some((call) => call.call_id === 'toolu_r')).toBe(false);

		await store.deleteChat('u1', chat.id);
		const left = await client.execute('SELECT COUNT(*) AS n FROM mate_crew_calls');
		expect(Number((left.rows[0] as Record<string, unknown>).n)).toBe(0);
	});
});
