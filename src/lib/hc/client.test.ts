import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeHcCore } from '#lib/test/fake-hc.js';
import { HcError, connectHc, type HcClient, type HcNotification, type HcTransport } from './client';
import { DATA, encodeFrame } from './frames';

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const clients: HcClient[] = [];
async function open(core: FakeHcCore, chunk?: number, timeout_ms?: number): Promise<HcClient> {
	const client = await connectHc(core.connect({ chunk }), { timeout_ms });
	clients.push(client);
	return client;
}

afterEach(() => {
	for (const client of clients.splice(0)) client.close();
});

/** A transport the test answers by hand, for replies the fake would never send. */
function scripted(): {
	transport: HcTransport;
	sent: Uint8Array[];
	reply(bytes: Uint8Array | string): void;
	end(): void;
} {
	const sent: Uint8Array[] = [];
	let data: (bytes: Uint8Array) => void = () => {};
	let closed: (error?: Error) => void = () => {};
	return {
		transport: {
			write: (bytes) => void sent.push(bytes),
			onData: (listener) => (data = listener),
			onClose: (listener) => (closed = listener),
			close: () => {}
		},
		sent,
		reply: (bytes) => data(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes),
		end: () => closed()
	};
}

async function expectKind(promise: Promise<unknown>, kind: string): Promise<HcError> {
	const error = await promise.then(
		() => {
			throw new Error('expected a rejection');
		},
		(e: unknown) => e
	);
	expect(error).toBeInstanceOf(HcError);
	expect((error as HcError).kind).toBe(kind);
	return error as HcError;
}

describe('handshake', () => {
	it('says hello at generation 1, asks for framed mode and reports the core', async () => {
		const core = new FakeHcCore();
		const client = await open(core);
		expect(client.info).toMatchObject({ generation: 1, version: '0.1.20-fake' });
		expect(client.info?.methods).toContain('terminal.attach');
	});

	it('sends hello as one plain JSON line', async () => {
		const wire = scripted();
		void connectHc(wire.transport).catch(() => {});
		const line = text(wire.sent[0]);
		expect(line.endsWith('\n')).toBe(true);
		expect(JSON.parse(line)).toMatchObject({
			jsonrpc: '2.0',
			method: 'hello',
			params: { generation: 1, framed: true }
		});
	});

	it('refuses a core that answers with another generation', async () => {
		const wire = scripted();
		const pending = connectHc(wire.transport);
		wire.reply(
			JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				result: { generation: 2, version: 'x', framed: true, methods: [], features: [] }
			}) + '\n'
		);
		await expectKind(pending, 'unsupported_generation');
	});

	it("passes on the core's own unsupported_generation error", async () => {
		const core = new FakeHcCore();
		core.generation = 2;
		await expectKind(connectHc(core.connect()), 'unsupported_generation');
	});

	it('refuses a core that stays in plain mode', async () => {
		const core = new FakeHcCore();
		core.refuse_framed = true;
		await expectKind(connectHc(core.connect()), 'protocol');
	});

	it('reads frames that arrive in the same chunk as the hello reply', async () => {
		const wire = scripted();
		const pending = connectHc(wire.transport);
		const hello = JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			result: { generation: 1, version: 'x', framed: true, methods: [], features: [] }
		});
		wire.reply(hello + '\n');
		const client = await pending;
		const get = client.get('t1');
		const answer = encodeFrame(
			0,
			DATA,
			new TextEncoder().encode(
				JSON.stringify({
					jsonrpc: '2.0',
					id: 2,
					error: { code: -32000, message: 'no', data: { kind: 'not_found' } }
				})
			)
		);
		wire.reply(answer.subarray(0, 4));
		wire.reply(answer.subarray(4));
		await expectKind(get, 'not_found');
	});

	it('times out a silent core', async () => {
		const wire = scripted();
		await expectKind(connectHc(wire.transport, { timeout_ms: 20 }), 'timeout');
	});
});

