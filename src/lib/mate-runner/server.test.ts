import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_LABEL } from '#lib/agent-session/session.js';
import { connectHc } from '#lib/hc/client.js';
import {
	RELAY_FINISHED_MESSAGE,
	RELAY_NOT_STARTED_MESSAGE
} from '#lib/server/terminal-relay/relay.js';
import { FakeClaude } from '#lib/test/fake-claude.js';
import type { FakeTerminal } from '#lib/test/fake-hc.js';
import { ChatStore } from './event-log.js';
import { createRunnerHandler } from './server.js';
import { CHAT_LABEL } from './session.js';
import { signRequest } from './signature.js';

const SECRET = 's'.repeat(40);
const SESSION = '6f1c2a0e-1b2c-4d3e-8f90-123456789abc';
/** Another chat's CLI session. */
const OTHER = '00000000-0000-4000-8000-000000000000';
const THIRD = '00000000-0000-4000-8000-000000000003';
const WORKDIR = '/home/agent/work';
const TIMING = { poll_ms: 5, startup_ms: 500, settle_ms: 50, turn_ms: 5_000 };

let dir: string;
let server: Server;
let base: string;
let fake: FakeClaude;
let handler: ReturnType<typeof createRunnerHandler>;
let failConnect = false;
let connects = 0;
let failDiscard = false;
let discards: string[] = [];

const later = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, ms = 2_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error('condition never held');
		await later(2);
	}
}

/** A Claude Code that echoes each message, except `hang`, which never ends its turn. */
function newFake(): FakeClaude {
	const claude = new FakeClaude({ config_dir: '/home/agent/.claude' });
	claude.onMessage = (t, text) => {
		if (text.endsWith('hang')) return;
		claude.say(`echo: ${text}`, t);
		claude.endTurn(t);
	};
	claude.core.onInterrupt = (t) => claude.core.setStatus(t.address, 'idle');
	return claude;
}

/** The live terminal of the chat with this CLI session. */
function terminalOf(session_id = SESSION): FakeTerminal {
	const found = [...fake.core.terminals.values()].filter(
		(t) => t.labels[SESSION_LABEL] === session_id && t.state === 'live'
	);
	if (found.length !== 1) throw new Error(`expected one live terminal, found ${found.length}`);
	return found[0];
}

async function start(max_live_sessions = 3): Promise<void> {
	handler = createRunnerHandler({
		secret: SECRET,
		store: new ChatStore(dir),
		connect: async () => {
			connects += 1;
			if (failConnect) {
				failConnect = false;
				throw new Error('ssh: connection refused');
			}
			return {
				client: await connectHc(fake.core.connect()),
				launch: { cwd: WORKDIR, config_dir: fake.config_dir, command: 'mate-claude' }
			};
		},
		discard: async (session_id) => {
			discards.push(session_id);
			if (failDiscard) {
				failDiscard = false;
				throw new Error('ssh: connection refused');
			}
		},
		max_live_sessions,
		heartbeat_ms: 50,
		agent: { timing: TIMING }
	});
	server = createServer((req, res) => void handler(req, res));
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Stop serving; `graceful` runs the runner's own shutdown, as SIGTERM does. */
async function shutdown(graceful: boolean): Promise<void> {
	if (graceful) await handler.close();
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
}

function signed(method: string, target: string, body = ''): RequestInit {
	const ts = String(Math.floor(Date.now() / 1000));
	return {
		method,
		headers: {
			'content-type': 'application/json',
			'x-beadsmith-timestamp': ts,
			'x-beadsmith-signature': signRequest(SECRET, ts, method, target, body)
		},
		body: body === '' ? undefined : body
	};
}

async function post(
	chat: string,
	prompt: string,
	message_id: string,
	session_id = SESSION,
	extra: Record<string, unknown> = {}
) {
	const target = `/v1/mate/chats/${chat}/messages`;
	const body = JSON.stringify({ session_id, prompt, scope: 'beads-web', message_id, ...extra });
	return fetch(`${base}${target}`, signed('POST', target, body));
}

/** Read SSE frames until `count` events arrived, then close. */
async function readEvents(chat: string, count: number, after?: string) {
	const target = `/v1/mate/chats/${chat}/events${after === undefined ? '' : `?after=${after}`}`;
	const controller = new AbortController();
	const res = await fetch(`${base}${target}`, {
		...signed('GET', target),
		signal: controller.signal
	});
	expect(res.headers.get('content-type')).toBe('text/event-stream');
	const reader = res.body!.getReader();
	const decoder = new TextDecoder();
	const events: Record<string, unknown>[] = [];
	let buffer = '';
	while (events.length < count) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let index: number;
		while ((index = buffer.indexOf('\n\n')) >= 0) {
			const frame = buffer.slice(0, index);
			buffer = buffer.slice(index + 2);
			const data = frame.split('\n').find((line) => line.startsWith('data: '));
			if (data !== undefined) events.push(JSON.parse(data.slice(6)) as Record<string, unknown>);
		}
	}
	controller.abort();
	return events;
}

