import { describe, expect, it } from 'vitest';
import {
	ADMIN_ONLY_MESSAGE,
	clampSize,
	decodeRelayFrame,
	fromBase64,
	LOST_MESSAGE,
	RECONNECT_DELAYS_MS,
	RelayConnection,
	relayReducer,
	relayView,
	SseParser,
	toBase64,
	type RelayState
} from './terminal-relay.js';

const RELAY = `tr_${'a'.repeat(32)}`;
const encoder = new TextEncoder();

describe('SseParser', () => {
	it('splits messages across chunks, skips comments and joins data lines', () => {
		const parser = new SseParser();
		expect(parser.push('event: open\ndata: {"a"')).toEqual([]);
		expect(parser.push(':1}\n\n: keepalive\n\nevent: x\r\ndata: one\r\ndata: two\r\n\r')).toEqual([
			{ event: 'open', data: '{"a":1}' }
		]);
		expect(parser.push('\ndata:bare\n\n')).toEqual([
			{ event: 'x', data: 'one\ntwo' },
			{ event: 'message', data: 'bare' }
		]);
	});
});

describe('decodeRelayFrame', () => {
	it('decodes each frame and refuses malformed ones', () => {
		expect(
			decodeRelayFrame({
				event: 'open',
				data: JSON.stringify({ relay: RELAY, mode: 'watch', cols: 80, rows: 24 })
			})
		).toEqual({ event: 'open', relay: RELAY, mode: 'watch', cols: 80, rows: 24 });
		expect(decodeRelayFrame({ event: 'output', data: toBase64(encoder.encode('hi')) })).toEqual({
			event: 'output',
			bytes: encoder.encode('hi')
		});
		expect(decodeRelayFrame({ event: 'resize', data: '{"cols":100,"rows":30}' })).toEqual({
			event: 'resize',
			cols: 100,
			rows: 30
		});
		expect(decodeRelayFrame({ event: 'end', data: '{"reason":"exited"}' })).toEqual({
			event: 'end',
			reason: 'exited'
		});
		expect(decodeRelayFrame({ event: 'open', data: '{"relay":1}' })).toBeNull();
		expect(decodeRelayFrame({ event: 'resize', data: '{"cols":0,"rows":30}' })).toBeNull();
		expect(decodeRelayFrame({ event: 'end', data: 'not json' })).toBeNull();
		expect(decodeRelayFrame({ event: 'mystery', data: '{}' })).toBeNull();
	});

	it('round-trips binary bytes through base64', () => {
		const bytes = new Uint8Array(70_000).map((_, i) => i % 256);
		expect(fromBase64(toBase64(bytes))).toEqual(bytes);
	});

	it('clamps a measured grid to what the server accepts', () => {
		expect(clampSize({ cols: 0, rows: 5000 })).toEqual({ cols: 1, rows: 1000 });
		expect(clampSize({ cols: 80.7, rows: Number.NaN })).toEqual({ cols: 80, rows: 1 });
	});
});

const open = (mode: 'watch' | 'take_over' = 'watch') => ({
	type: 'frame' as const,
	frame: { event: 'open' as const, relay: RELAY, mode, cols: 80, rows: 24 }
});

describe('relayReducer', () => {
	it('goes idle → connecting → live → ended', () => {
		let state: RelayState = { phase: 'idle' };
		state = relayReducer(state, { type: 'open', mode: 'watch' });
		expect(state).toEqual({ phase: 'connecting', mode: 'watch', attempt: 0 });
		state = relayReducer(state, open());
		expect(state).toMatchObject({ phase: 'live', mode: 'watch', size: { cols: 80, rows: 24 } });
		state = relayReducer(state, { type: 'frame', frame: { event: 'resize', cols: 120, rows: 40 } });
		expect(state).toMatchObject({ phase: 'live', size: { cols: 120, rows: 40 } });
		state = relayReducer(state, { type: 'frame', frame: { event: 'end', reason: 'exited' } });
		expect(state).toEqual({ phase: 'ended', mode: 'watch', reason: 'exited' });
	});

	it('reconnects a lost relay with backoff, then gives up', () => {
		let state: RelayState = relayReducer(
			relayReducer({ phase: 'idle' }, { type: 'open', mode: 'take_over' }),
			open('take_over')
		);
		state = relayReducer(state, { type: 'frame', frame: { event: 'end', reason: 'disconnected' } });
		expect(state).toEqual({
			phase: 'reconnecting',
			mode: 'take_over',
			attempt: 1,
			delay_ms: RECONNECT_DELAYS_MS[0]
		});
		for (let attempt = 1; attempt < RECONNECT_DELAYS_MS.length; attempt += 1) {
			state = relayReducer({ phase: 'connecting', mode: 'take_over', attempt }, { type: 'lost' });
			expect(state).toMatchObject({ phase: 'reconnecting', attempt: attempt + 1 });
		}
		state = relayReducer(
			{ phase: 'connecting', mode: 'take_over', attempt: RECONNECT_DELAYS_MS.length },
			{ type: 'lost' }
		);
		expect(state).toEqual({ phase: 'unavailable', message: LOST_MESSAGE, retry: true });
	});

	it('turns refusals into unavailable, with no retry for a non-admin', () => {
		const connecting: RelayState = { phase: 'connecting', mode: 'watch', attempt: 0 };
		expect(relayReducer(connecting, { type: 'refused', status: 409, message: 'paused' })).toEqual({
			phase: 'unavailable',
			message: 'paused',
			retry: true
		});
		expect(relayReducer(connecting, { type: 'refused', status: 403, message: 'x' })).toEqual({
			phase: 'unavailable',
			message: ADMIN_ONLY_MESSAGE,
			retry: false
		});
	});

	it('ignores frames outside a connection and closes from anywhere', () => {
		const idle: RelayState = { phase: 'idle' };
		expect(relayReducer(idle, open())).toBe(idle);
		expect(relayReducer(idle, { type: 'lost' })).toBe(idle);
		expect(relayReducer({ phase: 'ended', mode: 'watch', reason: 'x' }, { type: 'close' })).toEqual(
			idle
		);
	});
});

