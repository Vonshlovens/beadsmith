import { describe, expect, it } from 'vitest';
import type { MissionEvent } from '#lib/mission-events.js';
import { signWebhookRequest } from '../dispatch/webhook-provider.js';
import { readEnv } from '../env.js';
import {
	createFakeMateRunner,
	FAKE_RUNNER_SECRET,
	FAKE_RUNNER_URL
} from '#lib/test/fake-mate-runner.js';
import {
	configuredMateRunners,
	createMateRunner,
	MATE_RUNNER_TERMINAL,
	MateRunnerError,
	readSseStream,
	resolveMateRunnerSecret,
	toMateEvent,
	type SseFrame
} from './runner.js';

const env = readEnv({
	BDX_MATE_RUNNER_URL: FAKE_RUNNER_URL,
	BDX_MATE_RUNNER_SECRET: FAKE_RUNNER_SECRET
});
const NOW = new Date('2026-11-05T12:00:00Z');

function runnerWith(fetch_impl: typeof fetch, extra: { idle_timeout_ms?: number } = {}) {
	const runner = createMateRunner({
		server_env: env,
		fetch: fetch_impl,
		secret: FAKE_RUNNER_SECRET,
		now: () => NOW,
		...extra
	});
	if (runner === undefined) throw new Error('runner not configured');
	return runner;
}

function body(text: string): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		}
	});
}

describe('env', () => {
	it('needs a valid URL and a secret', () => {
		expect(readEnv({}).mate_runner_url).toBeUndefined();
		expect(readEnv({}).mate_runner_error).toBeUndefined();
		expect(env.mate_runner_url).toBe(FAKE_RUNNER_URL);
		expect(readEnv({ BDX_MATE_RUNNER_URL: FAKE_RUNNER_URL }).mate_runner_error).toBe(
			'secret_missing'
		);
		const plain = readEnv({
			BDX_MATE_RUNNER_URL: 'http://runner.example.com',
			BDX_MATE_RUNNER_SECRET: FAKE_RUNNER_SECRET
		});
		expect(plain.mate_runner_url).toBeUndefined();
		expect(plain.mate_runner_error).toBe('url_invalid');
		expect(
			readEnv({
				BDX_MATE_RUNNER_URL: 'http://127.0.0.1:8787',
				BDX_MATE_RUNNER_SECRET_FILE: '/run/secrets/mate'
			}).mate_runner_url
		).toBe('http://127.0.0.1:8787');
		expect(createMateRunner({ server_env: readEnv({}) })).toBeUndefined();
	});

	it('refuses a short or unreadable secret', () => {
		expect(() => resolveMateRunnerSecret({ BDX_MATE_RUNNER_SECRET: 'short' })).toThrow(
			MateRunnerError
		);
		expect(() =>
			resolveMateRunnerSecret({ BDX_MATE_RUNNER_SECRET_FILE: '/nonexistent/mate-secret' })
		).toThrow('could not be read');
		expect(resolveMateRunnerSecret({ BDX_MATE_RUNNER_SECRET: ` ${FAKE_RUNNER_SECRET} ` })).toBe(
			FAKE_RUNNER_SECRET
		);
	});
});

describe('signing', () => {
	it('signs the full target, query included, with the contract header', async () => {
		const fake = createFakeMateRunner();
		const runner = runnerWith(fake.fetch);
		fake.end_after_replay = true;
		await runner.streamEvents('mc_1', 'e000007', () => {}, new AbortController().signal);
		const request = fake.requests.at(-1)!;
		expect(request.target).toBe('/base/v1/mate/chats/mc_1/events?after=e000007');
		expect(request.headers.get('accept')).toBe('text/event-stream');
		expect(request.headers.get('x-beadsmith-contract')).toBe('1');
		expect(request.headers.get('x-beadsmith-timestamp')).toBe(String(NOW.getTime() / 1000));
		expect(request.headers.get('x-beadsmith-signature')).toBe(
			await signWebhookRequest(
				FAKE_RUNNER_SECRET,
				String(NOW.getTime() / 1000),
				'GET',
				'/base/v1/mate/chats/mc_1/events?after=e000007',
				''
			)
		);
	});

	it('sends a message with its body signed and dedupes on message_id', async () => {
		const fake = createFakeMateRunner();
		const runner = runnerWith(fake.fetch);
		const input = {
			session_id: '6f1c1f4e-0000-4000-8000-000000000000',
			message_id: 'msg-1',
			prompt: 'what is ready?',
			scope: 'd_beads_web'
		};
		const first = await runner.sendMessage('mc_1', input);
		const again = await runner.sendMessage('mc_1', input);
		expect(first.event_id).toBe('e000001');
		expect(again.event_id).toBe('e000001');
		expect(fake.events('mc_1')).toHaveLength(1);
		const request = fake.requests[0]!;
		expect(request.method).toBe('POST');
		expect(request.target).toBe('/base/v1/mate/chats/mc_1/messages');
		expect(request.headers.get('content-type')).toBe('application/json');
		expect(JSON.parse(request.body)).toEqual(input);
		expect(fake.sessionOf('mc_1')).toBe(input.session_id);
	});

	it('a wrong secret is refused by the runner', async () => {
		const fake = createFakeMateRunner('another-secret-that-is-long-enough-000');
		const runner = runnerWith(fake.fetch);
		await expect(
			runner.sendMessage('mc_1', { session_id: 's', message_id: 'm', prompt: 'p', scope: null })
		).rejects.toThrow('HTTP 401');
	});
});