beforeEach(async () => {
	failDiscard = false;
	discards = [];
	dir = mkdtempSync(join(tmpdir(), 'mate-runner-'));
	fake = newFake();
	failConnect = false;
	connects = 0;
	await start();
});

afterEach(async () => {
	await shutdown(true).catch(() => undefined);
	rmSync(dir, { recursive: true, force: true });
});

async function interrupt(chat: string) {
	const target = `/v1/mate/chats/${chat}/interrupt`;
	return fetch(`${base}${target}`, signed('POST', target));
}

describe('mate runner', () => {
	it('refuses unsigned requests', async () => {
		expect((await fetch(`${base}/v1/health`)).status).toBe(401);
		const ok = await fetch(`${base}/v1/health`, signed('GET', '/v1/health'));
		expect(await ok.json()).toEqual({ ok: true });
	});

	it('runs a turn in an hc terminal and replays it as events', async () => {
		const res = await post('chat1', 'hello', 'm1');
		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({ event_id: 'e000000001' });
		const events = await readEvents('chat1', 3);
		expect(events).toEqual([
			{ type: 'user', id: 'e000000001', text: 'hello', message_id: 'm1' },
			{ type: 'assistant', id: 'e000000002', text: 'echo: hello' },
			{
				type: 'result',
				id: 'e000000003',
				status: 'succeeded',
				text: 'echo: hello',
				duration_ms: 42
			}
		]);
		expect(await readEvents('chat1', 2, 'e000000001')).toHaveLength(2);

		const t = terminalOf();
		expect(t.argv.slice(0, 5)).toEqual([
			'mate-claude',
			'--permission-mode',
			'bypassPermissions',
			'--session-id',
			SESSION
		]);
		expect(t.argv).toContain('--append-system-prompt');
		// No model or effort asked for: the CLI's defaults.
		expect(t.argv).not.toContain('--model');
		expect(t.argv).not.toContain('--effort');
		expect(t.cwd).toBe(WORKDIR);
		expect(t.labels).toEqual({ [CHAT_LABEL]: 'chat1', [SESSION_LABEL]: SESSION });
		// The prompt is pasted into the running CLI, never put on its command line.
		expect(t.sent).toEqual(['hello']);
		expect(t.argv.join(' ')).not.toContain('hello');
	});

	it('sends a follow-up to the same running CLI', async () => {
		await post('chat1', 'one', 'm1');
		await readEvents('chat1', 3);
		await post('chat1', 'two', 'm2');
		expect((await readEvents('chat1', 6)).at(-1)).toMatchObject({ text: 'echo: two' });
		expect(fake.core.terminals.size).toBe(1);
		expect(terminalOf().sent).toEqual(['one', 'two']);
		expect(connects).toBe(1);
	});

	it('sends a retried message to the agent only once', async () => {
		await (await post('chat1', 'hello', 'm1')).json();
		const again = await post('chat1', 'hello', 'm1');
		expect(await again.json()).toEqual({ event_id: 'e000000001' });
		const events = await readEvents('chat1', 3);
		expect(events.filter((event) => event.type === 'user')).toHaveLength(1);
		expect(terminalOf().sent).toEqual(['hello']);
	});

	it('keeps one session per chat', async () => {
		await post('chat1', 'hello', 'm1');
		expect((await post('chat1', 'hi', 'm2', OTHER)).status).toBe(409);
	});

	it('queues a message sent while the agent works and sends it when the turn ends', async () => {
		await post('chat1', 'hang', 'm1');
		await until(() => terminalOf().sent.length === 1);
		expect((await post('chat1', 'next', 'm2')).status).toBe(202);
		await later(30);
		expect(terminalOf().sent).toEqual(['hang']);
		fake.say('done', terminalOf());
		fake.endTurn(terminalOf());
		const events = await readEvents('chat1', 6);
		expect(events.map((e) => e.type)).toEqual([
			'user',
			'user',
			'assistant',
			'result',
			'assistant',
			'result'
		]);
		expect(events.at(-1)).toMatchObject({ text: 'echo: next' });
		expect(terminalOf().sent).toEqual(['hang', 'next']);
	});

	it('interrupts a running turn and drops what was queued behind it', async () => {
		await post('chat1', 'hang', 'm1');
		await until(() => terminalOf().sent.length === 1);
		await post('chat1', 'never', 'm2');
		expect((await interrupt('chat1')).status).toBe(202);
		const events = await readEvents('chat1', 3);
		expect(events[2]).toMatchObject({ type: 'result', status: 'cancelled' });
		await later(30);
		expect(terminalOf().sent).toEqual(['hang']);
		expect(new ChatStore(dir).get('chat1').meta?.pending).toBe(0);
		// The CLI keeps running for the next message.
		await post('chat1', 'after', 'm3');
		expect((await readEvents('chat1', 6)).at(-1)).toMatchObject({ text: 'echo: after' });
	});

	it('resumes the CLI session in a new terminal after a runner restart', async () => {
		await post('chat1', 'one', 'm1');
		await readEvents('chat1', 3);
		const first = terminalOf();
		await shutdown(true);
		// Shutdown ends the CLI, as it ended the old headless process.
		expect(first.state).toBe('finished');
		await start();
		await post('chat1', 'two', 'm2');
		const events = await readEvents('chat1', 6);
		expect(events.at(-1)).toMatchObject({ type: 'result', text: 'echo: two' });
		const second = terminalOf();
		expect(second.argv).toContain('--resume');
		expect(second.argv).not.toContain('--session-id');
		// Earlier turns are not replayed as new events.
		expect(events.filter((e) => e.type === 'assistant')).toHaveLength(2);
	});

	it('follows a CLI that outlived a crashed runner', async () => {
		await post('chat1', 'one', 'm1');
		await readEvents('chat1', 3);
		await shutdown(false);
		await start();
		await post('chat1', 'two', 'm2');
		expect((await readEvents('chat1', 6)).at(-1)).toMatchObject({ text: 'echo: two' });
		expect(fake.core.terminals.size).toBe(1);
		expect(terminalOf().sent).toEqual(['one', 'two']);
	});

	it('reports an agent that dies mid-turn and resumes it on the next message', async () => {
		await post('chat1', 'hang', 'm1');
		await until(() => terminalOf().sent.length === 1);
		fake.core.exit(terminalOf().address, 1);
		const events = await readEvents('chat1', 3);
		expect(events[1]).toMatchObject({ type: 'error' });
		expect(events[2]).toMatchObject({ type: 'result', status: 'failed' });
		await post('chat1', 'again', 'm2');
		expect((await readEvents('chat1', 6)).at(-1)).toMatchObject({ text: 'echo: again' });
		expect(terminalOf().argv).toContain('--resume');
	});

	it('ends a turn whose channel is lost with an error', async () => {
		await post('chat1', 'hang', 'm1');
		await until(() => terminalOf().sent.length === 1);
		fake.core.disconnectAll();
		const events = await readEvents('chat1', 2);
		expect(events[1]).toMatchObject({ type: 'error', message: expect.stringMatching(/lost/) });
		expect(new ChatStore(dir).get('chat1').meta?.pending).toBe(0);
	});

	it('refuses to type into a CLI that waits for a decision', async () => {
		await post('chat1', 'one', 'm1');
		await readEvents('chat1', 3);
		fake.core.setStatus(terminalOf().address, 'blocked');
		await later(10);
		await post('chat1', 'two', 'm2');
		const events = await readEvents('chat1', 5);
		expect(events[4]).toMatchObject({ type: 'error', message: expect.stringMatching(/decision/) });
		expect(terminalOf().sent).toEqual(['one']);
	});

	it('stops the oldest idle session to stay under the cap', async () => {
		await shutdown(true);
		await start(1);
		await post('chat1', 'one', 'm1');
		await readEvents('chat1', 3);
		const first = terminalOf();
		await post('chat2', 'two', 'm2', OTHER);
		await readEvents('chat2', 3);
		expect(first.state).toBe('finished');
		await post('chat3', 'hang', 'm3', THIRD);
		await until(() => terminalOf(THIRD).sent.length === 1);
		expect((await post('chat1', 'again', 'm4')).status).toBe(503);
	});

	it('forgets a deleted chat and ends its CLI', async () => {
		await post('chat1', 'hello', 'm1');
		await readEvents('chat1', 3);
		const t = terminalOf();
		const target = '/v1/mate/chats/chat1';
		expect((await fetch(`${base}${target}`, signed('DELETE', target))).status).toBe(204);
		expect(t.state).toBe('finished');
		expect(new ChatStore(dir).get('chat1').after(undefined)).toEqual([]);
		expect(discards).toEqual([SESSION]);
		const fresh = await post('chat1', 'hi', 'm9', OTHER);
		expect(await fresh.json()).toEqual({ event_id: 'e000000001' });
	});

	it('keeps a deleted chat whose state could not be discarded, for a retry', async () => {
		await post('chat1', 'hello', 'm1');
		await readEvents('chat1', 3);
		const target = '/v1/mate/chats/chat1';
		failDiscard = true;
		const refused = await fetch(`${base}${target}`, signed('DELETE', target));
		expect(refused.status).toBe(503);
		expect(await refused.json()).toEqual({ error: expect.stringMatching(/Try again/) });
		expect(new ChatStore(dir).get('chat1').meta?.session_id).toBe(SESSION);
		expect((await fetch(`${base}${target}`, signed('DELETE', target))).status).toBe(204);
		expect(discards).toEqual([SESSION, SESSION]);
		expect(new ChatStore(dir).get('chat1').meta).toBeUndefined();
	});

	it('does not consume message ids on capacity rejection', async () => {
		await shutdown(true);
		await start(1);
		await post('busy', 'hang', 'm1');
		await until(() => terminalOf().sent.length === 1);
		expect((await post('waiting', 'hello', 'm2', OTHER)).status).toBe(503);
		fake.endTurn(terminalOf());
		await readEvents('busy', 2);
		expect((await post('waiting', 'hello', 'm2', OTHER)).status).toBe(202);
		expect((await readEvents('waiting', 3)).at(-1)).toMatchObject({
			type: 'result',
			status: 'succeeded'
		});
	});

	it('reports an agent that cannot start, and starts it on the next message', async () => {
		failConnect = true;
		expect((await post('chat1', 'hello', 'm1')).status).toBe(202);
		const events = await readEvents('chat1', 2);
		expect(events[1]).toMatchObject({ type: 'error', message: expect.stringMatching(/start/) });
		expect(JSON.stringify(events)).not.toContain('ssh');
		await post('chat1', 'hello', 'm2');
		expect((await readEvents('chat1', 4)).at(-1)).toMatchObject({ status: 'succeeded' });
	});

	it('applies changed scope to the next message in the existing session', async () => {
		await post('chat1', 'hello', 'm1');
		await readEvents('chat1', 3);
		const target = '/v1/mate/chats/chat1/messages';
		const body = JSON.stringify({
			session_id: SESSION,
			message_id: 'm2',
			prompt: 'next',
			scope: 'd_other_project'
		});
		expect((await fetch(`${base}${target}`, signed('POST', target, body))).status).toBe(202);
		const events = await readEvents('chat1', 6);
		expect(events.at(-1)?.text).toContain('other_project');
		expect(terminalOf().sent[1]).toMatch(/other_project[\s\S]*next$/);
		expect(fake.core.terminals.size).toBe(1);
		expect(new ChatStore(dir).get('chat1').meta?.scope).toBe('d_other_project');
	});

	it('preserves an omitted project scope and clears it only on explicit null', async () => {
		await post('chat1', 'hello', 'm1');
		await readEvents('chat1', 3);
		const target = '/v1/mate/chats/chat1/messages';
		const omitted = JSON.stringify({ session_id: SESSION, message_id: 'm2', prompt: 'next' });
		expect((await fetch(`${base}${target}`, signed('POST', target, omitted))).status).toBe(202);
		expect((await readEvents('chat1', 6)).at(-1)?.text).toBe('echo: next');
		expect(new ChatStore(dir).get('chat1').meta?.scope).toBe('beads-web');

		const cleared = JSON.stringify({
			session_id: SESSION,
			message_id: 'm3',
			prompt: 'all',
			scope: null
		});
		expect((await fetch(`${base}${target}`, signed('POST', target, cleared))).status).toBe(202);
		expect((await readEvents('chat1', 9)).at(-1)?.text).toContain('every available Beads project');
		expect(new ChatStore(dir).get('chat1').meta?.scope).toBeNull();
		expect(fake.core.terminals.size).toBe(1);
	});

	it('stops active sessions on shutdown and refuses new requests', async () => {
		await post('chat1', 'hang', 'm1');
		await until(() => terminalOf().sent.length === 1);
		const t = terminalOf();
		await handler.close();
		expect(t.state).toBe('finished');
		expect((await post('chat2', 'hello', 'm2', OTHER)).status).toBe(503);
	});

	it('launches with the chat model and effort, and keeps them across a resume', async () => {
		const choice = { model: 'claude-opus-5-5', effort: 'high' };
		expect((await post('chat1', 'one', 'm1', SESSION, choice)).status).toBe(202);
		await readEvents('chat1', 3);
		const argv = terminalOf().argv.join(' ');
		expect(argv).toContain('--model claude-opus-5-5');
		expect(argv).toContain('--effort high');

		await shutdown(true);
		await start();
		expect((await post('chat1', 'two', 'm2', SESSION, choice)).status).toBe(202);
		await readEvents('chat1', 6);
		const resumed = terminalOf().argv;
		expect(resumed).toContain('--resume');
		expect(resumed.join(' ')).toContain('--model claude-opus-5-5');
		expect(resumed.join(' ')).toContain('--effort high');
	});

	it('refuses a model or effort that is not a name, or that changes mid-chat', async () => {
		expect((await post('chat1', 'hi', 'm1', SESSION, { model: '--dangerous' })).status).toBe(400);
		expect((await post('chat1', 'hi', 'm1', SESSION, { model: 7 })).status).toBe(400);
		expect((await post('chat1', 'hi', 'm1', SESSION, { effort: 'High Effort' })).status).toBe(400);
		// Nothing was recorded for the refused messages.
		expect((await post('chat1', 'hi', 'm1', SESSION, { model: 'sonnet' })).status).toBe(202);
		expect((await post('chat1', 'next', 'm2', SESSION, { model: 'opus' })).status).toBe(409);
		expect((await post('chat1', 'next', 'm2', SESSION)).status).toBe(409);
		expect(
			(await post('chat1', 'next', 'm2', SESSION, { effort: 'low', model: 'sonnet' })).status
		).toBe(409);
		expect((await post('chat1', 'next', 'm2', SESSION, { model: 'sonnet' })).status).toBe(202);
	});

	it('rejects reuse of an id for a different message', async () => {
		await post('chat1', 'one', 'm1');
		expect((await post('chat1', 'two', 'm1')).status).toBe(409);
	});

	it('rejects bad input', async () => {
		expect((await post('chat1', '', 'm1')).status).toBe(400);
		expect((await post('chat1', 'hi', 'bad id!')).status).toBe(400);
		expect((await post('chat1', 'hi', 'm1', 'not-a-uuid')).status).toBe(400);
		expect((await post('chat1', 'hi', 'm1', SESSION.toUpperCase())).status).toBe(400);
		const target = '/v1/mate/chats/bad.id/messages';
		expect((await fetch(`${base}${target}`, signed('POST', target, '{}'))).status).toBe(400);
	});
});