describe('methods', () => {
	it('runs a program from argv with no parent, no notes, no keep, and no shell line', async () => {
		const core = new FakeHcCore();
		const client = await open(core);
		const terminal = await client.run({
			argv: ['claude', '--session-id', 'abc'],
			cwd: '/home/agent/run',
			env: { BEADS_MISSION: 'm1' },
			labels: { 'beadsmith.mission': 'm1' },
			name: 'mission-m1',
			size: { cols: 120, rows: 40 }
		});
		expect(terminal).toMatchObject({
			address: 't1',
			state: 'live',
			cwd: '/home/agent/run',
			cols: 120
		});
		const call = core.calls.find((c) => c.method === 'terminal.run');
		expect(call?.params).toEqual({
			argv: ['claude', '--session-id', 'abc'],
			cwd: '/home/agent/run',
			env: { BEADS_MISSION: 'm1' },
			labels: { 'beadsmith.mission': 'm1' },
			name: 'mission-m1',
			size: { cols: 120, rows: 40 },
			no_parent: true,
			no_notify: true,
			keep: false,
			wait: false
		});
	});

	it('works over a channel that delivers one byte at a time', async () => {
		const core = new FakeHcCore();
		const client = await open(core, 1);
		await client.run({ argv: ['sh'] });
		expect((await client.list()).map((t) => t.address)).toEqual(['t1']);
	});

	it('lists, gets, reads, presses keys, interrupts, kills and removes', async () => {
		const core = new FakeHcCore();
		const client = await open(core);
		const { address } = await client.run({ argv: ['claude'], labels: { chat: 'c1' } });
		await client.run({ argv: ['claude'], labels: { chat: 'c2' } });
		core.output(address, 'hello screen');
		core.setStatus(address, 'idle');

		expect((await client.list({ labels: { chat: 'c1' } })).map((t) => t.address)).toEqual([
			address
		]);
		expect(await client.get(address)).toMatchObject({
			status: { state: 'idle', app: 'claude-code' },
			turn: 0
		});
		expect(await client.read(address, { lines: 50 })).toMatchObject({
			text: 'hello screen',
			complete: true
		});
		expect(await client.keys(address, ['esc', 'ctrl+c'])).toEqual({ turn: 0, status: 'idle' });
		expect(core.terminal(address).keys).toEqual([['esc', 'ctrl+c']]);

		const interrupted = vi.fn();
		core.onInterrupt = interrupted;
		expect(await client.interrupt(address, { timeout_s: 1 })).toEqual({
			outcome: 'stopped',
			key: 'esc'
		});
		expect(interrupted).toHaveBeenCalledOnce();

		const killed = await client.kill(address);
		expect(killed).toMatchObject({ state: 'finished', reason: 'killed' });
		expect((await client.list()).map((t) => t.address)).toEqual(['t2']);
		expect((await client.list({ all: true })).length).toBe(2);
		await client.remove(address);
		await expectKind(client.get(address), 'not_found');
	});

	it('sends text, honors only_if, and surfaces blocked rather than forcing', async () => {
		const core = new FakeHcCore();
		const client = await open(core);
		const { address } = await client.run({ argv: ['claude'] });
		core.setStatus(address, 'idle');

		expect(await client.send(address, 'Fix the bug.\nThen run tests.')).toMatchObject({
			turn: 0,
			status: 'idle'
		});
		expect(core.terminal(address).sent).toEqual(['Fix the bug.\nThen run tests.']);

		await expectKind(client.send(address, 'again', { only_if: 'working' }), 'status_mismatch');

		core.setStatus(address, 'blocked');
		const error = await expectKind(client.send(address, 'yes'), 'blocked');
		expect(error.code).toBe(-32000);
		expect(error.hint).toBe('fake hint for blocked');
		const sends = core.calls.filter((c) => c.method === 'terminal.send');
		expect(sends.every((c) => !('force' in c.params))).toBe(true);
	});

	it('waits for the program to stop working, or checks in after the timeout', async () => {
		const core = new FakeHcCore();
		const client = await open(core);
		const { address } = await client.run({ argv: ['claude'] });
		core.setStatus(address, 'working');

		const checked_in = await client.wait(address, { timeout_s: 0.02 });
		expect(checked_in).toMatchObject({ ended: false, turn: 0, status: 'working' });

		const waiting = client.wait(address, { timeout_s: 30 });
		await settle();
		core.endTurn(address, 'done');
		expect(await waiting).toMatchObject({ ended: true, turn: 1, status: 'done' });
		expect(core.calls.at(-1)?.params).toEqual({ terminal: address, timeout: 30 });
	});

	it('reads a file by line range', async () => {
		const core = new FakeHcCore();
		core.files.set('/home/agent/.claude/projects/x/s.jsonl', 'a\nb\nc\n');
		const client = await open(core);
		expect(
			await client.readFile('/home/agent/.claude/projects/x/s.jsonl', { offset: 2, limit: 5 })
		).toEqual({
			text: 'b\nc\n',
			first: 2,
			last: 3,
			lines: 3
		});
		await expectKind(client.readFile('/nope'), 'not_found');
	});

	it("turns the core's errors into HcError with its kind", async () => {
		const core = new FakeHcCore();
		const client = await open(core);
		core.fail('terminal.run', 'spawn_failed', 'no such program');
		const error = await expectKind(client.run({ argv: ['missing'] }), 'spawn_failed');
		expect(error.message).toBe('no such program');
	});

	it('runs calls side by side and matches each reply to its call', async () => {
		const core = new FakeHcCore();
		const client = await open(core, 5);
		const { address } = await client.run({ argv: ['claude'] });
		core.setStatus(address, 'working');
		const wait = client.wait(address);
		const others = await Promise.all([client.get(address), client.list(), client.read(address)]);
		expect(others[0].address).toBe(address);
		core.endTurn(address);
		expect((await wait).ended).toBe(true);
	});

	it('times out a call the core never answers', async () => {
		const core = new FakeHcCore();
		core.silence('terminal.get');
		const client = await open(core, undefined, 20);
		await expectKind(client.get('t1'), 'timeout');
		// The connection is still usable.
		expect(await client.list()).toEqual([]);
	});
});