describe('relayView', () => {
	const live = (mode: 'watch' | 'take_over'): RelayState => ({
		phase: 'live',
		mode,
		relay: RELAY,
		size: { cols: 80, rows: 24 }
	});

	it('offers watch and take over while closed, watch only without a keyboard', () => {
		expect(relayView({ phase: 'idle' }, true)).toMatchObject({
			can_watch: true,
			can_take_over: true,
			show_screen: false
		});
		expect(relayView({ phase: 'idle' }, false)).toMatchObject({
			can_watch: true,
			can_take_over: false
		});
	});

	it('says who is typing', () => {
		expect(relayView(live('watch'), true)).toMatchObject({
			label: 'Watching',
			tone: 'live',
			input: false,
			can_take_over: true,
			can_hand_back: false
		});
		expect(relayView(live('watch'), false).can_take_over).toBe(false);
		expect(relayView(live('take_over'), true)).toMatchObject({
			label: 'You are typing',
			tone: 'typing',
			input: true,
			can_hand_back: true,
			can_take_over: false
		});
	});

	it('covers connecting, reconnecting, ended and unavailable', () => {
		expect(relayView({ phase: 'connecting', mode: 'take_over', attempt: 0 }, true)).toMatchObject({
			label: 'Taking over…',
			tone: 'pending',
			input: false
		});
		expect(
			relayView({ phase: 'reconnecting', mode: 'watch', attempt: 2, delay_ms: 2000 }, true)
		).toMatchObject({ label: 'Reconnecting…', show_screen: true, input: false });
		expect(relayView({ phase: 'ended', mode: 'watch', reason: 'exited' }, true)).toMatchObject({
			label: 'Ended',
			detail: "The agent's program exited.",
			can_watch: true,
			can_take_over: false
		});
		expect(relayView({ phase: 'unavailable', message: 'gone', retry: false }, true)).toMatchObject({
			label: 'Unavailable',
			tone: 'danger',
			detail: 'gone',
			can_retry: false
		});
	});
});

// ---------------------------------------------------------------------------

interface Call {
	url: string;
	body: Record<string, unknown>;
	signal?: AbortSignal;
}

function sse(frames: string[], keep_open = false): Response {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const frame of frames) controller.enqueue(encoder.encode(frame));
			if (!keep_open) controller.close();
		}
	});
	return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const OPEN_FRAME = (mode: string) =>
	`event: open\ndata: ${JSON.stringify({ relay: RELAY, mode, cols: 90, rows: 30 })}\n\n`;

