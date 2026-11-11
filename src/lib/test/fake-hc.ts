/**
 * An in-memory herdr-core for unit tests. It speaks the real wire protocol
 * (the plain-mode `hello` line, then framed mode with channels and credit)
 * over an in-memory transport, so tests exercise the client's framing as well
 * as its methods. No process, socket or network is involved.
 *
 * Programs are scripted: a test reacts to `onRun`/`onSend`/`onKeys`/
 * `onInterrupt` and drives a terminal with `setStatus`, `endTurn`, `output`
 * and `exit`, the facts a real program would report through OSC 7501.
 *
 * It models what Beadsmith relies on, not all of hc: no machines, templates,
 * keep or documents.
 */

import type { HcTransport } from '../hc/client.js';
import {
	CLOSE,
	CREDIT,
	DATA,
	FOCUS,
	FrameDecoder,
	RESIZE,
	STREAM_WINDOW,
	decodeSize,
	decodeU32,
	encodeFrame,
	encodeSize
} from '../hc/frames.js';

export interface FakeTerminal {
	address: string;
	name: string | null;
	argv: string[];
	cwd: string;
	env: Record<string, string>;
	labels: Record<string, string>;
	state: 'live' | 'finished';
	status: { state: string; app: string } | null;
	reported: boolean;
	turn: number;
	cols: number;
	rows: number;
	screen: string;
	exit_code: number | null;
	reason: string | null;
	/** Text delivered with terminal.send, in order. */
	sent: string[];
	/** Key names pressed with terminal.keys, in order. */
	keys: string[][];
	/** Bytes typed by active (non-observe) viewers. */
	typed: number[];
	/** Size set by the last active viewer's RESIZE. */
	viewer_size: { cols: number; rows: number } | null;
	focus: number[];
}

interface Attachment {
	connection: FakeConnection;
	channel: number;
	terminal: FakeTerminal;
	observe: boolean;
	credit: number;
	queue: Uint8Array[];
}

interface Subscription {
	connection: FakeConnection;
	channel: number;
	terminal: string | null;
	labels: Record<string, string>;
}

interface Waiter {
	terminal: FakeTerminal;
	resolve(result: unknown): void;
	timer: ReturnType<typeof setTimeout>;
}

export interface FakeConnectOptions {
	/** Split everything the core sends into chunks of this many bytes. */
	chunk?: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class RpcFailure extends Error {
	readonly kind: string;
	constructor(kind: string, message = kind) {
		super(message);
		this.kind = kind;
	}
}

export class FakeHcCore {
	generation = 1;
	version = '0.1.20-fake';
	/** Answer `hello` with `framed: false`, as a core that can't switch would. */
	refuse_framed = false;
	/** Cut each event line into frames of this many bytes (hc cuts at 16 KiB, anywhere). */
	event_chunk = 16 * 1024;

	readonly terminals = new Map<string, FakeTerminal>();
	readonly files = new Map<string, string>();
	/** Every method call, in order, with its params as received. */
	readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
	/** CREDIT bytes received per stream channel. */
	readonly credits = new Map<number, number>();

	onRun?: (terminal: FakeTerminal) => void;
	onSend?: (terminal: FakeTerminal, text: string) => void;
	onKeys?: (terminal: FakeTerminal, keys: string[]) => void;
	onInterrupt?: (terminal: FakeTerminal) => void;

	#next_terminal = 1;
	#seq = 0;
	#failures = new Map<string, RpcFailure[]>();
	#silent = new Set<string>();
	readonly connections = new Set<FakeConnection>();
	readonly attachments = new Set<Attachment>();
	readonly subscriptions = new Set<Subscription>();
	#waiters = new Set<Waiter>();

	/** A client-side transport to a new connection on this core. */
	connect(options: FakeConnectOptions = {}): HcTransport {
		const connection = new FakeConnection(this, options);
		this.connections.add(connection);
		return connection.transport;
	}

	/** Make the next call of `method` fail with hc error `kind`. */
	fail(method: string, kind: string, message?: string): void {
		const list = this.#failures.get(method) ?? [];
		list.push(new RpcFailure(kind, message));
		this.#failures.set(method, list);
	}

	/** Never answer `method` (to test timeouts). */
	silence(method: string): void {
		this.#silent.add(method);
	}

	terminal(id: string): FakeTerminal {
		const found = this.terminals.get(id) ?? [...this.terminals.values()].find((t) => t.name === id);
		if (!found) throw new Error(`fake hc: no terminal ${id}`);
		return found;
	}

