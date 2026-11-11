/**
 * A client for herdr-core (`hc`, protocol generation 1) over any duplex byte
 * channel. ADR-0021 runs every agent in an hc terminal inside its sandbox and
 * reaches that core only through a channel Beadsmith already controls: `hc
 * connect` as an E2B background command on Sand, `ssh <guest> hc connect` from
 * the forge runner. Both give stdin and stdout, so this client takes a
 * {@link HcTransport} and nothing else; it never opens a socket or port.
 *
 * The connection says `hello` with `generation: 1` and `framed: true` (a
 * core of another generation is refused), then speaks framed mode: JSON-RPC
 * on channel 0, attach streams and the event stream on channels of their own
 * (see ./frames.ts). Calls run side by side.
 *
 * What is deliberately missing: `line` (a shell string) and `on` (another
 * machine) are never sent; `terminal.send` never sets `force`, so a program
 * that is `blocked` on a question is not answered blindly (ADR-0021 rule 2);
 * runs are always `no_parent` and `no_notify` (Beadsmith terminals have no hc
 * parent) and never `keep` (resume starts a new terminal instead).
 *
 * The method list and result shapes follow `hc schema` (OpenRPC). Only the
 * fields Beadsmith reads are typed; results are checked for those fields.
 *
 * Plain JavaScript only (no Node or SvelteKit imports), for the same reason
 * as ./frames.ts.
 */

import { HcError } from './errors.js';
import {
	AUTOMATIC_INPUT,
	CLOSE,
	CREDIT,
	DATA,
	FACTS,
	FOCUS,
	FrameDecoder,
	FrameError,
	LineDecoder,
	RESIZE,
	concat,
	decodeSize,
	encodeFrame,
	encodeSize,
	encodeU32,
	type Frame
} from './frames.js';
import * as check from './validate.js';

export { HcError } from './errors.js';

export const PROTOCOL_GENERATION = 1;

/** A duplex byte channel: a child process's stdio, an E2B command, a test pipe. */
export interface HcTransport {
	write(bytes: Uint8Array): void;
	onData(listener: (bytes: Uint8Array) => void): void;
	/** The channel ended; `error` when it failed rather than closed. */
	onClose(listener: (error?: Error) => void): void;
	close(): void;
}

/** OSC 7501 status as the program reported it. `state` is the word: idle, working, done, blocked, error, ... */
export interface HcStatus {
	state: string;
	app?: string;
	msg?: string;
	title?: string;
	kind?: string | null;
	progress?: number | null;
}

export interface HcTerminal {
	address: string;
	name?: string | null;
	labels: Record<string, string>;
	argv: string[];
	cwd: string;
	/** `live` or `finished`. */
	state: string;
	created_ms: number;
	cols: number;
	rows: number;
	pid?: number | null;
	status?: HcStatus | null;
	/** Whether the program ever reported a status. */
	reported?: boolean;
	/** Advances each time the program ends a turn. */
	turn?: number;
	title?: string;
	exit_code?: number | null;
	signal?: number | null;
	reason?: string | null;
	finished_ms?: number | null;
}

export interface HcHello {
	generation: number;
	version: string;
	methods: string[];
	features: string[];
}

export interface HcRunOptions {
	argv: string[];
	/** Absolute; the core's own folder when left out. */
	cwd?: string;
	/** Added to the core's environment for this program. */
	env?: Record<string, string>;
	labels?: Record<string, string>;
	/** Unique among live terminals. */
	name?: string;
	size?: { cols: number; rows: number };
}

export interface HcReadResult {
	text: string;
	complete: boolean;
	how: string;
	why?: string | null;
}

export interface HcSendResult {
	/** The turn counter when the text went in. */
	turn: number;
	status?: string | null;
	started?: boolean | null;
}

export interface HcInterruptResult {
	/** What hc observed after pressing the stop key. */
	outcome: string;
	key: string;
}

export interface HcWaitResult {
	terminal: string;
	/** False when the wait checked in (timeout) with the program still working. */
	ended: boolean;
	reason: string;
	turn: number;
	status?: string | null;
	exit_code?: number | null;
	signal?: number | null;
}

