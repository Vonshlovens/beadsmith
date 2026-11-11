import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDispatchStore, type DispatchStore } from '#lib/server/dispatch/store.js';
import { setMateRunner, type MateRunner } from '#lib/server/mate/runner.js';
import { createMateStore, type MateStore } from '#lib/server/mate/store.js';
import {
	initStateSchema,
	setDispatchStore,
	setMateStore,
	setTerminalRelayAuditStore
} from '#lib/server/state/db.js';
import {
	createTerminalRelayAuditStore,
	type TerminalRelayAuditStore
} from '#lib/server/terminal-relay/audit.js';
import {
	attachSandboxTerminal,
	RELAY_FINISHED_MESSAGE,
	RELAY_PAUSED_MESSAGE
} from '#lib/server/terminal-relay/relay.js';
import { NO_CHAT_RELAY_MESSAGE } from '#lib/server/terminal-relay/route.js';
import { RELAY_WATCH_ONLY_MESSAGE } from '#lib/server/terminal-relay/service.js';
import { FakeHcCore } from '#lib/test/fake-hc.js';
import { fakeSandboxDriver } from '#lib/test/fake-sandbox-driver.js';
import { POST as OPEN } from './+server.js';
import { POST as INPUT } from './[relay]/+server.js';

const ADMIN = { id: 'u1', email: 'admin@example.com', name: 'Admin', role: 'admin' as const };
const SESSION = 'browser-session-1';

let core: FakeHcCore;
let fake: ReturnType<typeof fakeSandboxDriver>;
let mate: MateStore;
let dispatch: DispatchStore;
let audit: TerminalRelayAuditStore;
let chat_id: string;

/** A Sand-like chat runner: the chat's terminal is the one labelled with its session. */
function relayRunner(): MateRunner {
	const refuse = async (): Promise<never> => {
		throw new Error('not in these tests');
	};
	return {
		sendMessage: refuse,
		streamEvents: refuse,
		interrupt: refuse,
		deleteChat: refuse,
		health: async () => true,
		attachTerminal: (_chat, request) =>
			attachSandboxTerminal(
				{ driver: fake.driver, connect_hc: fake.connect_hc, idle_ms: 60_000 },
				'sbx1',
				(live) => live.find((terminal) => terminal.labels['beadsmith-session'] === 's1'),
				request
			)
	};
}

beforeEach(async () => {
	const client = createClient({ url: ':memory:' });
	await initStateSchema(client);
	mate = createMateStore(client);
	dispatch = createDispatchStore(client);
	audit = createTerminalRelayAuditStore(client);
	setMateStore(mate);
	setDispatchStore(dispatch);
	setTerminalRelayAuditStore(audit);
	core = new FakeHcCore();
	fake = fakeSandboxDriver(core);
	const hc = await fake.connect_hc();
	await hc.run({ argv: ['claude'], labels: { 'beadsmith-session': 's1' } });
	hc.close();
	chat_id = (await mate.createChat(ADMIN.id, { title: 'Chat', scope: null, runner: 'e2b' })).id;
	setMateRunner(relayRunner());
});

afterEach(() => {
	setMateStore(undefined);
	setDispatchStore(undefined);
	setTerminalRelayAuditStore(undefined);
	setMateRunner(undefined);
});

function open(body: unknown, options: { signal?: AbortSignal; user?: typeof ADMIN } = {}) {
	const url = 'http://localhost/api/console/terminals';
	return OPEN({
		url: new URL(url),
		request: new Request(url, {
			method: 'POST',
			body: JSON.stringify(body),
			signal: options.signal
		}),
		locals: { user: options.user ?? ADMIN, role: 'admin', session_id: SESSION }
	} as never) as Promise<Response>;
}

function input(relay: string, body: unknown, session = SESSION) {
	const url = `http://localhost/api/console/terminals/${relay}`;
	return INPUT({
		params: { relay },
		url: new URL(url),
		request: new Request(url, { method: 'POST', body: JSON.stringify(body) }),
		locals: { user: ADMIN, role: 'admin', session_id: session }
	} as never) as Promise<Response>;
}