	/** The program reports a status (null clears it). */
	setStatus(id: string, state: string | null, app = 'claude-code'): void {
		const t = this.terminal(id);
		t.status = state === null ? null : { state, app };
		if (state !== null) t.reported = true;
		this.#emit(t, 'status', {
			status: t.status,
			records: t.status ? { [app]: t.status } : {},
			reported: t.reported
		});
		if (state !== 'working') this.#settleWaits(t);
	}

	/** The program ends a turn on `state`: the counter advances, then the status. */
	endTurn(id: string, state = 'done'): void {
		const t = this.terminal(id);
		t.turn += 1;
		this.#emit(t, 'turn', { turn: t.turn, state });
		this.setStatus(id, state);
	}

	/** The program prints: goes to every attached viewer, within its credit. */
	output(id: string, bytes: Uint8Array | string): void {
		const t = this.terminal(id);
		const data = typeof bytes === 'string' ? encoder.encode(bytes) : bytes;
		t.screen += decoder.decode(data);
		for (const attachment of this.attachments) {
			if (attachment.terminal !== t) continue;
			attachment.queue.push(data);
			this.#pump(attachment);
		}
	}

	/** The program exits on its own. */
	exit(id: string, code = 0, reason = 'exited'): void {
		this.#finish(this.terminal(id), code, reason);
	}

	/** Drop every connection, as a lost SSH session or sandbox would. */
	disconnectAll(): void {
		for (const connection of this.connections) connection.drop();
	}

	// ── called by FakeConnection ──────────────────────────────────────────

	handle(
		connection: FakeConnection,
		method: string,
		params: Record<string, unknown>
	): unknown | Promise<unknown> {
		this.calls.push({ method, params });
		const failure = this.#failures.get(method)?.shift();
		if (failure) throw failure;
		if (this.#silent.has(method)) return new Promise(() => {});
		switch (method) {
			case 'terminal.run':
				return this.#run(params);
			case 'terminal.list': {
				const labels = (params.labels ?? {}) as Record<string, string>;
				const terminals = [...this.terminals.values()].filter(
					(t) => (params.all === true || t.state === 'live') && matches(t, labels)
				);
				return { terminals: terminals.map(record), hidden_finished: 0, machines: [] };
			}
			case 'terminal.get':
				return record(this.#find(params.terminal));
			case 'terminal.read': {
				const t = this.#find(params.terminal);
				return { text: t.screen, complete: true, how: 'screen' };
			}
			case 'terminal.send':
				return this.#send(params);
			case 'terminal.keys': {
				const t = this.#live(params.terminal);
				const keys = params.keys as string[];
				t.keys.push(keys);
				this.onKeys?.(t, keys);
				return { turn: t.turn, status: t.status?.state ?? null };
			}
			case 'terminal.interrupt': {
				const t = this.#live(params.terminal);
				this.onInterrupt?.(t);
				return { outcome: t.status?.state === 'working' ? 'still_working' : 'stopped', key: 'esc' };
			}
			case 'terminal.wait':
				return this.#wait(params);
			case 'terminal.kill': {
				const t = this.#find(params.terminal);
				if (t.state === 'live') this.#finish(t, null, 'killed');
				return record(t);
			}
			case 'terminal.rm': {
				const t = this.#find(params.terminal);
				if (t.state === 'live')
					throw new RpcFailure('invalid_params', `${t.address} is still running`);
				this.terminals.delete(t.address);
				this.#emit(t, 'removed', {});
				return { removed: t.address };
			}
			case 'file.read':
				return this.#readFile(params);
			case 'events.subscribe':
				return this.#subscribe(connection, params);
			case 'terminal.attach':
				return this.#attach(connection, params);
			default:
				throw new RpcFailure('method_not_found', `no method ${method}`);
		}
	}

	streamFrame(
		connection: FakeConnection,
		channel: number,
		kind: number,
		payload: Uint8Array
	): void {
		const attachment = [...this.attachments].find(
			(a) => a.connection === connection && a.channel === channel
		);
		const subscription = [...this.subscriptions].find(
			(s) => s.connection === connection && s.channel === channel
		);
		if (kind === CREDIT) {
			const bytes = decodeU32(payload);
			this.credits.set(channel, (this.credits.get(channel) ?? 0) + bytes);
			if (attachment) {
				attachment.credit += bytes;
				this.#pump(attachment);
			}
			return;
		}
		if (kind === CLOSE) {
			if (attachment) this.attachments.delete(attachment);
			if (subscription) this.subscriptions.delete(subscription);
			if (attachment || subscription) connection.frame(channel, CLOSE, new Uint8Array(0));
			return;
		}
		if (!attachment || attachment.observe) return; // hc ignores input from observers
		const t = attachment.terminal;
		if (kind === DATA) t.typed.push(...payload);
		else if (kind === RESIZE) {
			t.viewer_size = decodeSize(payload);
			t.cols = t.viewer_size.cols;
			t.rows = t.viewer_size.rows;
		} else if (kind === FOCUS) t.focus.push(payload[0]);
	}

	dropConnection(connection: FakeConnection): void {
		this.connections.delete(connection);
		for (const a of this.attachments) if (a.connection === connection) this.attachments.delete(a);
		for (const s of this.subscriptions)
			if (s.connection === connection) this.subscriptions.delete(s);
	}

	// ── methods ───────────────────────────────────────────────────────────

	#run(params: Record<string, unknown>): unknown {
		const name = (params.name as string | undefined) ?? null;
		if (name && [...this.terminals.values()].some((t) => t.state === 'live' && t.name === name)) {
			throw new RpcFailure('name_taken', `a terminal is already called ${name}`);
		}
		const size = (params.size as { cols: number; rows: number } | undefined) ?? {
			cols: 200,
			rows: 120
		};
		const t: FakeTerminal = {
			address: `t${this.#next_terminal++}`,
			name,
			argv: params.argv as string[],
			cwd: (params.cwd as string | undefined) ?? '/',
			env: (params.env as Record<string, string> | undefined) ?? {},
			labels: (params.labels as Record<string, string> | undefined) ?? {},
			state: 'live',
			status: null,
			reported: false,
			turn: 0,
			cols: size.cols,
			rows: size.rows,
			screen: '',
			exit_code: null,
			reason: null,
			sent: [],
			keys: [],
			typed: [],
			viewer_size: null,
			focus: []
		};
		this.terminals.set(t.address, t);
		this.#emit(t, 'created', record(t));
		this.onRun?.(t);
		return record(t);
	}

	#send(params: Record<string, unknown>): unknown {
		const t = this.#live(params.terminal);
		if (t.status?.state === 'blocked' && params.force !== true) {
			throw new RpcFailure('blocked', `${t.address} is waiting for an answer`);
		}
		if (params.if !== undefined && t.status?.state !== params.if) {
			throw new RpcFailure('status_mismatch', `${t.address} is ${t.status?.state ?? 'unknown'}`);
		}
		const text = params.text as string;
		t.sent.push(text);
		const turn = t.turn;
		const status = t.status?.state ?? null;
		this.onSend?.(t, text);
		return { turn, status, started: null };
	}

	#wait(params: Record<string, unknown>): unknown {
		const t = this.#find(params.terminal);
		if (t.state === 'finished' || t.status?.state !== 'working') return waitResult(t, true);
		const timeout_s = (params.timeout as number | undefined) ?? 180;
		return new Promise((resolve) => {
			const waiter: Waiter = {
				terminal: t,
				resolve,
				timer: setTimeout(() => {
					this.#waiters.delete(waiter);
					resolve(waitResult(t, false));
				}, timeout_s * 1000)
			};
			this.#waiters.add(waiter);
		});
	}

	#readFile(params: Record<string, unknown>): unknown {
		const path = params.path as string;
		const text = this.files.get(path);
		if (text === undefined) throw new RpcFailure('not_found', `no file ${path}`);
		const lines = text.split('\n');
		if (lines.at(-1) === '') lines.pop();
		const offset = (params.offset as number | undefined) ?? 1;
		const limit = (params.limit as number | undefined) ?? lines.length;
		const picked = lines.slice(offset - 1, offset - 1 + limit);
		return {
			text: picked.map((line) => line + '\n').join(''),
			first: picked.length ? offset : 0,
			last: picked.length ? offset + picked.length - 1 : 0,
			lines: lines.length
		};
	}

	#subscribe(
		connection: FakeConnection,
		params: Record<string, unknown>
	): { result: unknown; after: () => void } {
		const channel = connection.newChannel();
		const subscription: Subscription = {
			connection,
			channel,
			terminal: (params.terminal as string | undefined) ?? null,
			labels: (params.labels as Record<string, string> | undefined) ?? {}
		};
		const terminals = [...this.terminals.values()].filter((t) => this.#matches(subscription, t));
		return {
			result: { seq: this.#seq, channel, terminals: terminals.map(record) },
			after: () => this.subscriptions.add(subscription)
		};
	}

	#attach(
		connection: FakeConnection,
		params: Record<string, unknown>
	): { result: unknown; after: () => void } {
		const t = this.#find(params.terminal);
		if (t.state === 'finished') throw new RpcFailure('finished', `${t.address} has finished`);
		const observe = params.observe === true;
		const channel = connection.newChannel();
		const attachment: Attachment = {
			connection,
			channel,
			terminal: t,
			observe,
			credit: STREAM_WINDOW,
			queue: []
		};
		if (!observe) {
			t.cols = params.cols as number;
			t.rows = params.rows as number;
		}
		return {
			result: {
				channel,
				terminal: record(t),
				resize_notifications: observe && params.resize_notifications === true,
				automatic_input: false
			},
			after: () => {
				this.attachments.add(attachment);
				if (observe && params.resize_notifications === true) {
					connection.frame(channel, RESIZE, encodeSize(t.cols, t.rows));
				}
				// The first paint: the screen as it stands.
				attachment.queue.push(encoder.encode(t.screen));
				this.#pump(attachment);
			}
		};
	}

	// ── facts ─────────────────────────────────────────────────────────────

	#finish(t: FakeTerminal, code: number | null, reason: string): void {
		if (t.state === 'finished') return;
		if (t.status) this.setStatus(t.address, null);
		t.state = 'finished';
		t.exit_code = code;
		t.reason = reason;
		this.#emit(t, 'finished', { reason, exit_code: code, signal: null, finished_ms: Date.now() });
		this.#settleWaits(t);
		const why = encoder.encode(JSON.stringify({ reason, exit_code: code, signal: null }));
		for (const a of this.attachments) {
			if (a.terminal !== t) continue;
			this.attachments.delete(a);
			a.connection.frame(a.channel, CLOSE, why);
		}
	}

	#settleWaits(t: FakeTerminal): void {
		for (const waiter of this.#waiters) {
			if (waiter.terminal !== t) continue;
			clearTimeout(waiter.timer);
			this.#waiters.delete(waiter);
			waiter.resolve(waitResult(t, true));
		}
	}

	#emit(t: FakeTerminal, type: string, data: unknown): void {
		this.#seq += 1;
		const line = encoder.encode(
			JSON.stringify({
				jsonrpc: '2.0',
				method: 'event',
				params: { seq: this.#seq, type, terminal: t.address, data }
			}) + '\n'
		);
		for (const s of this.subscriptions) {
			if (!this.#matches(s, t)) continue;
			for (let at = 0; at < line.length; at += this.event_chunk) {
				s.connection.frame(s.channel, DATA, line.subarray(at, at + this.event_chunk));
			}
		}
	}

	#matches(s: Subscription, t: FakeTerminal): boolean {
		if (s.terminal !== null && s.terminal !== t.address && s.terminal !== t.name) return false;
		return matches(t, s.labels);
	}

	#pump(a: Attachment): void {
		while (a.credit > 0 && a.queue.length > 0) {
			const head = a.queue[0];
			const n = Math.min(head.length, a.credit, 16 * 1024);
			a.connection.frame(a.channel, DATA, head.subarray(0, n));
			a.credit -= n;
			if (n === head.length) a.queue.shift();
			else a.queue[0] = head.subarray(n);
		}
	}

	#find(id: unknown): FakeTerminal {
		const found =
			this.terminals.get(id as string) ??
			[...this.terminals.values()].find((t) => t.name !== null && t.name === id);
		if (!found) throw new RpcFailure('not_found', `no terminal ${String(id)}`);
		return found;
	}

	#live(id: unknown): FakeTerminal {
		const t = this.#find(id);
		if (t.state === 'finished') throw new RpcFailure('finished', `${t.address} has finished`);
		return t;
	}
}