export interface HcFileReadResult {
	text: string;
	first: number;
	last: number;
	/** Lines in the whole file. */
	lines: number;
}

/** One message on an event subscription (see herdr-core's schema/README.md, "Events"). */
export type HcNotification =
	| {
			method: 'event';
			seq: number;
			type: string;
			terminal: string | null;
			data: Record<string, unknown> | null;
	  }
	| { method: 'heartbeat'; seq: number }
	| { method: 'missed'; seq: number; terminals: HcTerminal[] };

export interface HcEventFilter {
	terminal?: string;
	labels?: Record<string, string>;
}

export interface HcSubscription {
	/** `seq` and the matching terminals when the subscription began. */
	readonly seq: number;
	readonly terminals: HcTerminal[];
	/** Resolves when the stream ends: closed by either side or the connection. */
	readonly closed: Promise<void>;
	close(): void;
}

/** Why an attach stream ended, as the core said (`exited`, `killed`, ...), or `detached`/`disconnected`. */
export interface HcStreamEnd {
	reason: string;
	exit_code?: number | null;
	signal?: number | null;
}

export interface HcAttachOptions {
	cols: number;
	rows: number;
	/** Watch only: hc ignores input and size from this viewer. */
	observe?: boolean;
	/** Scrollback lines in the first paint. */
	history?: number;
}

export interface HcAttachHandlers {
	/**
	 * Raw terminal output. Credit for the bytes goes back to the core when the
	 * listener returns, or when its promise settles: a slow consumer (a relay
	 * to a browser) slows the stream instead of buffering it.
	 */
	onData(bytes: Uint8Array): void | Promise<void>;
	/** The core announced a new grid (only with resize notifications). */
	onResize?(size: { cols: number; rows: number }): void;
	onEnd?(end: HcStreamEnd): void;
}

export interface HcAttachment {
	readonly channel: number;
	readonly terminal: HcTerminal;
	readonly observe: boolean;
	/** Resolves with the reason once the stream is over. */
	readonly ended: Promise<HcStreamEnd>;
	/** Keystrokes from the viewer. Refused on an observe attachment. */
	write(bytes: Uint8Array): void;
	/** Refused on an observe attachment. */
	resize(cols: number, rows: number): void;
	focus(gained: boolean): void;
	/** Detach. The core answers with an empty CLOSE. */
	close(): void;
}

export interface HcClientOptions {
	/** Time allowed for a reply (default 30 s). Waits get their own timeout plus this. */
	timeout_ms?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** Keystrokes go out in pieces no larger than hc's own stream chunks. */
const WRITE_CHUNK = 16 * 1024;

interface Pending {
	resolve(value: unknown): void;
	reject(error: HcError): void;
	timer: ReturnType<typeof setTimeout>;
}

interface Channel {
	frame(frame: Frame): void;
	end(end: HcStreamEnd): void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Open a client on `transport`: send `hello`, check the generation, switch
 * to framed mode. Rejects (and closes the transport) on any other answer.
 */
export function connectHc(
	transport: HcTransport,
	options: HcClientOptions = {}
): Promise<HcClient> {
	const client = new HcClient(transport, options);
	return client.hello().then(
		() => client,
		(error: unknown) => {
			client.close();
			throw error;
		}
	);
}

export class HcClient {
	readonly #transport: HcTransport;
	readonly #timeout_ms: number;
	#mode: 'plain' | 'framed' | 'closed' = 'plain';
	#plain: Uint8Array = new Uint8Array(0);
	#frames = new FrameDecoder();
	#next_id = 1;
	#pending = new Map<number, Pending>();
	#channels = new Map<number, Channel>();
	#hello: HcHello | null = null;
	#hello_wait: Pending | null = null;
	#closed_listeners: Array<(error?: Error) => void> = [];

