import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_MESSAGE_CHARS, UNWIRED_REPLY, type MateEvent } from '#lib/mate.js';
import { readEnv, resetEnvCache } from '#lib/server/env.js';
import { createMateRunner, setMateRunner } from '#lib/server/mate/runner.js';
import { resetMateHealthCache } from '#lib/server/mate/service.js';
import { createMateStore, type MateStore } from '#lib/server/mate/store.js';
import { createDispatchStore, type DispatchStore } from '#lib/server/dispatch/store.js';
import { initStateSchema, setDispatchStore, setMateStore } from '#lib/server/state/db.js';
import {
	createFakeMateRunner,
	FAKE_RUNNER_SECRET,
	FAKE_RUNNER_URL,
	type FakeMateRunner
} from '#lib/test/fake-mate-runner.js';
import { GET as STATUS } from './status/+server.js';
import { GET as LIST, POST as CREATE } from './chats/+server.js';
import { DELETE, GET as GET_ONE, PATCH } from './chats/[id]/+server.js';
import { GET as EVENTS } from './chats/[id]/events/+server.js';
import { POST as INTERRUPT } from './chats/[id]/interrupt/+server.js';
import { POST as SEND } from './chats/[id]/messages/+server.js';
import { GET as MISSIONS } from './chats/[id]/missions/+server.js';
import { GET as CREW_CALLS } from './chats/[id]/crew-calls/+server.js';
import { GET as CREW_CALL } from './chats/[id]/crew-calls/[call_id]/+server.js';

vi.mock('#lib/server/discovery.js', () => ({
	discoverProjects: vi.fn(async () => [{ id: 'd_web', name: 'Web' }])
}));

const ADMIN = { id: 'u1', email: 'admin@example.com', name: 'Admin', role: 'admin' as const };
const OTHER = { id: 'u2', email: 'other@example.com', name: 'Other', role: 'admin' as const };

let store: MateStore;
let dispatch: DispatchStore;
let client: ReturnType<typeof createClient>;
let fake: FakeMateRunner;

function connect() {
	fake = createFakeMateRunner();
	const runner = createMateRunner({
		server_env: readEnv({
			BDX_MATE_RUNNER_URL: FAKE_RUNNER_URL,
			BDX_MATE_RUNNER_SECRET: FAKE_RUNNER_SECRET
		}),
		fetch: fake.fetch,
		secret: FAKE_RUNNER_SECRET
	});
	setMateRunner(runner ?? null);
}

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	await initStateSchema(client);
	store = createMateStore(client);
	setMateStore(store);
	// Opening a chat retries crew notices from the dispatch store.
	dispatch = createDispatchStore(client);
	setDispatchStore(dispatch);
	setMateRunner(null);
	resetMateHealthCache();
});

afterEach(() => {
	setMateStore(undefined);
	setDispatchStore(undefined);
	setMateRunner(undefined);
});

type Handler = (event: never) => unknown;

function call(
	handler: Handler,
	options: {
		id?: string;
		body?: unknown;
		user?: typeof ADMIN | undefined;
		role?: 'admin' | 'member';
		headers?: Record<string, string>;
		url?: string;
		signal?: AbortSignal;
		params?: Record<string, string>;
	} = {}
): Promise<Response> {
	const user = 'user' in options ? options.user : ADMIN;
	const url = options.url ?? 'http://localhost/api/mate/chats';
	return handler({
		params: { id: options.id ?? '', ...options.params },
		url: new URL(url),
		request: new Request(url, {
			method: options.body === undefined ? 'GET' : 'POST',
			headers: options.headers,
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
			signal: options.signal
		}),
		locals: { user, role: options.role ?? user?.role, session_id: 's' }
	} as never) as Promise<Response>;
}

async function createChat(user = ADMIN, body: unknown = { title: 'What is ready?', scope: null }) {
	const response = await call(CREATE, { body, user });
	expect(response.status).toBe(201);
	return ((await response.json()) as { chat: { id: string } }).chat;
}

