import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatStore } from './event-log.js';
import { createRunnerHandler } from './server.js';
import type { AgentLaunch, AgentProcess } from './session.js';
import { signRequest } from './signature.js';

const SECRET = 's'.repeat(40);
const SESSION = '6f1c2a0e-1b2c-4d3e-8f90-123456789abc';

/** A stand-in for Claude Code: answers each user line with a short turn. */
class FakeAgent implements AgentProcess {
	stdin = new PassThrough();
	stdout = new PassThrough();
	stderr = new PassThrough();
	killed = false;
	readonly #exit: ((code: number | null) => void)[] = [];

	constructor(readonly launch: AgentLaunch) {
		this.stdout.write(
			`${JSON.stringify({ type: 'system', subtype: 'init', session_id: launch.session_id })}\n`
		);
		createInterface({ input: this.stdin }).on('line', (line) => {
			const input = JSON.parse(line) as { type: string; message?: { content: { text: string }[] } };
			if (input.type === 'control_request') {
				this.emit({ type: 'result', subtype: 'error_during_execution', is_error: true });
				return;
			}
			const text = input.message?.content[0]?.text ?? '';
			if (text === 'hang') return;
			this.emit({
				type: 'assistant',
				message: { content: [{ type: 'text', text: `echo: ${text}` }] }
			});
			this.emit({
				type: 'result',
				subtype: 'success',
				is_error: false,
				result: `echo: ${text}`,
				duration_ms: 5
			});
		});
		this.stdin.on('finish', () => this.exit(0));
	}

	emit(line: unknown): void {
		this.stdout.write(`${JSON.stringify(line)}\n`);
	}

	exit(code: number | null): void {
		for (const listener of this.#exit.splice(0)) listener(code);
	}

	kill(): boolean {
		this.killed = true;
		this.exit(null);
		return true;
	}

	once(_event: 'exit', listener: (code: number | null) => void): unknown {
		this.#exit.push(listener);
		return this;
	}
}

let dir: string;
let server: Server;
let base: string;
let agents: FakeAgent[];

async function start(max_live_sessions = 3): Promise<void> {
	agents = [];
	const handler = createRunnerHandler({
		secret: SECRET,
		store: new ChatStore(dir),
		spawn: (launch) => {
			const agent = new FakeAgent(launch);
			agents.push(agent);
			return agent;
		},
		max_live_sessions,
		heartbeat_ms: 50
	});
	server = createServer((req, res) => void handler(req, res));
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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

async function post(chat: string, prompt: string, message_id: string, session_id = SESSION) {
	const target = `/v1/mate/chats/${chat}/messages`;
	const body = JSON.stringify({ session_id, prompt, scope: 'beads-web', message_id });
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
	dir = mkdtempSync(join(tmpdir(), 'mate-runner-'));
	await start();
});

afterEach(async () => {
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	rmSync(dir, { recursive: true, force: true });
});

describe('mate runner', () => {
	it('refuses unsigned requests', async () => {
		expect((await fetch(`${base}/v1/health`)).status).toBe(401);
		const ok = await fetch(`${base}/v1/health`, signed('GET', '/v1/health'));
		expect(await ok.json()).toEqual({ ok: true });
	});

	it('runs a turn and replays it as events', async () => {
		const res = await post('chat1', 'hello', 'm1');
		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({ event_id: 'e000000001' });
		const events = await readEvents('chat1', 3);
		expect(events).toEqual([
			{ type: 'user', id: 'e000000001', text: 'hello' },
			{ type: 'assistant', id: 'e000000002', text: 'echo: hello' },
			{ type: 'result', id: 'e000000003', status: 'succeeded', text: 'echo: hello', duration_ms: 5 }
		]);
		expect(agents[0]?.launch).toEqual({ session_id: SESSION, resume: false, scope: 'beads-web' });
		expect(await readEvents('chat1', 2, 'e000000001')).toHaveLength(2);
	});

	it('sends a retried message to the agent only once', async () => {
		await (await post('chat1', 'hello', 'm1')).json();
		const again = await post('chat1', 'hello', 'm1');
		expect(await again.json()).toEqual({ event_id: 'e000000001' });
		const events = await readEvents('chat1', 3);
		expect(events.filter((event) => event.type === 'user')).toHaveLength(1);
	});

	it('keeps one session per chat', async () => {
		await post('chat1', 'hello', 'm1');
		const other = await post('chat1', 'hi', 'm2', '00000000-0000-4000-8000-000000000000');
		expect(other.status).toBe(409);
	});

	it('interrupts a running turn', async () => {
		await post('chat1', 'hang', 'm1');
		const target = '/v1/mate/chats/chat1/interrupt';
		await readEvents('chat1', 1);
		expect((await fetch(`${base}${target}`, signed('POST', target))).status).toBe(202);
		const events = await readEvents('chat1', 2);
		expect(events[1]).toMatchObject({ type: 'result', status: 'cancelled' });
	});

	it('resumes the session in a new process after a restart', async () => {
		await post('chat1', 'one', 'm1');
		await readEvents('chat1', 3);
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
		await start();
		await post('chat1', 'two', 'm2');
		const events = await readEvents('chat1', 6);
		expect(events.at(-1)).toMatchObject({ type: 'result', text: 'echo: two' });
		expect(agents[0]?.launch.resume).toBe(true);
	});

	it('reports an agent that dies mid-turn', async () => {
		await post('chat1', 'hang', 'm1');
		await readEvents('chat1', 1);
		agents[0]?.exit(1);
		const events = await readEvents('chat1', 2);
		expect(events[1]).toMatchObject({ type: 'error' });
	});

	it('stops the oldest idle session to stay under the cap', async () => {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
		await start(1);
		await post('chat1', 'one', 'm1');
		await readEvents('chat1', 3);
		await post('chat2', 'two', 'm2');
		await readEvents('chat2', 3);
		expect(agents).toHaveLength(2);
		await post('chat3', 'hang', 'm3');
		await readEvents('chat3', 1);
		const busy = await post('chat1', 'again', 'm4');
		expect(busy.status).toBe(503);
	});

	it('forgets a deleted chat', async () => {
		await post('chat1', 'hello', 'm1');
		await readEvents('chat1', 3);
		const target = '/v1/mate/chats/chat1';
		expect((await fetch(`${base}${target}`, signed('DELETE', target))).status).toBe(204);
		const fresh = await post('chat1', 'hi', 'm9', '00000000-0000-4000-8000-000000000000');
		expect(await fresh.json()).toEqual({ event_id: 'e000000001' });
	});

	it('rejects bad input', async () => {
		expect((await post('chat1', '', 'm1')).status).toBe(400);
		expect((await post('chat1', 'hi', 'bad id!')).status).toBe(400);
		expect((await post('chat1', 'hi', 'm1', 'not-a-uuid')).status).toBe(400);
		const target = '/v1/mate/chats/bad.id/messages';
		expect((await fetch(`${base}${target}`, signed('POST', target, '{}'))).status).toBe(400);
	});
});