	constructor(transport: HcTransport, options: HcClientOptions = {}) {
		this.#transport = transport;
		this.#timeout_ms = options.timeout_ms ?? DEFAULT_TIMEOUT_MS;
		transport.onData((bytes) => this.#receive(bytes));
		transport.onClose((error) =>
			this.#shutdown(
				new HcError(error ? `hc connection failed: ${error.message}` : 'hc connection closed', {
					kind: 'disconnected'
				})
			)
		);
	}

	/** What the core said in `hello`; null before the handshake. */
	get info(): HcHello | null {
		return this.#hello;
	}

	get closed(): boolean {
		return this.#mode === 'closed';
	}

	/** Called once when the connection ends, for whatever reason. */
	onClose(listener: (error?: Error) => void): void {
		this.#closed_listeners.push(listener);
	}

	/** The handshake. {@link connectHc} calls it; call it yourself only on a client you built. */
	hello(): Promise<HcHello> {
		if (this.#hello) return Promise.resolve(this.#hello);
		if (this.#mode !== 'plain' || this.#hello_wait) {
			return Promise.reject(new HcError('hello already sent', { kind: 'protocol' }));
		}
		const id = this.#next_id++;
		const reply = new Promise<unknown>((resolve, reject) => {
			this.#hello_wait = {
				resolve,
				reject,
				timer: setTimeout(
					() => this.#shutdown(new HcError('hc did not answer hello', { kind: 'timeout' })),
					this.#timeout_ms
				)
			};
		});
		const message = {
			jsonrpc: '2.0',
			id,
			method: 'hello',
			params: { generation: PROTOCOL_GENERATION, framed: true }
		};
		this.#transport.write(encoder.encode(JSON.stringify(message) + '\n'));
		return reply.then((raw) => {
			const result = object(raw, 'hello');
			const hello: HcHello = {
				generation: num(result.generation, 'hello.generation'),
				version: str(result.version, 'hello.version'),
				methods: strings(result.methods, 'hello.methods'),
				features: strings(result.features, 'hello.features')
			};
			if (hello.generation !== PROTOCOL_GENERATION) {
				throw new HcError(
					`hc speaks protocol generation ${hello.generation}; this client speaks ${PROTOCOL_GENERATION}`,
					{ kind: 'unsupported_generation' }
				);
			}
			if (result.framed !== true) {
				throw new HcError('hc did not switch to framed mode', { kind: 'protocol' });
			}
			this.#hello = hello;
			return hello;
		});
	}