/** Read SSE frames until `count` data frames arrived (or `until` says stop). */
async function readFrames(
	response: Response,
	count: number,
	on_frame?: (frame: { id?: string; event?: string; data: string }) => void
): Promise<{ id?: string; event?: string; data: string }[]> {
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	const frames: { id?: string; event?: string; data: string }[] = [];
	let buffer = '';
	while (frames.length < count) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let end = buffer.indexOf('\n\n');
		while (end !== -1) {
			const block = buffer.slice(0, end);
			buffer = buffer.slice(end + 2);
			const frame: { id?: string; event?: string; data: string } = { data: '' };
			let has_data = false;
			for (const line of block.split('\n')) {
				if (line.startsWith('id: ')) frame.id = line.slice(4);
				else if (line.startsWith('event: ')) frame.event = line.slice(7);
				else if (line.startsWith('data: ')) {
					frame.data = line.slice(6);
					has_data = true;
				}
			}
			if (has_data) {
				frames.push(frame);
				on_frame?.(frame);
			}
			end = buffer.indexOf('\n\n');
		}
	}
	await reader.cancel();
	return frames;
}

describe('GET /api/mate/status', () => {
	it('says why a viewer is not connected', async () => {
		expect(await (await call(STATUS)).json()).toEqual({ connected: false, reason: 'unconfigured' });
		expect(await (await call(STATUS, { role: 'member' })).json()).toEqual({
			connected: false,
			reason: 'admin_only'
		});
		connect();
		expect(await (await call(STATUS, { role: 'member' })).json()).toEqual({
			connected: false,
			reason: 'admin_only'
		});
		expect(await (await call(STATUS)).json()).toEqual({ connected: true, reachable: true });
	});
});

describe('chats', () => {
	it('needs a signed-in account', async () => {
		expect((await call(LIST, { user: undefined })).status).toBe(401);
		expect((await call(CREATE, { user: undefined, body: {} })).status).toBe(401);
	});

	it('are private to their owner', async () => {
		const mine = await createChat();
		await createChat(OTHER, { title: 'theirs' });
		const list = (await (await call(LIST)).json()) as { chats: { id: string }[] };
		expect(list.chats.map((chat) => chat.id)).toEqual([mine.id]);

		for (const handler of [GET_ONE, DELETE, EVENTS, INTERRUPT] as Handler[]) {
			expect((await call(handler, { id: mine.id, user: OTHER })).status).toBe(404);
		}
		expect((await call(SEND, { id: mine.id, user: OTHER, body: { text: 'hi' } })).status).toBe(404);
		expect((await call(GET_ONE, { id: 'not-a-chat' })).status).toBe(400);
	});

	it('creates with validated scope and title, and never shows the session id', async () => {
		expect((await call(CREATE, { body: { scope: 'nope' } })).status).toBe(400);
		expect((await call(CREATE, { body: { scope: null, extra: 1 } })).status).toBe(400);
		const chat = await createChat(ADMIN, { scope: 'd_beads_web' });
		expect(chat).toMatchObject({ title: 'New chat', scope: 'd_beads_web' });
		expect(chat).not.toHaveProperty('session_id');
		const patched = await call(PATCH, {
			id: chat.id,
			body: { scope: null },
			url: `http://localhost/api/mate/chats/${chat.id}`
		});
		expect(((await patched.json()) as { chat: { scope: null } }).chat.scope).toBeNull();
	});

	it('keeps the runner a chat was created on, and refuses one not configured', async () => {
		// The test env configures no chat runner, so only the default applies.
		expect((await call(CREATE, { body: { scope: null, runner: 'e2b' } })).status).toBe(400);
		expect((await call(CREATE, { body: { scope: null, runner: 'cloud' } })).status).toBe(400);
		const chat = await createChat(ADMIN, { scope: null });
		expect(chat).toMatchObject({ runner: 'remote' });
		await store.createChat(ADMIN.id, { title: 'On Sand', scope: null, runner: 'e2b' });
		const listed = (await (await call(LIST)).json()) as {
			chats: { title: string; runner: string }[];
		};
		expect(listed.chats.find((entry) => entry.title === 'On Sand')?.runner).toBe('e2b');
	});
});