/** One client connection: the server side of the protocol. */
class FakeConnection {
	readonly transport: HcTransport;
	#core: FakeHcCore;
	#chunk: number;
	#mode: 'plain' | 'framed' | 'closed' = 'plain';
	#plain = '';
	#frames = new FrameDecoder();
	#next_channel = 1;
	#data: Array<(bytes: Uint8Array) => void> = [];
	#closed: Array<(error?: Error) => void> = [];

	constructor(core: FakeHcCore, options: FakeConnectOptions) {
		this.#core = core;
		this.#chunk = options.chunk ?? Number.MAX_SAFE_INTEGER;
		this.transport = {
			write: (bytes) => {
				const copy = bytes.slice();
				queueMicrotask(() => this.#receive(copy));
			},
			onData: (listener) => void this.#data.push(listener),
			onClose: (listener) => void this.#closed.push(listener),
			close: () => this.drop()
		};
	}

	newChannel(): number {
		return this.#next_channel++;
	}

	frame(channel: number, kind: number, payload: Uint8Array): void {
		this.#send(encodeFrame(channel, kind, payload));
	}

	drop(): void {
		if (this.#mode === 'closed') return;
		this.#mode = 'closed';
		this.#core.dropConnection(this);
		queueMicrotask(() => {
			for (const listener of this.#closed) listener();
		});
	}

	#send(bytes: Uint8Array): void {
		if (this.#mode === 'closed') return;
		for (let at = 0; at < bytes.length; at += this.#chunk) {
			const piece = bytes.slice(at, at + this.#chunk);
			queueMicrotask(() => {
				if (this.#mode === 'closed') return;
				for (const listener of this.#data) listener(piece);
			});
		}
	}

	#receive(bytes: Uint8Array): void {
		if (this.#mode === 'closed') return;
		if (this.#mode === 'plain') {
			this.#plain += decoder.decode(bytes);
			const newline = this.#plain.indexOf('\n');
			if (newline < 0) return;
			const line = this.#plain.slice(0, newline);
			this.#plain = '';
			this.#hello(
				JSON.parse(line) as { id: number; method: string; params: Record<string, unknown> }
			);
			return;
		}
		for (const frame of this.#frames.push(bytes)) {
			if (frame.channel !== 0) {
				this.#core.streamFrame(this, frame.channel, frame.kind, frame.payload);
				continue;
			}
			if (frame.kind !== DATA) continue;
			const message = JSON.parse(decoder.decode(frame.payload)) as {
				id: number;
				method: string;
				params: Record<string, unknown>;
			};
			void this.#call(message);
		}
	}

	#hello(message: { id: number; method: string; params: Record<string, unknown> }): void {
		const line = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value) + '\n');
		if (message.method !== 'hello') {
			this.#send(
				line({
					jsonrpc: '2.0',
					id: message.id,
					error: { code: -32600, message: 'say hello first' }
				})
			);
			return;
		}
		const asked = message.params.generation;
		if (asked !== undefined && asked !== null && asked !== this.#core.generation) {
			this.#send(
				line({
					jsonrpc: '2.0',
					id: message.id,
					error: {
						code: -32000,
						message: 'unsupported_generation',
						data: { kind: 'unsupported_generation' }
					}
				})
			);
			return;
		}
		const framed = message.params.framed === true && !this.#core.refuse_framed;
		this.#send(
			line({
				jsonrpc: '2.0',
				id: message.id,
				result: {
					generation: this.#core.generation,
					version: this.#core.version,
					core: { id: 'fake', name: 'fake' },
					framed,
					methods: ['terminal.run', 'terminal.attach', 'events.subscribe', 'file.read'],
					features: []
				}
			})
		);
		if (framed) this.#mode = 'framed';
	}

	async #call(message: {
		id: number;
		method: string;
		params: Record<string, unknown>;
	}): Promise<void> {
		const reply = (value: object): void =>
			this.frame(
				0,
				DATA,
				encoder.encode(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...value }))
			);
		try {
			const answer = await this.#core.handle(this, message.method, message.params ?? {});
			if (
				answer !== null &&
				typeof answer === 'object' &&
				'after' in answer &&
				'result' in answer
			) {
				// A stream: the reply goes out before the stream's first frame.
				const stream = answer as { result: unknown; after: () => void };
				reply({ result: stream.result });
				stream.after();
				return;
			}
			reply({ result: answer });
		} catch (error) {
			const kind = error instanceof RpcFailure ? error.kind : 'internal';
			reply({
				error: {
					code: -32000,
					message: (error as Error).message,
					data: { kind, hint: `fake hint for ${kind}` }
				}
			});
		}
	}
}

function matches(t: FakeTerminal, labels: Record<string, string>): boolean {
	return Object.entries(labels).every(([k, v]) => t.labels[k] === v);
}

function record(t: FakeTerminal): Record<string, unknown> {
	return {
		address: t.address,
		name: t.name,
		labels: { ...t.labels },
		argv: [...t.argv],
		cwd: t.cwd,
		state: t.state,
		created_ms: 0,
		screen: t.screen,
		cols: t.cols,
		rows: t.rows,
		status: t.status,
		reported: t.reported,
		turn: t.turn,
		title: '',
		exit_code: t.exit_code,
		reason: t.reason,
		records: {}
	};
}

function waitResult(t: FakeTerminal, ended: boolean): Record<string, unknown> {
	return {
		terminal: t.address,
		ended,
		reason: t.state === 'finished' ? (t.reason ?? 'exited') : ended ? 'status' : 'timeout',
		turn: t.turn,
		status: t.status?.state ?? null,
		exit_code: t.exit_code,
		signal: null,
		children: []
	};
}