	/** Start a program in a new terminal. */
	async run(options: HcRunOptions): Promise<HcTerminal> {
		const params: Record<string, unknown> = {
			argv: check.argv(options.argv),
			no_parent: true,
			no_notify: true,
			keep: false,
			wait: false
		};
		if (options.cwd !== undefined) params.cwd = check.absolutePath(options.cwd, 'cwd');
		if (options.env !== undefined) params.env = check.env(options.env);
		if (options.labels !== undefined) params.labels = check.labels(options.labels);
		if (options.name !== undefined) params.name = check.terminalId(options.name);
		if (options.size !== undefined) {
			params.size = {
				cols: check.cells(options.size.cols, 'cols'),
				rows: check.cells(options.size.rows, 'rows')
			};
		}
		return terminal(await this.#call('terminal.run', params));
	}

	async list(
		options: { all?: boolean; labels?: Record<string, string> } = {}
	): Promise<HcTerminal[]> {
		const params: Record<string, unknown> = { all: options.all === true };
		if (options.labels !== undefined) params.labels = check.labels(options.labels);
		const result = object(await this.#call('terminal.list', params), 'terminal.list');
		return array(result.terminals, 'terminal.list.terminals').map(terminal);
	}

	async get(id: string): Promise<HcTerminal> {
		return terminal(await this.#call('terminal.get', { terminal: check.terminalId(id) }));
	}

	/** The screen plus `lines` of history, as text. */
	async read(id: string, options: { lines?: number } = {}): Promise<HcReadResult> {
		const params: Record<string, unknown> = { terminal: check.terminalId(id) };
		if (options.lines !== undefined) params.lines = check.history(options.lines);
		const result = object(await this.#call('terminal.read', params), 'terminal.read');
		return {
			text: str(result.text, 'terminal.read.text'),
			complete: bool(result.complete, 'terminal.read.complete'),
			how: str(result.how, 'terminal.read.how'),
			why: optionalStr(result.why)
		};
	}

	/**
	 * Paste text and press Enter. hc holds it while an attached person has an
	 * unsent draft. `only_if` sends only when the status is exactly that word.
	 * A `blocked` program refuses with kind `blocked`; that is surfaced, never
	 * forced.
	 */
	async send(
		id: string,
		message: string,
		options: { only_if?: 'idle' | 'working' } = {}
	): Promise<HcSendResult> {
		const params: Record<string, unknown> = {
			terminal: check.terminalId(id),
			text: check.text(message)
		};
		if (options.only_if !== undefined) {
			if (options.only_if !== 'idle' && options.only_if !== 'working') {
				throw new HcError('only_if must be idle or working', { kind: 'invalid_params' });
			}
			params.if = options.only_if;
		}
		const result = object(await this.#call('terminal.send', params), 'terminal.send');
		return {
			turn: num(result.turn, 'terminal.send.turn'),
			status: optionalStr(result.status),
			started: typeof result.started === 'boolean' ? result.started : null
		};
	}

	/** Press named keys (`enter`, `esc`, `ctrl+c`, ...). */
	async keys(id: string, names: string[]): Promise<{ turn: number; status: string | null }> {
		const result = object(
			await this.#call('terminal.keys', {
				terminal: check.terminalId(id),
				keys: check.keys(names)
			}),
			'terminal.keys'
		);
		return { turn: num(result.turn, 'terminal.keys.turn'), status: optionalStr(result.status) };
	}

	/** Press the stop key and report what happened. Never escalates. */
	async interrupt(id: string, options: { timeout_s?: number } = {}): Promise<HcInterruptResult> {
		const params: Record<string, unknown> = { terminal: check.terminalId(id) };
		let timeout_ms = this.#timeout_ms;
		if (options.timeout_s !== undefined) {
			params.timeout = check.timeoutSeconds(options.timeout_s);
			timeout_ms += options.timeout_s * 1000;
		}
		const result = object(
			await this.#call('terminal.interrupt', params, timeout_ms),
			'terminal.interrupt'
		);
		return {
			outcome: str(result.outcome, 'interrupt.outcome'),
			key: str(result.key, 'interrupt.key')
		};
	}

	/**
	 * Wait until the program is not working. Returns with `ended: false` when
	 * `timeout_s` passes first (hc's default is 180 s); the program keeps running.
	 */
	async wait(id: string, options: { timeout_s?: number } = {}): Promise<HcWaitResult> {
		const params: Record<string, unknown> = { terminal: check.terminalId(id) };
		const timeout_s =
			options.timeout_s === undefined ? 180 : check.timeoutSeconds(options.timeout_s);
		params.timeout = timeout_s;
		const result = object(
			await this.#call('terminal.wait', params, this.#timeout_ms + timeout_s * 1000),
			'terminal.wait'
		);
		return {
			terminal: str(result.terminal, 'terminal.wait.terminal'),
			ended: bool(result.ended, 'terminal.wait.ended'),
			reason: str(result.reason, 'terminal.wait.reason'),
			turn: num(result.turn, 'terminal.wait.turn'),
			status: optionalStr(result.status),
			exit_code: optionalNum(result.exit_code),
			signal: optionalNum(result.signal)
		};
	}

	/** End the program (hangup, terminate, kill) and return the record as observed. */
	async kill(id: string): Promise<HcTerminal> {
		return terminal(await this.#call('terminal.kill', { terminal: check.terminalId(id) }));
	}

	/** Remove a finished terminal. */
	async remove(id: string): Promise<void> {
		await this.#call('terminal.rm', { terminal: check.terminalId(id) });
	}

	/**
	 * Read a text file on the core's machine: lines from `offset` (from 1), at
	 * most `limit`, and the file's line count. ADR-0021 reads the agent's
	 * transcript this way, over the same connection.
	 */
	async readFile(
		path: string,
		options: { offset?: number; limit?: number } = {}
	): Promise<HcFileReadResult> {
		const params: Record<string, unknown> = { path: check.absolutePath(path, 'path') };
		if (options.offset !== undefined)
			params.offset = check.integer(options.offset, 'offset', 1, Number.MAX_SAFE_INTEGER);
		if (options.limit !== undefined)
			params.limit = check.integer(options.limit, 'limit', 1, 10_000_000);
		const result = object(await this.#call('file.read', params), 'file.read');
		return {
			text: str(result.text, 'file.read.text'),
			first: num(result.first, 'file.read.first'),
			last: num(result.last, 'file.read.last'),
			lines: num(result.lines, 'file.read.lines')
		};
	}

	/**
	 * Follow terminal facts: a snapshot, then every change as a notification
	 * on a channel of its own (status, turn, finished, ...). `listener` sees
	 * every notification in order, starting right after the snapshot.
	 */
	async subscribe(
		filter: HcEventFilter,
		listener: (notification: HcNotification) => void
	): Promise<HcSubscription> {
		const params: Record<string, unknown> = {};
		if (filter.terminal !== undefined) params.terminal = check.terminalId(filter.terminal);
		if (filter.labels !== undefined) params.labels = check.labels(filter.labels);
		let ended: () => void = () => {};
		const closed = new Promise<void>((resolve) => (ended = resolve));
		let channel_id = 0;
		const result = object(
			await this.#call('events.subscribe', params, this.#timeout_ms, (raw) => {
				// Install the channel as the reply is read: hc sends a stream's
				// reply before its first frame, so nothing is missed.
				const reply = object(raw, 'events.subscribe');
				channel_id = num(reply.channel, 'events.subscribe.channel');
				this.#openEvents(channel_id, listener, () => ended());
			}),
			'events.subscribe'
		);
		return {
			seq: num(result.seq, 'events.subscribe.seq'),
			terminals: array(result.terminals, 'events.subscribe.terminals').map(terminal),
			closed,
			close: () => this.#detach(channel_id)
		};
	}

	/**
	 * Open the terminal's raw stream. With `observe` (the default for a relay)
	 * the viewer only watches; without it this viewer types and sets the size.
	 */
	async attach(
		id: string,
		options: HcAttachOptions,
		handlers: HcAttachHandlers
	): Promise<HcAttachment> {
		const observe = options.observe === true;
		const params: Record<string, unknown> = {
			terminal: check.terminalId(id),
			cols: check.cells(options.cols, 'cols'),
			rows: check.cells(options.rows, 'rows'),
			observe,
			resize_notifications: observe
		};
		if (options.history !== undefined) params.history = check.history(options.history);
		let resolve_end: (end: HcStreamEnd) => void = () => {};
		const ended = new Promise<HcStreamEnd>((resolve) => (resolve_end = resolve));
		let channel_id = 0;
		const result = object(
			await this.#call('terminal.attach', params, this.#timeout_ms, (raw) => {
				const reply = object(raw, 'terminal.attach');
				channel_id = num(reply.channel, 'terminal.attach.channel');
				this.#openStream(channel_id, handlers, (end) => {
					handlers.onEnd?.(end);
					resolve_end(end);
				});
			}),
			'terminal.attach'
		);
		const record = terminal(result.terminal);
		const send = (kind: number, payload: Uint8Array): void => {
			if (!this.#channels.has(channel_id)) {
				throw new HcError('the attach stream has ended', { kind: 'finished' });
			}
			this.#sendFrame(channel_id, kind, payload);
		};
		const refuseObserver = (what: string): void => {
			if (observe)
				throw new HcError(`an observing viewer cannot ${what}`, { kind: 'invalid_params' });
		};
		return {
			channel: channel_id,
			terminal: record,
			observe,
			ended,
			write: (bytes) => {
				refuseObserver('type');
				for (let at = 0; at < bytes.length; at += WRITE_CHUNK) {
					send(DATA, bytes.subarray(at, at + WRITE_CHUNK));
				}
			},
			resize: (cols, rows) => {
				refuseObserver('resize');
				send(RESIZE, encodeSize(check.cells(cols, 'cols'), check.cells(rows, 'rows')));
			},
			focus: (gained) => send(FOCUS, new Uint8Array([gained ? 1 : 0])),
			close: () => this.#detach(channel_id)
		};
	}