describe('terminal attach', () => {
	interface Frame {
		event: string;
		data: string;
	}

	/** Open the chat's terminal and read its SSE frames as they come. */
	async function attach(chat: string, mode: 'watch' | 'take_over', body?: string) {
		const target = `/v1/mate/chats/${chat}/terminal`;
		const controller = new AbortController();
		const res = await fetch(`${base}${target}`, {
			...signed('POST', target, body ?? JSON.stringify({ mode, cols: 80, rows: 24 })),
			signal: controller.signal
		});
		const frames: Frame[] = [];
		let ended = false;
		if (res.ok) {
			void (async () => {
				const reader = res.body!.getReader();
				const decoder = new TextDecoder();
				let buffer = '';
				try {
					for (;;) {
						const { value, done } = await reader.read();
						if (done) break;
						buffer += decoder.decode(value, { stream: true });
						let index: number;
						while ((index = buffer.indexOf('\n\n')) >= 0) {
							const lines = buffer.slice(0, index).split('\n');
							buffer = buffer.slice(index + 2);
							const event = lines.find((l) => l.startsWith('event: '))?.slice(7);
							const data = lines.find((l) => l.startsWith('data: '))?.slice(6);
							if (event !== undefined) frames.push({ event, data: data ?? '' });
						}
					}
				} catch {
					// Aborted.
				}
				ended = true;
			})();
		}
		return { res, frames, ended: () => ended, close: () => controller.abort() };
	}

	const output = (frames: Frame[]) =>
		frames
			.filter((f) => f.event === 'output')
			.map((f) => Buffer.from(f.data, 'base64').toString())
			.join('');

	async function input(chat: string, attach_id: string, body: unknown) {
		const target = `/v1/mate/chats/${chat}/terminal/${attach_id}`;
		return fetch(`${base}${target}`, signed('POST', target, JSON.stringify(body)));
	}

	async function started(): Promise<FakeTerminal> {
		await post('chat1', 'hello', 'm1');
		await readEvents('chat1', 3);
		return terminalOf();
	}

	it('refuses unsigned attaches and input', async () => {
		await started();
		const res = await fetch(`${base}/v1/mate/chats/chat1/terminal`, {
			method: 'POST',
			body: JSON.stringify({ mode: 'watch', cols: 80, rows: 24 })
		});
		expect(res.status).toBe(401);
		const typed = await fetch(`${base}/v1/mate/chats/chat1/terminal/ta_${'0'.repeat(32)}`, {
			method: 'POST',
			body: JSON.stringify({ data: 'eQ==' })
		});
		expect(typed.status).toBe(401);
	});

	it('watches the chat terminal over its own hc connection, and refuses input', async () => {
		const t = await started();
		const before = connects;
		const channels = fake.core.connections.size;
		const watch = await attach('chat1', 'watch');
		expect(watch.res.status).toBe(200);
		expect(watch.res.headers.get('content-type')).toBe('text/event-stream');
		await expect.poll(() => watch.frames.length).toBeGreaterThan(0);
		const open = JSON.parse(watch.frames[0]!.data) as { attach: string; mode: string };
		expect(watch.frames[0]!.event).toBe('open');
		expect(open).toMatchObject({ mode: 'watch' });
		expect(open.attach).toMatch(/^ta_[a-f0-9]{32}$/);
		expect(connects).toBe(before + 1);
		const call = fake.core.calls.findLast((c) => c.method === 'terminal.attach');
		expect(call?.params).toMatchObject({ terminal: t.address, observe: true });

		fake.core.output(t.address, 'thinking…');
		await expect.poll(() => output(watch.frames)).toContain('thinking…');
		const refused = await input('chat1', open.attach, { data: 'eQ==' });
		expect(refused.status).toBe(409);
		expect(t.typed).toEqual([]);
		// Another chat cannot name this attach.
		expect((await input('chat2', open.attach, { data: 'eQ==' })).status).toBe(404);

		watch.close();
		// The attach's own connection goes; the chat keeps its channel.
		await expect.poll(() => fake.core.connections.size).toBe(channels);
		// The chat itself still works.
		expect((await post('chat1', 'again', 'm2')).status).toBe(202);
	});

	it('takes over: types and resizes the terminal from the attach it opened', async () => {
		const t = await started();
		const take = await attach('chat1', 'take_over');
		await expect.poll(() => take.frames.length).toBeGreaterThan(0);
		const { attach: id } = JSON.parse(take.frames[0]!.data) as { attach: string };
		const res = await input('chat1', id, {
			data: Buffer.from('y\r').toString('base64'),
			cols: 100,
			rows: 30
		});
		expect(res.status).toBe(204);
		await expect.poll(() => t.typed.length).toBeGreaterThan(0);
		expect(Buffer.from(t.typed).toString()).toBe('y\r');
		expect(t.viewer_size).toEqual({ cols: 100, rows: 30 });
		expect((await input('chat1', id, { data: 'not base64!' })).status).toBe(400);
		expect((await input('chat1', id, { cols: 100 })).status).toBe(400);
		take.close();
	});

	it('ends with the program and closes the stream', async () => {
		const t = await started();
		const watch = await attach('chat1', 'watch');
		await expect.poll(() => watch.frames.length).toBeGreaterThan(0);
		fake.core.exit(t.address, 0);
		await expect.poll(() => watch.ended()).toBe(true);
		expect(watch.frames.at(-1)).toEqual({
			event: 'end',
			data: JSON.stringify({ reason: 'exited' })
		});
	});

	it('refuses a chat with no agent, a finished terminal, a lost guest and bad input', async () => {
		const none = await attach('chat9', 'watch');
		expect(none.res.status).toBe(409);
		expect(await none.res.json()).toEqual({ error: RELAY_NOT_STARTED_MESSAGE });

		const t = await started();
		fake.core.exit(t.address, 0);
		const finished = await attach('chat1', 'watch');
		expect(finished.res.status).toBe(409);
		expect(await finished.res.json()).toEqual({ error: RELAY_FINISHED_MESSAGE });

		failConnect = true;
		const lost = await attach('chat1', 'watch');
		expect(lost.res.status).toBe(503);

		expect((await attach('chat1', 'watch', '{"mode":"peek","cols":80,"rows":24}')).res.status).toBe(
			400
		);
		expect((await attach('chat1', 'watch', '{"mode":"watch","cols":0,"rows":24}')).res.status).toBe(
			400
		);
		expect((await input('chat1', `ta_${'0'.repeat(32)}`, { data: '' })).status).toBe(404);
	});

	it('closes open attaches on shutdown', async () => {
		await started();
		const watch = await attach('chat1', 'watch');
		await expect.poll(() => watch.frames.length).toBeGreaterThan(0);
		await handler.close();
		await expect.poll(() => watch.ended()).toBe(true);
	});
});