describe('argument checks', () => {
	it('refuses bad arguments before anything is sent', async () => {
		const core = new FakeHcCore();
		const client = await open(core);
		const before = core.calls.length;
		const refused = [
			client.get('rohan/t7'),
			client.get('../t1'),
			client.get('T1'),
			client.get(''),
			client.get('..'),
			client.get('a'.repeat(33)),
			client.run({ argv: [] }),
			client.run({ argv: [''] }),
			client.run({ argv: ['sh', 'a\0b'] }),
			client.run({ argv: ['sh'], cwd: 'relative' }),
			client.run({ argv: ['sh'], env: { 'BAD-NAME': 'x' } }),
			client.run({ argv: ['sh'], env: { OK: 'a\0' } }),
			client.run({ argv: ['sh'], labels: { 'a=b': 'x' } }),
			client.run({ argv: ['sh'], labels: { a: 'two\nlines' } }),
			client.run({ argv: ['sh'], size: { cols: 0, rows: 10 } }),
			client.send('t1', ''),
			client.send('t1', 'nul\0'),
			client.send('t1', 'x', { only_if: 'blocked' as 'idle' }),
			client.keys('t1', []),
			client.keys('t1', ['enter; rm -rf /']),
			client.wait('t1', { timeout_s: 0 }),
			client.wait('t1', { timeout_s: Number.POSITIVE_INFINITY }),
			client.readFile('etc/passwd'),
			client.readFile('/x', { offset: 0 }),
			client.read('t1', { lines: -1 })
		];
		for (const promise of refused) await expectKind(promise, 'invalid_params');
		expect(core.calls.length).toBe(before);
	});
});