	/** Close the connection. Outstanding calls fail with kind `disconnected`. */
	close(): void {
		if (this.#mode === 'closed') return;
		this.#shutdown(new HcError('hc connection closed', { kind: 'disconnected' }));
	}

	// ── internals ───────────────────────────────────────────────────────────

	#call(
		method: string,
		params: Record<string, unknown>,
		timeout_ms = this.#timeout_ms,
		before_resolve?: (result: unknown) => void
	): Promise<unknown> {
		if (this.#mode !== 'framed') {
			return Promise.reject(
				new HcError(this.#mode === 'closed' ? 'hc connection closed' : 'hello has not completed', {
					kind: this.#mode === 'closed' ? 'disconnected' : 'protocol'
				})
			);
		}
		const id = this.#next_id++;
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new HcError(`hc did not answer ${method} in ${timeout_ms} ms`, { kind: 'timeout' }));
			}, timeout_ms);
			this.#pending.set(id, {
				resolve: (result) => {
					try {
						before_resolve?.(result);
					} catch (error) {
						reject(error as HcError);
						return;
					}
					resolve(result);
				},
				reject,
				timer
			});
			const message = { jsonrpc: '2.0', id, method, params };
			this.#sendFrame(0, DATA, encoder.encode(JSON.stringify(message)));
		});
	}

	#sendFrame(channel: number, kind: number, payload: Uint8Array): void {
		if (this.#mode === 'closed')
			throw new HcError('hc connection closed', { kind: 'disconnected' });
		this.#transport.write(encodeFrame(channel, kind, payload));
	}

	#receive(bytes: Uint8Array): void {
		if (this.#mode === 'closed') return;
		try {
			if (this.#mode === 'plain') {
				this.#plain = concat(this.#plain, bytes);
				const newline = this.#plain.indexOf(0x0a);
				if (newline < 0) {
					if (this.#plain.length > 1 << 20) throw new FrameError('hello reply is too long');
					return;
				}
				const line = decoder.decode(this.#plain.subarray(0, newline));
				const rest = this.#plain.slice(newline + 1);
				this.#plain = new Uint8Array(0);
				this.#answerHello(line);
				// The core switched to framed mode after its reply.
				// (#answerHello moved #mode on; TypeScript can't see that.)
				if (rest.length > 0 && (this.#mode as string) === 'framed') this.#receive(rest);
				return;
			}
			for (const frame of this.#frames.push(bytes)) this.#dispatch(frame);
		} catch (error) {
			this.#shutdown(
				error instanceof HcError
					? error
					: new HcError(`hc sent something unreadable: ${(error as Error).message}`, {
							kind: 'protocol'
						})
			);
		}
	}

	#answerHello(line: string): void {
		const wait = this.#hello_wait;
		if (!wait) throw new FrameError('a line arrived before hello was sent');
		this.#hello_wait = null;
		clearTimeout(wait.timer);
		const message = parseMessage(line);
		if (message.error !== undefined) {
			const error = rpcError(message.error);
			wait.reject(error);
			return;
		}
		const result = message.result as { framed?: unknown } | undefined;
		if (result && typeof result === 'object' && result.framed === true) this.#mode = 'framed';
		wait.resolve(message.result);
	}

	#dispatch(frame: Frame): void {
		if (frame.channel === 0) {
			if (frame.kind !== DATA) return;
			const message = parseMessage(decoder.decode(frame.payload));
			if (typeof message.id !== 'number') return; // channel 0 notifications aren't used in framed mode
			const pending = this.#pending.get(message.id);
			if (!pending) return; // a reply after its timeout
			this.#pending.delete(message.id);
			clearTimeout(pending.timer);
			if (message.error !== undefined) pending.reject(rpcError(message.error));
			else pending.resolve(message.result);
			return;
		}
		// hc sends a stream's reply before its first frame, and the reply
		// installs the channel, so an unknown channel is one this client has
		// already detached from: its last frames and the core's CLOSE answer.
		this.#channels.get(frame.channel)?.frame(frame);
	}

	#install(channel_id: number, channel: Channel): void {
		if (channel_id <= 0 || this.#channels.has(channel_id)) {
			throw new HcError(`hc opened channel ${channel_id} twice`, { kind: 'protocol' });
		}
		this.#channels.set(channel_id, channel);
	}

	#openEvents(channel_id: number, listener: (n: HcNotification) => void, ended: () => void): void {
		const lines = new LineDecoder();
		this.#install(channel_id, {
			frame: (frame) => {
				if (frame.kind === CLOSE) {
					this.#channels.delete(channel_id);
					ended();
					return;
				}
				if (frame.kind !== DATA) return;
				for (const line of lines.push(frame.payload)) {
					const notification = parseNotification(line);
					if (!notification) continue;
					try {
						listener(notification);
					} catch (error) {
						// A listener's bug must not take the connection down with it.
						console.error('hc event listener failed', error);
					}
				}
				this.#credit(channel_id, frame.payload.length);
			},
			end: () => ended()
		});
	}

	#openStream(
		channel_id: number,
		handlers: HcAttachHandlers,
		ended: (end: HcStreamEnd) => void
	): void {
		// Output is handed over in order: a listener that returns a promise
		// holds the next chunk (and the credit) until it settles.
		let queue: Promise<void> = Promise.resolve();
		let done = false;
		const finish = (end: HcStreamEnd): void => {
			if (done) return;
			done = true;
			this.#channels.delete(channel_id);
			queue = queue.then(() => ended(end));
		};
		this.#install(channel_id, {
			frame: (frame) => {
				if (done) return;
				switch (frame.kind) {
					case DATA: {
						const length = frame.payload.length;
						if (length === 0) return;
						queue = queue
							.then(() => handlers.onData(frame.payload))
							.catch(() => {})
							.then(() => this.#credit(channel_id, length));
						return;
					}
					case RESIZE: {
						const size = decodeSize(frame.payload);
						queue = queue.then(() => handlers.onResize?.(size));
						return;
					}
					case CLOSE:
						finish(closeReason(frame.payload));
						return;
					case CREDIT:
					case FOCUS:
					case FACTS:
					case AUTOMATIC_INPUT:
						return;
				}
			},
			end: finish
		});
	}

	#credit(channel_id: number, bytes: number): void {
		if (bytes === 0 || this.#mode !== 'framed' || !this.#channels.has(channel_id)) return;
		this.#sendFrame(channel_id, CREDIT, encodeU32(bytes));
	}

	#detach(channel_id: number): void {
		const channel = this.#channels.get(channel_id);
		if (!channel || this.#mode !== 'framed') return;
		this.#sendFrame(channel_id, CLOSE, new Uint8Array(0));
		this.#channels.delete(channel_id);
		channel.end({ reason: 'detached' });
	}

	#shutdown(error: HcError): void {
		if (this.#mode === 'closed') return;
		this.#mode = 'closed';
		if (this.#hello_wait) {
			clearTimeout(this.#hello_wait.timer);
			this.#hello_wait.reject(error);
			this.#hello_wait = null;
		}
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.#pending.clear();
		const channels = [...this.#channels.values()];
		this.#channels.clear();
		for (const channel of channels) channel.end({ reason: 'disconnected' });
		try {
			this.#transport.close();
		} catch {
			// Already closed.
		}
		const listeners = this.#closed_listeners;
		this.#closed_listeners = [];
		for (const listener of listeners) listener(error.kind === 'disconnected' ? undefined : error);
	}
}

// ── result checks ───────────────────────────────────────────────────────────

interface RpcMessage {
	id?: unknown;
	result?: unknown;
	error?: unknown;
	method?: unknown;
	params?: unknown;
}

function parseMessage(text: string): RpcMessage {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new FrameError('a JSON-RPC message is not JSON');
	}
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new FrameError('a JSON-RPC message is not an object');
	}
	return value as RpcMessage;
}