function harness(responses: Array<(call: Call) => Response | Promise<Response>>) {
	const calls: Call[] = [];
	const timers: Array<{ fn: () => void; ms: number }> = [];
	const states: RelayState[] = [];
	const output: string[] = [];
	const opened: unknown[] = [];
	const resized: unknown[] = [];
	const fetch = (async (url: string, init: RequestInit) => {
		const call = {
			url,
			body: JSON.parse(String(init.body)) as Record<string, unknown>,
			signal: init.signal ?? undefined
		};
		calls.push(call);
		const next = responses.shift();
		if (next === undefined) throw new Error('no response queued');
		return next(call);
	}) as unknown as typeof globalThis.fetch;
	const connection = new RelayConnection(
		{ mission: 'mission-1' },
		() => ({ cols: 100, rows: 28 }),
		{
			onState: (state) => states.push(state),
			onOutput: (bytes) => output.push(new TextDecoder().decode(bytes)),
			onOpen: (size, mode) => opened.push({ size, mode }),
			onResize: (size) => resized.push(size)
		},
		{
			fetch,
			setTimeout: (fn, ms) => timers.push({ fn, ms }),
			clearTimeout: () => {}
		}
	);
	return { connection, calls, timers, states, output, opened, resized };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('RelayConnection', () => {
	it('opens, streams output and ends', async () => {
		const h = harness([
			() =>
				sse([
					OPEN_FRAME('watch'),
					`event: output\ndata: ${toBase64(encoder.encode('hello'))}\n\n`,
					'event: resize\ndata: {"cols":120,"rows":40}\n\n',
					'event: end\ndata: {"reason":"exited"}\n\n'
				])
		]);
		h.connection.open('watch');
		await settle();
		expect(h.calls[0]).toMatchObject({
			url: '/api/console/terminals',
			body: { mission: 'mission-1', mode: 'watch', cols: 100, rows: 28 }
		});
		expect(h.opened).toEqual([{ size: { cols: 90, rows: 30 }, mode: 'watch' }]);
		expect(h.output).toEqual(['hello']);
		expect(h.resized).toEqual([{ cols: 120, rows: 40 }]);
		expect(h.states.map((s) => s.phase)).toEqual(['connecting', 'live', 'live', 'ended']);
		expect(h.timers).toEqual([]);
	});

	it('reports a refusal with the server message', async () => {
		const h = harness([
			() =>
				new Response(
					JSON.stringify({ error: { code: 'conflict', message: 'The sandbox is paused.' } }),
					{ status: 409 }
				)
		]);
		h.connection.open('watch');
		await settle();
		expect(h.connection.state).toEqual({
			phase: 'unavailable',
			message: 'The sandbox is paused.',
			retry: true
		});
	});

	it('reconnects a stream that drops without an end, asking for the current mode', async () => {
		const h = harness([
			() => sse([OPEN_FRAME('take_over')]),
			() => sse([OPEN_FRAME('take_over')], true)
		]);
		h.connection.open('take_over');
		await settle();
		expect(h.connection.state).toMatchObject({ phase: 'reconnecting', attempt: 1 });
		expect(h.timers).toHaveLength(1);
		expect(h.timers[0]!.ms).toBe(RECONNECT_DELAYS_MS[0]);
		h.timers[0]!.fn();
		await settle();
		expect(h.calls[1]!.body).toMatchObject({ mode: 'take_over' });
		expect(h.connection.state).toMatchObject({ phase: 'live', mode: 'take_over' });
	});

	it('counts failed reconnects and gives up after the last delay', async () => {
		const fail = () => Promise.reject(new TypeError('network'));
		const h = harness([fail, fail, fail, fail, fail, fail]);
		h.connection.open('watch');
		await settle();
		for (let i = 0; i < RECONNECT_DELAYS_MS.length; i += 1) {
			expect(h.timers[i]!.ms).toBe(RECONNECT_DELAYS_MS[i]);
			h.timers[i]!.fn();
			await settle();
		}
		expect(h.connection.state).toEqual({
			phase: 'unavailable',
			message: LOST_MESSAGE,
			retry: true
		});
		expect(h.calls).toHaveLength(RECONNECT_DELAYS_MS.length + 1);
	});

	it('sends a take-over’s keys in order, one request at a time, and its size', async () => {
		const writes: Call[] = [];
		let release!: () => void;
		const first = new Promise<Response>((resolve) => {
			release = () => resolve(new Response('{}', { status: 202 }));
		});
		const h = harness([
			() => sse([OPEN_FRAME('take_over')], true),
			(call) => {
				writes.push(call);
				return first;
			},
			(call) => {
				writes.push(call);
				return new Response('{}', { status: 202 });
			}
		]);
		h.connection.open('take_over');
		await settle();
		h.connection.write(encoder.encode('a'));
		h.connection.write(encoder.encode('b'));
		h.connection.resize({ cols: 70, rows: 20 });
		h.connection.write(encoder.encode('c'));
		await settle();
		expect(writes).toHaveLength(1);
		release();
		await settle();
		await settle();
		expect(writes.map((w) => w.url)).toEqual([
			`/api/console/terminals/${RELAY}`,
			`/api/console/terminals/${RELAY}`
		]);
		expect(writes[0]!.body).toEqual({ data: toBase64(encoder.encode('a')) });
		expect(writes[1]!.body).toEqual({ data: toBase64(encoder.encode('bc')), cols: 70, rows: 20 });
	});

	it('drops keys while watching and aborts the stream on close', async () => {
		const h = harness([() => sse([OPEN_FRAME('watch')], true)]);
		h.connection.open('watch');
		await settle();
		h.connection.write(encoder.encode('x'));
		h.connection.resize({ cols: 10, rows: 10 });
		await settle();
		expect(h.calls).toHaveLength(1);
		h.connection.close();
		expect(h.calls[0]!.signal?.aborted).toBe(true);
		expect(h.connection.state).toEqual({ phase: 'idle' });
		await settle();
		expect(h.timers).toEqual([]);
	});
});