interface Frame {
	event: string;
	data: string;
}

/** Read SSE frames from `response` until `until` says stop. */
function frames(response: Response) {
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	const seen: Frame[] = [];
	let pending = '';
	return {
		seen,
		async until(done: (frames: Frame[]) => boolean): Promise<Frame[]> {
			while (!done(seen)) {
				const { value, done: ended } = await reader.read();
				if (ended) break;
				pending += decoder.decode(value, { stream: true });
				let at;
				while ((at = pending.indexOf('\n\n')) !== -1) {
					const block = pending.slice(0, at);
					pending = pending.slice(at + 2);
					const event = /^event: (.*)$/m.exec(block)?.[1];
					const data = /^data: (.*)$/m.exec(block)?.[1];
					if (event !== undefined && data !== undefined) seen.push({ event, data });
				}
			}
			return seen;
		},
		cancel: () => reader.cancel()
	};
}

function output(seen: Frame[]): string {
	return seen
		.filter((frame) => frame.event === 'output')
		.map((frame) => Buffer.from(frame.data, 'base64').toString())
		.join('');
}

async function errorOf(response: Response) {
	return { status: response.status, ...((await response.json()) as { error: object }).error };
}

describe('POST /api/console/terminals', () => {
	it('404s an unknown mission or chat, and 409s a mission with no agent yet', async () => {
		expect(
			await errorOf(
				await open({ mission: `dq_${'0'.repeat(32)}`, mode: 'watch', cols: 80, rows: 24 })
			)
		).toMatchObject({ status: 404 });
		expect(
			await errorOf(await open({ chat: `mc_${'0'.repeat(24)}`, mode: 'watch', cols: 80, rows: 24 }))
		).toMatchObject({ status: 404 });
		const { record } = await dispatch.create({
			idempotency_key: 'idem-relay-1',
			project_id: 'd_web',
			dolt_database: 'web',
			operation: 'file',
			actor: 'web',
			payload: { operation: 'file', notes: 'File it.' }
		});
		expect(
			await errorOf(await open({ mission: record.id, mode: 'watch', cols: 80, rows: 24 }))
		).toMatchObject({ status: 409 });
	});

	it("does not open someone else's chat", async () => {
		const other = await mate.createChat('u2', { title: 'Theirs', scope: null, runner: 'e2b' });
		const response = await open({ chat: other.id, mode: 'watch', cols: 80, rows: 24 });
		expect(response.status).toBe(404);
	});

	it('refuses a body naming both targets, or neither', async () => {
		for (const body of [
			{ mode: 'watch', cols: 80, rows: 24 },
			{ chat: chat_id, mission: `dq_${'0'.repeat(32)}`, mode: 'watch', cols: 80, rows: 24 },
			{ chat: chat_id, mode: 'watch', cols: 80, rows: 24, sandbox: 'sbx1' }
		]) {
			expect((await open(body)).status).toBe(400);
		}
	});

	it('409s a chat whose runner has no relay', async () => {
		const { attachTerminal: _, ...without } = relayRunner();
		setMateRunner(without);
		expect(
			await errorOf(await open({ chat: chat_id, mode: 'watch', cols: 80, rows: 24 }))
		).toMatchObject({ status: 409, message: NO_CHAT_RELAY_MESSAGE });
	});

	it('409s a finished terminal and a paused sandbox, without resuming it', async () => {
		fake.state.info = { id: 'sbx1', state: 'paused', metadata: {} };
		expect(
			await errorOf(await open({ chat: chat_id, mode: 'watch', cols: 80, rows: 24 }))
		).toMatchObject({ status: 409, message: RELAY_PAUSED_MESSAGE });
		expect(fake.state.connects).toBe(0);
		expect(await audit.list('chat', chat_id, 10)).toEqual([]);

		fake.state.info = { id: 'sbx1', state: 'running', metadata: {} };
		core.exit('t1');
		expect(
			await errorOf(await open({ chat: chat_id, mode: 'watch', cols: 80, rows: 24 }))
		).toMatchObject({ status: 409, message: RELAY_FINISHED_MESSAGE });
	});

	it('streams a watch, records it, and refuses input to it', async () => {
		const response = await open({ chat: chat_id, mode: 'watch', cols: 80, rows: 24 });
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('text/event-stream');
		const stream = frames(response);
		const [first] = await stream.until((seen) => seen.length > 0);
		expect(first.event).toBe('open');
		const opened = JSON.parse(first.data) as { relay: string; mode: string };
		expect(opened.mode).toBe('watch');

		const [row] = await audit.list('chat', chat_id, 10);
		expect(row).toMatchObject({
			id: opened.relay,
			actor: ADMIN.email,
			target_kind: 'chat',
			mode: 'watch',
			ended_at: null
		});

		core.output('t1', 'agent output');
		await stream.until((seen) => output(seen).includes('agent output'));

		expect(
			await errorOf(await input(opened.relay, { data: Buffer.from('y').toString('base64') }))
		).toMatchObject({ status: 409, message: RELAY_WATCH_ONLY_MESSAGE });
		expect(core.terminal('t1').typed).toEqual([]);

		core.exit('t1', 0);
		const seen = await stream.until((all) => all.some((frame) => frame.event === 'end'));
		expect(JSON.parse(seen.at(-1)!.data)).toEqual({ reason: 'exited' });
		await expect
			.poll(async () => (await audit.list('chat', chat_id, 10))[0].end_reason)
			.toBe('exited');
	});

	it('takes over: records it, types and resizes, only from the same browser session', async () => {
		const response = await open({ chat: chat_id, mode: 'take_over', cols: 100, rows: 30 });
		const stream = frames(response);
		const [first] = await stream.until((seen) => seen.length > 0);
		const opened = JSON.parse(first.data) as { relay: string; mode: string; cols: number };
		expect(opened).toMatchObject({ mode: 'take_over', cols: 100 });
		expect((await audit.list('chat', chat_id, 10))[0].mode).toBe('take_over');

		const sent = await input(opened.relay, {
			data: Buffer.from('yes\r').toString('base64'),
			cols: 120,
			rows: 40
		});
		expect(sent.status).toBe(202);
		await expect.poll(() => core.terminal('t1').typed.length).toBe(4);
		expect(core.terminal('t1').viewer_size).toEqual({ cols: 120, rows: 40 });

		const stranger = await input(opened.relay, { data: 'eA==' }, 'another-session');
		expect(stranger.status).toBe(404);
		expect((await input(`tr_${'0'.repeat(32)}`, { data: 'eA==' })).status).toBe(404);
		expect((await input(opened.relay, { cols: 120 })).status).toBe(400);

		await stream.cancel();
		await expect
			.poll(async () => (await audit.list('chat', chat_id, 10))[0].end_reason)
			.toBe('detached');
		expect((await input(opened.relay, { data: 'eA==' })).status).toBe(404);
	});

	it('ends the relay and its audit row when the browser goes away', async () => {
		const abort = new AbortController();
		const response = await open(
			{ chat: chat_id, mode: 'watch', cols: 80, rows: 24 },
			{ signal: abort.signal }
		);
		await frames(response).until((seen) => seen.length > 0);
		abort.abort();
		await expect
			.poll(async () => (await audit.list('chat', chat_id, 10))[0].ended_at)
			.not.toBeNull();
		await expect.poll(() => core.attachments.size).toBe(0);
	});

	it('does not open a relay it cannot record', async () => {
		setTerminalRelayAuditStore({
			start: async () => {
				throw new Error('disk full');
			},
			end: async () => undefined,
			list: async () => []
		});
		const response = await open({ chat: chat_id, mode: 'take_over', cols: 80, rows: 24 });
		expect(response.status).toBe(503);
		await expect.poll(() => core.attachments.size).toBe(0);
	});
});