describe('model and effort', () => {
	beforeEach(() => {
		vi.stubEnv('BDX_AGENT_MODELS', 'claude-opus-5-5,claude-sonnet-5-5');
		vi.stubEnv('BDX_AGENT_EFFORTS', 'low,high');
		resetEnvCache();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		resetEnvCache();
	});

	it('accepts a choice from the operator list and keeps it on the chat', async () => {
		const chat = await createChat(ADMIN, {
			scope: null,
			model: 'claude-sonnet-5-5',
			effort: 'high'
		});
		expect(chat).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' });
		expect(await store.getChat(ADMIN.id, chat.id)).toMatchObject({
			model: 'claude-sonnet-5-5',
			effort: 'high'
		});
		const listed = (await (await call(LIST)).json()) as { chats: Record<string, unknown>[] };
		expect(listed.chats[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' });
		// Fixed for the chat's life: a patch cannot change it.
		const patched = await call(PATCH, {
			id: chat.id,
			body: { model: 'claude-opus-5-5' },
			url: `http://localhost/api/mate/chats/${chat.id}`
		});
		expect(patched.status).toBe(400);
	});

	it('refuses a model or effort the operator does not offer, or that is not a name', async () => {
		for (const body of [
			{ scope: null, model: 'claude-haiku-5-5' },
			{ scope: null, effort: 'max' },
			{ scope: null, model: '--dangerously-skip-permissions' }
		]) {
			expect((await call(CREATE, { body })).status).toBe(400);
		}
		expect(await store.countChats(ADMIN.id)).toBe(0);
	});

	it('leaves both out by default', async () => {
		const chat = await createChat(ADMIN, { scope: null });
		expect(chat).not.toHaveProperty('model');
		expect(chat).not.toHaveProperty('effort');
	});

	it('sends the chat choice with every message to the runner', async () => {
		connect();
		const chat = await createChat(ADMIN, { scope: null, model: 'claude-opus-5-5', effort: 'low' });
		await call(SEND, { id: chat.id, body: { text: 'one', message_id: 'm1' } });
		await call(SEND, { id: chat.id, body: { text: 'two', message_id: 'm2' } });
		const messages = fake.requests.filter((r) => r.target.endsWith('/messages'));
		expect(messages).toHaveLength(2);
		for (const request of messages) {
			expect(JSON.parse(request.body)).toMatchObject({ model: 'claude-opus-5-5', effort: 'low' });
		}

		const plain = await createChat(ADMIN, { scope: null });
		await call(SEND, { id: plain.id, body: { text: 'three', message_id: 'm3' } });
		const sent = JSON.parse(fake.requests.at(-1)!.body) as Record<string, unknown>;
		expect(sent).not.toHaveProperty('model');
		expect(sent).not.toHaveProperty('effort');
	});
});

describe('POST messages without a runner', () => {
	it('stores the message and the placeholder reply', async () => {
		const chat = await createChat();
		const response = await call(SEND, { id: chat.id, body: { text: ' hello ', message_id: 'm1' } });
		expect(response.status).toBe(202);
		const { events } = (await response.json()) as { events: MateEvent[] };
		expect(events.map((event) => event.type)).toEqual(['user', 'assistant', 'result']);
		expect(events[0]).toMatchObject({ text: 'hello' });
		expect(events[1]).toMatchObject({ text: UNWIRED_REPLY });

		const again = await call(SEND, { id: chat.id, body: { text: 'hello', message_id: 'm1' } });
		expect(((await again.json()) as { events: MateEvent[] }).events).toEqual([]);

		const detail = (await (await call(GET_ONE, { id: chat.id })).json()) as { events: MateEvent[] };
		expect(detail.events).toHaveLength(3);
		expect((await call(EVENTS, { id: chat.id })).status).toBe(503);
		expect((await call(INTERRUPT, { id: chat.id })).status).toBe(503);
	});

	it('enforces the message size and shape', async () => {
		const chat = await createChat();
		const long = 'x'.repeat(MAX_MESSAGE_CHARS + 1);
		expect((await call(SEND, { id: chat.id, body: { text: long } })).status).toBe(400);
		expect((await call(SEND, { id: chat.id, body: { text: '   ' } })).status).toBe(400);
		expect((await call(SEND, { id: chat.id, body: { text: 'a', model: 'x' } })).status).toBe(400);
		expect((await call(SEND, { id: chat.id, body: { text: 'a', message_id: 'a b' } })).status).toBe(
			400
		);
		// Crew notices are Beadsmith's; a browser cannot send one.
		expect(
			(await call(SEND, { id: chat.id, body: { text: 'a', message_id: 'crew-0123' } })).status
		).toBe(400);
	});
});

describe('with a runner', () => {
	beforeEach(() => {
		connect();
	});

	it('forwards a message with the chat session, scope and message id', async () => {
		const chat = await createChat(ADMIN, { scope: 'd_beads_web' });
		const response = await call(SEND, {
			id: chat.id,
			body: { text: 'tackle it', message_id: 'm-1' }
		});
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({ event_id: 'e000001' });
		const sent = JSON.parse(fake.requests.at(-1)!.body) as Record<string, unknown>;
		const session_id = (await store.getChat(ADMIN.id, chat.id))!.session_id;
		expect(sent).toEqual({
			session_id,
			message_id: 'm-1',
			prompt: 'tackle it',
			scope: 'd_beads_web'
		});

		await call(SEND, { id: chat.id, body: { text: 'and another' } });
		const second = JSON.parse(fake.requests.at(-1)!.body) as Record<string, string>;
		expect(second.session_id).toBe(session_id);
		expect(second.message_id).toMatch(/^[0-9a-f-]{36}$/);
		// Nothing is stored until it comes back through the stream.
		expect(await store.listEvents(chat.id, { limit: 10 })).toEqual([]);
	});

	it('maps runner refusals', async () => {
		const chat = await createChat();
		fake.failNext('/messages', 404, { error: 'cannot start' });
		const missing = await call(SEND, { id: chat.id, body: { text: 'hi' } });
		expect(missing.status).toBe(503);
		expect(((await missing.json()) as { error: { message: string } }).error.message).toContain(
			'cannot start'
		);
		fake.failNext('/messages', 409, { error: 'busy' });
		expect((await call(SEND, { id: chat.id, body: { text: 'hi' } })).status).toBe(409);
	});

	it('streams stored events, then the runner, storing what is new', async () => {
		const chat = await createChat();
		await call(SEND, { id: chat.id, body: { text: 'what is ready?' } });
		fake.emit(chat.id, { type: 'assistant', text: 'Looking.' });

		const ac = new AbortController();
		const response = await call(EVENTS, { id: chat.id, signal: ac.signal });
		expect(response.headers.get('content-type')).toContain('text/event-stream');
		const frames = readFrames(response, 4, (frame) => {
			if (frame.id === 'e000002') {
				fake.emit(chat.id, { type: 'tool_call', call_id: 'c1', name: 'Bash', status: 'running' });
				fake.emit(chat.id, { type: 'result', status: 'succeeded' });
			}
		});
		const got = await frames;
		ac.abort();
		expect(got.map((frame) => frame.id)).toEqual(['e000001', 'e000002', 'e000003', 'e000004']);
		const parsed = JSON.parse(got[2]!.data) as Record<string, unknown>;
		expect(parsed).toMatchObject({ type: 'tool_call', name: 'Bash', status: 'running' });
		expect(typeof parsed.at).toBe('string');

		const stored = await store.listEvents(chat.id, { limit: 10 });
		expect(stored.map((event) => event.id)).toEqual(['e000001', 'e000002', 'e000003', 'e000004']);
		await vi.waitFor(() => expect(fake.listeners(chat.id)).toBe(0));
	});

	it('catches up from the last stored runner event, and replays after Last-Event-ID', async () => {
		const chat = await createChat();
		await call(SEND, { id: chat.id, body: { text: 'hi' } });
		fake.emit(chat.id, { type: 'assistant', text: 'one' });
		fake.end_after_replay = true;
		await readFrames(await call(EVENTS, { id: chat.id }), 10);
		expect(fake.requests.at(-1)!.target).toBe(`/base/v1/mate/chats/${chat.id}/events`);

		// The agent speaks while nobody is watching.
		fake.emit(chat.id, { type: 'assistant', text: 'PR ready, captain.' });
		const frames = await readFrames(
			await call(EVENTS, { id: chat.id, headers: { 'last-event-id': 'e000001' } }),
			10
		);
		expect(fake.requests.at(-1)!.target).toBe(
			`/base/v1/mate/chats/${chat.id}/events?after=e000002`
		);
		expect(frames.map((frame) => frame.id)).toEqual(['e000002', 'e000003']);
		expect((await store.listEvents(chat.id, { limit: 10 })).map((e) => e.id)).toEqual([
			'e000001',
			'e000002',
			'e000003'
		]);
		expect(
			(await call(EVENTS, { id: chat.id, headers: { 'last-event-id': 'bad id' } })).status
		).toBe(400);
	});

	it('does not skip events stored by another tab during replay', async () => {
		const chat = await createChat();
		await call(SEND, { id: chat.id, body: { text: 'hi' } });
		fake.end_after_replay = true;
		await readFrames(await call(EVENTS, { id: chat.id }), 10);
		const list = store.listEvents.bind(store);
		vi.spyOn(store, 'listEvents').mockImplementationOnce(async (...args) => {
			const snapshot = await list(...args);
			const id = fake.emit(chat.id, { type: 'assistant', text: 'concurrent reply' });
			await store.appendEvents(
				chat.id,
				[{ type: 'assistant', id, text: 'concurrent reply' }],
				'runner'
			);
			return snapshot;
		});
		const frames = await readFrames(await call(EVENTS, { id: chat.id }), 10);
		expect(frames.map((f) => f.id)).toEqual(['e000001', 'e000002']);
	});

	it('replays every missed event across the replay page boundary', async () => {
		const chat = await createChat();
		const events = Array.from({ length: 2003 }, (_, n) => ({
			type: 'assistant' as const,
			id: `e${n}`,
			text: 'reply'
		}));
		await store.appendEvents(chat.id, events, 'runner');
		fake.end_after_replay = true;
		const frames = await readFrames(
			await call(EVENTS, {
				id: chat.id,
				headers: { 'last-event-id': 'e0' }
			}),
			3000
		);
		expect(frames.map((f) => f.id)).toEqual(events.slice(1).map((e) => e.id));
	});

	it('reports a runner failure as a runner_error frame', async () => {
		const chat = await createChat();
		fake.failNext('/events', 500, { error: 'session store down' });
		const frames = await readFrames(await call(EVENTS, { id: chat.id }), 1);
		expect(frames[0]!.event).toBe('runner_error');
		expect(JSON.parse(frames[0]!.data)).toEqual({
			message: 'The mate runner refused to stream the chat (HTTP 500): session store down'
		});
	});

	it('does not open a runner stream for an already cancelled request', async () => {
		const chat = await createChat();
		const ac = new AbortController();
		ac.abort();
		const frames = await readFrames(await call(EVENTS, { id: chat.id, signal: ac.signal }), 1);
		expect(frames).toEqual([]);
		expect(fake.requests).toEqual([]);
	});

	it('closing the browser stream closes the runner stream', async () => {
		const chat = await createChat();
		const response = await call(EVENTS, { id: chat.id });
		const reader = response.body!.getReader();
		try {
			// The first frame is local retry guidance, sent before async stored
			// replay and runner connection. It does not signal a live listener.
			await reader.read();
			await vi.waitFor(() => expect(fake.listeners(chat.id)).toBe(1));
		} finally {
			await reader.cancel();
		}
		await vi.waitFor(() => expect(fake.listeners(chat.id)).toBe(0));
	});

	it('interrupts and deletes on the runner', async () => {
		const chat = await createChat();
		expect((await call(INTERRUPT, { id: chat.id, body: {} })).status).toBe(202);
		expect(fake.interrupts).toEqual([chat.id]);

		fake.failNext(`/${chat.id}`, 500, { error: 'stuck' });
		expect((await call(DELETE, { id: chat.id })).status).toBe(503);
		expect(await store.getChat(ADMIN.id, chat.id)).toBeDefined();

		expect((await call(DELETE, { id: chat.id })).status).toBe(200);
		expect(fake.deleted).toEqual([chat.id]);
		expect(await store.getChat(ADMIN.id, chat.id)).toBeUndefined();
	});
});

describe('crew notices', () => {
	beforeEach(() => {
		connect();
	});

	it('delivers a notice the chat is still owed when it opens, once', async () => {
		await client.execute(
			`INSERT INTO auth_user (id, name, email, role, banned, created_at, updated_at)
				VALUES ('u1', 'Admin', 'admin@example.com', 'admin', 0, 0, 0)`
		);
		const chat = await createChat();
		const { record } = await dispatch.create({
			idempotency_key: 'crew:route',
			project_id: 'd_web',
			dolt_database: 'web',
			operation: 'tackle',
			actor: ADMIN.email,
			payload: { operation: 'tackle', issue_id: 'web-12' },
			chat_id: chat.id
		});
		// It finished while the chat's runner could not take the notice.
		await dispatch.updateStatus(record.id, { status: 'succeeded', run_id: 'run-1' });

		fake.end_after_replay = true;
		await readFrames(await call(EVENTS, { id: chat.id }), 10);
		await vi.waitFor(() =>
			expect(fake.events(chat.id).filter((event) => event.type === 'user')).toHaveLength(1)
		);
		const [notice] = fake.events(chat.id);
		expect(notice).toMatchObject({ type: 'user', message_id: expect.stringMatching(/^crew-/) });
		expect((notice as { text: string }).text).toContain(
			'[crew] Tackle on web-12 (d_web) succeeded.'
		);
		await vi.waitFor(async () =>
			expect((await dispatch.get(record.id))?.chat_notice).toBe('succeeded:run-1')
		);

		await readFrames(await call(EVENTS, { id: chat.id }), 10);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(fake.events(chat.id).filter((event) => event.type === 'user')).toHaveLength(1);
	});
});

describe('GET /api/mate/chats/:id/missions', () => {
	async function launch(chat_id: string | undefined, key: string, issue_id: string) {
		const { record } = await dispatch.create({
			idempotency_key: key,
			project_id: 'd_web',
			dolt_database: 'web',
			operation: 'tackle',
			actor: ADMIN.email,
			payload: { operation: 'tackle', issue_id },
			...(chat_id === undefined ? {} : { chat_id })
		});
		return record;
	}

	it('lists only the missions this chat launched, with project names', async () => {
		const chat = await createChat();
		const other = await createChat();
		const mine = await launch(chat.id, 'crew:mine-1', 'web-1');
		await launch(other.id, 'crew:other-1', 'web-2');
		await launch(undefined, 'browser-key-1', 'web-3');

		const response = await call(MISSIONS, { id: chat.id });
		expect(response.status).toBe(200);
		const { missions } = (await response.json()) as {
			missions: { id: string; issue_id?: string; project_name: string }[];
		};
		expect(missions).toEqual([
			expect.objectContaining({ id: mine.id, issue_id: 'web-1', project_name: 'Web' })
		]);
		// Which chat launched it stays server-side.
		expect(JSON.stringify(missions)).not.toContain(chat.id);
	});

	it('is private to the chat owner', async () => {
		const chat = await createChat();
		await launch(chat.id, 'crew:mine-2', 'web-1');
		expect((await call(MISSIONS, { id: chat.id, user: OTHER })).status).toBe(404);
		expect((await call(MISSIONS, { id: chat.id, user: undefined })).status).toBe(401);
	});
});

describe('GET /api/mate/chats/:id/crew-calls', () => {
	async function record(chat_id: string) {
		await store.recordCrewCall(chat_id, {
			call_id: 'toolu_1',
			tool: 'tackle_issue',
			arguments: '{"issue_id":"web-1"}',
			result: 'Tackle is not allowed for Web.',
			is_error: true
		});
	}

	it('lists summaries and reads one call with its bodies', async () => {
		const chat = await createChat();
		await record(chat.id);
		const list = await call(CREW_CALLS, { id: chat.id });
		expect(list.status).toBe(200);
		expect(await list.json()).toEqual({
			calls: [
				{
					call_id: 'toolu_1',
					tool: 'tackle_issue',
					is_error: true,
					reason: 'Tackle is not allowed for Web.',
					at: expect.any(String)
				}
			]
		});
		const one = await call(CREW_CALL, { id: chat.id, params: { call_id: 'toolu_1' } });
		expect(one.status).toBe(200);
		expect(await one.json()).toMatchObject({
			call: { call_id: 'toolu_1', arguments: '{"issue_id":"web-1"}' }
		});
		for (const call_id of ['toolu_missing', '../etc']) {
			expect((await call(CREW_CALL, { id: chat.id, params: { call_id } })).status).toBe(404);
		}
	});

	it('is private to the chat owner', async () => {
		const chat = await createChat();
		await record(chat.id);
		expect((await call(CREW_CALLS, { id: chat.id, user: OTHER })).status).toBe(404);
		expect(
			(await call(CREW_CALL, { id: chat.id, user: OTHER, params: { call_id: 'toolu_1' } })).status
		).toBe(404);
		expect((await call(CREW_CALLS, { id: chat.id, user: undefined })).status).toBe(401);
	});
});