function rpcError(raw: unknown): HcError {
	if (raw === null || typeof raw !== 'object')
		return new HcError('hc reported an error', { kind: 'protocol' });
	const error = raw as { code?: unknown; message?: unknown; data?: unknown };
	const data = (error.data ?? {}) as { kind?: unknown; hint?: unknown };
	return new HcError(typeof error.message === 'string' ? error.message : 'hc reported an error', {
		kind: typeof data.kind === 'string' ? data.kind : 'unknown',
		code: typeof error.code === 'number' ? error.code : undefined,
		hint: typeof data.hint === 'string' ? data.hint : null
	});
}

function parseNotification(line: string): HcNotification | null {
	const message = parseMessage(line);
	const params = (message.params ?? {}) as Record<string, unknown>;
	switch (message.method) {
		case 'event':
			return {
				method: 'event',
				seq: num(params.seq, 'event.seq'),
				type: str(params.type, 'event.type'),
				terminal: typeof params.terminal === 'string' ? params.terminal : null,
				data:
					params.data !== null && typeof params.data === 'object' && !Array.isArray(params.data)
						? (params.data as Record<string, unknown>)
						: null
			};
		case 'heartbeat':
			return { method: 'heartbeat', seq: num(params.seq, 'heartbeat.seq') };
		case 'missed':
			return {
				method: 'missed',
				seq: num(params.seq, 'missed.seq'),
				terminals: array(params.terminals, 'missed.terminals').map(terminal)
			};
		default:
			return null; // a later core's notification this client doesn't know
	}
}