describe('events', () => {
	it('delivers the snapshot, then every change in order, from lines cut across frames', async () => {
		const core = new FakeHcCore();
		core.event_chunk = 7;
		const client = await open(core, 3);
		await client.run({ argv: ['claude'], labels: { chat: 'c1' } });
		const seen: HcNotification[] = [];
		const subscription = await client.subscribe({ labels: { chat: 'c1' } }, (n) => seen.push(n));
		expect(subscription.terminals.map((t) => t.address)).toEqual(['t1']);
		expect(subscription.seq).toBe(1);

		await client.run({ argv: ['claude'], labels: { chat: 'other' } });
		core.setStatus('t1', 'working');
		core.endTurn('t1', 'done');
		core.exit('t1', 0);
		await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ type: 'finished' }));

		expect(seen.map((n) => (n.method === 'event' ? `${n.seq}:${n.type}` : n.method))).toEqual([
			'3:status',
			'4:turn',
			'5:status',
			'6:status',
			'7:finished'
		]);
		expect(seen[1]).toMatchObject({ terminal: 't1', data: { turn: 1, state: 'done' } });

		// Every event byte went back as credit.
		const channel = [...core.credits.keys()][0];
		expect(core.credits.get(channel)).toBeGreaterThan(0);

		subscription.close();
		await subscription.closed;
		await settle();
		expect(core.subscriptions.size).toBe(0);
	});

	it('keeps the connection when a listener throws', async () => {
		const core = new FakeHcCore();
		const client = await open(core);
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		await client.subscribe({}, () => {
			throw new Error('listener bug');
		});
		await client.run({ argv: ['sh'] });
		await vi.waitFor(() => expect(error).toHaveBeenCalled());
		expect(await client.list()).toHaveLength(1);
		error.mockRestore();
	});
});