describe('errors', () => {
	const input = { session_id: 's', message_id: 'm', prompt: 'p', scope: null };

	it('maps 404, 409 and others, keeping the runner message but never the secret', async () => {
		const fake = createFakeMateRunner();
		const runner = runnerWith(fake.fetch);
		fake.failNext('/messages', 404, { error: 'unknown chat' });
		await expect(runner.sendMessage('mc_1', input)).rejects.toMatchObject({
			code: 'not_found',
			message: 'The mate runner refused to take the message (HTTP 404): unknown chat'
		});
		fake.failNext('/messages', 409, { error: 'busy' });
		await expect(runner.sendMessage('mc_1', input)).rejects.toMatchObject({ code: 'conflict' });
		fake.failNext('/messages', 500, { error: `oops ${FAKE_RUNNER_SECRET}` });
		const error = await runner.sendMessage('mc_1', input).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(MateRunnerError);
		expect((error as Error).message).toContain('[redacted]');
		expect((error as Error).message).not.toContain(FAKE_RUNNER_SECRET);
		fake.failNext('/messages', 502);
		await expect(runner.sendMessage('mc_1', input)).rejects.toMatchObject({
			code: 'unavailable',
			message: 'The mate runner refused to take the message (HTTP 502).'
		});
	});

	it('reports an unreachable runner without driver detail', async () => {
		const runner = runnerWith(async () => {
			throw new Error('connect ECONNREFUSED 10.0.0.1:443');
		});
		await expect(runner.sendMessage('mc_1', input)).rejects.toThrow(
			'The mate runner could not be reached.'
		);
		expect(await runner.health()).toBe(false);
	});

	it('requires a valid event_id on 202', async () => {
		const runner = runnerWith(async () => new Response('{"event_id":"bad id!"}', { status: 202 }));
		await expect(runner.sendMessage('mc_1', input)).rejects.toThrow('no valid event_id');
	});

	it('tolerates deleting a chat the runner never knew', async () => {
		const runner = runnerWith(async () => new Response('{"error":"nope"}', { status: 404 }));
		await expect(runner.deleteChat('mc_1')).resolves.toBeUndefined();
		const failing = runnerWith(async () => new Response('{}', { status: 500 }));
		await expect(failing.deleteChat('mc_1')).rejects.toThrow('HTTP 500');
	});

	it('interrupts and checks health', async () => {
		const fake = createFakeMateRunner();
		const runner = runnerWith(fake.fetch);
		await runner.interrupt('mc_1');
		expect(fake.interrupts).toEqual(['mc_1']);
		expect(await runner.health()).toBe(true);
		expect(fake.requests.at(-1)!.target).toBe('/base/v1/health');
	});
});

describe('readSseStream', () => {
	it('parses frames, multi-line data, CRLF, and skips heartbeats', async () => {
		const frames: SseFrame[] = [];
		let activity = 0;
		await readSseStream(
			body(
				': ping\n\nid: e1\nevent: assistant\ndata: {"a":\ndata: 1}\n\r\nid: e2\r\ndata: x\r\n\r\n'
			),
			(frame) => {
				frames.push(frame);
			},
			() => {
				activity += 1;
			}
		);
		expect(frames).toEqual([
			{ id: 'e1', event: 'assistant', data: '{"a":\n1}' },
			{ id: 'e2', data: 'x' }
		]);
		expect(activity).toBeGreaterThan(0);
	});

	it('handles frames split across chunks', async () => {
		const chunks = ['id: e1\nda', 'ta: hel', 'lo\r', '\n\r\n'];
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
				controller.close();
			}
		});
		const frames: SseFrame[] = [];
		await readSseStream(stream, (frame) => {
			frames.push(frame);
		});
		expect(frames).toEqual([{ id: 'e1', data: 'hello' }]);
	});
});