function closeReason(payload: Uint8Array): HcStreamEnd {
	if (payload.length === 0) return { reason: 'detached' };
	try {
		const value = JSON.parse(decoder.decode(payload)) as Record<string, unknown>;
		return {
			reason: typeof value.reason === 'string' ? value.reason : 'closed',
			exit_code: optionalNum(value.exit_code),
			signal: optionalNum(value.signal)
		};
	} catch {
		return { reason: 'closed' };
	}
}

function terminal(raw: unknown): HcTerminal {
	const value = object(raw, 'terminal');
	const labels = object(value.labels ?? {}, 'terminal.labels');
	for (const v of Object.values(labels)) str(v, 'terminal.labels');
	const status = value.status;
	return {
		...(value as object),
		address: str(value.address, 'terminal.address'),
		labels: labels as Record<string, string>,
		argv: strings(value.argv, 'terminal.argv'),
		cwd: str(value.cwd, 'terminal.cwd'),
		state: str(value.state, 'terminal.state'),
		created_ms: num(value.created_ms, 'terminal.created_ms'),
		cols: num(value.cols, 'terminal.cols'),
		rows: num(value.rows, 'terminal.rows'),
		status:
			status === null || status === undefined
				? null
				: {
						...object(status, 'terminal.status'),
						state: str(object(status, 'terminal.status').state, 'status.state')
					},
		turn: value.turn === undefined ? undefined : num(value.turn, 'terminal.turn')
	} as HcTerminal;
}

function malformed(what: string): HcError {
	return new HcError(`hc sent a malformed ${what}`, { kind: 'protocol' });
}

function object(value: unknown, what: string): Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) throw malformed(what);
	return value as Record<string, unknown>;
}

function array(value: unknown, what: string): unknown[] {
	if (!Array.isArray(value)) throw malformed(what);
	return value;
}

function str(value: unknown, what: string): string {
	if (typeof value !== 'string') throw malformed(what);
	return value;
}

function strings(value: unknown, what: string): string[] {
	return array(value, what).map((v) => str(v, what));
}

function num(value: unknown, what: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) throw malformed(what);
	return value;
}

function bool(value: unknown, what: string): boolean {
	if (typeof value !== 'boolean') throw malformed(what);
	return value;
}

function optionalStr(value: unknown): string | null {
	return typeof value === 'string' ? value : null;
}

function optionalNum(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