describe('attach', () => {
	it('observes: first paint, live output, grid size, then the exit reason', async () => {
		const core = new FakeHcCore();
		const client = await open(core, 4);
		const { address } = await client.run({ argv: ['claude'], size: { cols: 100, rows: 30 } });
		core.output(address, 'before ');
		const received: string[] = [];
		const sizes: Array<{ cols: number; rows: number }> = [];
		const attachment = await client.attach(
			address,
			{ cols: 80, rows: 24, observe: true, history: 100 },
			{
				onData: (bytes) => void received.push(text(bytes)),
				onResize: (size) => void sizes.push(size)
			}
		);
		expect(attachment.observe).toBe(true);
		expect(core.calls.at(-1)?.params).toEqual({
			terminal: address,
			cols: 80,
			rows: 24,
			observe: true,
			resize_notifications: true,
			history: 100
		});
		core.output(address, 'after');
		await vi.waitFor(() => expect(received.join('')).toBe('before after'));
		expect(sizes).toEqual([{ cols: 100, rows: 30 }]);

		expect(() => attachment.write(new Uint8Array([97]))).toThrow(HcError);
		expect(() => attachment.resize(10, 10)).toThrow(HcError);

		core.exit(address, 3);
		expect(await attachment.ended).toEqual({ reason: 'exited', exit_code: 3, signal: null });
	});

	it('takes over: keystrokes, size and focus reach the program', async () => {
		const core = new FakeHcCore();
		const client = await open(core);
		const { address } = await client.run({ argv: ['claude'] });
		const attachment = await client.attach(address, { cols: 90, rows: 20 }, { onData: () => {} });
		expect(core.terminal(address).cols).toBe(90);
		attachment.write(new TextEncoder().encode('y\r'));
		attachment.resize(132, 43);
		attachment.focus(true);
		await vi.waitFor(() => expect(core.terminal(address).focus).toEqual([1]));
		expect(text(new Uint8Array(core.terminal(address).typed))).toBe('y\r');
		expect(core.terminal(address).viewer_size).toEqual({ cols: 132, rows: 43 });

		attachment.close();
		expect(await attachment.ended).toEqual({ reason: 'detached' });
		await settle();
		expect(core.attachments.size).toBe(0);
		expect(() => attachment.write(new Uint8Array([1]))).toThrow(HcError);
	});

	it('returns credit as output is consumed, so more than the window arrives', async () => {
		const core = new FakeHcCore();
		const client = await open(core);
		const { address } = await client.run({ argv: ['cat'] });
		let total = 0;
		const attachment = await client.attach(
			address,
			{ cols: 80, rows: 24, observe: true },
			{ onData: (bytes) => void (total += bytes.length) }
		);
		const big = new Uint8Array(600 * 1024).fill(65);
		core.output(address, big);
		await vi.waitFor(() => expect(total).toBe(big.length));
		expect(core.credits.get(attachment.channel)).toBe(big.length);
	});

	it('holds credit until a slow consumer finishes', async () => {
		const core = new FakeHcCore();
		const client = await open(core);
		const { address } = await client.run({ argv: ['cat'] });
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => (release = resolve));
		const chunks: string[] = [];
		const attachment = await client.attach(
			address,
			{ cols: 80, rows: 24, observe: true },
			{
				onData: async (bytes) => {
					chunks.push(text(bytes));
					await gate;
				}
			}
		);
		core.output(address, 'one');
		await vi.waitFor(() => expect(chunks).toEqual(['one']));
		await settle();
		expect(core.credits.get(attachment.channel) ?? 0).toBe(0);
		release();
		await vi.waitFor(() => expect(core.credits.get(attachment.channel)).toBe(3));
	});

	it('refuses to attach to a finished terminal', async () => {
		const core = new FakeHcCore();
		const client = await open(core);
		const { address } = await client.run({ argv: ['true'] });
		core.exit(address);
		await expectKind(
			client.attach(address, { cols: 80, rows: 24 }, { onData: () => {} }),
			'finished'
		);
	});
});

describe('connection loss', () => {
	it('fails outstanding calls, ends streams and tells the owner', async () => {
		const core = new FakeHcCore();
		const client = await open(core);
		const { address } = await client.run({ argv: ['claude'] });
		core.setStatus(address, 'working');
		const closed = vi.fn();
		client.onClose(closed);
		const attachment = await client.attach(
			address,
			{ cols: 80, rows: 24, observe: true },
			{ onData: () => {} }
		);
		const subscription = await client.subscribe({}, () => {});
		const wait = client.wait(address);
		await settle();

		core.disconnectAll();
		await expectKind(wait, 'disconnected');
		expect(await attachment.ended).toEqual({ reason: 'disconnected' });
		await subscription.closed;
		expect(closed).toHaveBeenCalledOnce();
		expect(client.closed).toBe(true);
		await expectKind(client.list(), 'disconnected');
	});

	it('closes on a frame it cannot read', async () => {
		const wire = scripted();
		const pending = connectHc(wire.transport);
		wire.reply(
			JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				result: { generation: 1, version: 'x', framed: true, methods: [], features: [] }
			}) + '\n'
		);
		const client = await pending;
		const list = client.list();
		wire.reply(encodeFrame(0, DATA, new TextEncoder().encode('not json')));
		await expectKind(list, 'protocol');
		expect(client.closed).toBe(true);
	});

	it('refuses a malformed result without trusting it', async () => {
		const wire = scripted();
		const pending = connectHc(wire.transport);
		wire.reply(
			JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				result: { generation: 1, version: 'x', framed: true, methods: [], features: [] }
			}) + '\n'
		);
		const client = await pending;
		const get = client.get('t1');
		wire.reply(
			encodeFrame(
				0,
				DATA,
				new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { address: 7 } }))
			)
		);
		await expectKind(get, 'protocol');
	});
});