describe('toMateEvent', () => {
	it('preserves user correlation and strips a credential from that field', () => {
		const user = { type: 'user', id: 'e1', text: 'hello' };
		expect(
			toMateEvent({ data: JSON.stringify({ ...user, message_id: 'message-1' }) }, 'secret')
		).toEqual({ ...user, message_id: 'message-1' });
		expect(
			toMateEvent({ data: JSON.stringify({ ...user, message_id: 'secret' }) }, 'secret')
		).toEqual(user);
	});

	it('drops anything that is not a MissionEvent', () => {
		expect(toMateEvent({ data: 'not json' }, '')).toBeUndefined();
		expect(toMateEvent({ data: '{"type":"shell","id":"e1"}' }, '')).toBeUndefined();
		expect(
			toMateEvent({ data: '{"type":"tool_call","id":"e1","call_id":"c","name":"rm -rf"}' }, '')
		).toBeUndefined();
	});

	it('takes the SSE id, strips unknown keys, redacts the secret, and checks PR links', () => {
		const assistant = toMateEvent(
			{
				id: 'e9',
				data: JSON.stringify({ type: 'assistant', id: 'x1', text: `hi ${'s'.repeat(40)}`, raw: 1 })
			},
			's'.repeat(40)
		);
		expect(assistant).toEqual({ type: 'assistant', id: 'e9', text: 'hi [redacted]' });
		const result = toMateEvent(
			{
				data: JSON.stringify({
					type: 'result',
					id: 'e10',
					status: 'succeeded',
					git_pr_url: 'javascript:alert(1)',
					duration_ms: -1
				})
			},
			''
		);
		expect(result).toEqual({ type: 'result', id: 'e10', status: 'succeeded' });
		const pr = toMateEvent(
			{
				data: JSON.stringify({
					type: 'result',
					id: 'e11',
					status: 'succeeded',
					git_pr_url: 'https://github.com/o/r/pull/7',
					duration_ms: 1200
				})
			},
			''
		) as Extract<MissionEvent, { type: 'result' }>;
		expect(pr.git_pr_url).toBe('https://github.com/o/r/pull/7');
		expect(pr.duration_ms).toBe(1200);
	});
});

describe('streamEvents', () => {
	it('replays after the cursor, follows live, and stops on abort', async () => {
		const fake = createFakeMateRunner();
		const runner = runnerWith(fake.fetch);
		fake.emit('mc_1', { type: 'assistant', text: 'one' });
		const first = fake.emit('mc_1', { type: 'assistant', text: 'two' });
		const seen: MissionEvent[] = [];
		const ac = new AbortController();
		const done = runner.streamEvents(
			'mc_1',
			undefined,
			(event) => {
				seen.push(event);
				if (seen.length === 3) ac.abort();
			},
			ac.signal
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		fake.emit('mc_1', { type: 'result', status: 'succeeded' });
		expect(await done).toBe('aborted');
		expect(seen.map((event) => event.type)).toEqual(['assistant', 'assistant', 'result']);
		expect(fake.listeners('mc_1')).toBe(0);

		fake.end_after_replay = true;
		const later: string[] = [];
		expect(
			await runner.streamEvents(
				'mc_1',
				first,
				(e) => void later.push(e.id),
				new AbortController().signal
			)
		).toBe('ended');
		expect(later).toEqual(['e000003']);
	});

	it('gives up on a silent stream', async () => {
		const fake = createFakeMateRunner();
		const runner = runnerWith(fake.fetch, { idle_timeout_ms: 20 });
		const outcome = await runner.streamEvents(
			'mc_1',
			undefined,
			() => {},
			new AbortController().signal
		);
		expect(outcome).toBe('ended');
		expect(fake.listeners('mc_1')).toBe(0);
	});

	it('throws a mapped error when the runner refuses the stream', async () => {
		const fake = createFakeMateRunner();
		const runner = runnerWith(fake.fetch);
		fake.failNext('/events', 404, { error: 'unknown chat' });
		await expect(
			runner.streamEvents('mc_1', undefined, () => {}, new AbortController().signal)
		).rejects.toMatchObject({ code: 'not_found' });
	});
});

describe('MATE_RUNNER_TERMINAL', () => {
	it('offers a terminal only for runners that implement attachTerminal', () => {
		// The Sand runner's attach is covered in e2b-runner.test.ts.
		expect(runnerWith(fetch).attachTerminal).toBeUndefined();
		expect(MATE_RUNNER_TERMINAL).toEqual({ remote: false, e2b: true });
		expect(configuredMateRunners(env)).toEqual([
			{ id: 'remote', label: expect.any(String), terminal: false }
		]);
	});
});
