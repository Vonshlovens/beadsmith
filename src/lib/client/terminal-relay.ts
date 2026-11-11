/**
 * The browser side of the admin terminal relay (ADR-0021 rule 4): what the
 * terminal view shows in each state, and the connection behind it.
 *
 * `POST /api/console/terminals` answers with Server-Sent Events over the POST
 * response (`open`, `output`, `resize`, `end`; see
 * `$lib/server/terminal-relay/service.ts` for why not a WebSocket), so the
 * browser's `EventSource` (GET only) cannot read it: `SseParser` does. A
 * take-over sends keystrokes and its size to `POST
 * /api/console/terminals/:relay`, one request at a time so keys arrive in
 * the order typed.
 *
 * Everything here is plain TypeScript with injected `fetch` and timers, so
 * the states the view draws are tested without a browser. The component
 * (`terminal-view.svelte`) only wires this to xterm.js.
 */
export type RelayMode = 'watch' | 'take_over';
export type RelayTarget = { mission: string } | { chat: string };

export interface RelaySize {
	cols: number;
	rows: number;
}

/** The server's grid bounds (`relay_cells_schema`). */
export const RELAY_MIN_CELLS = 1;
export const RELAY_MAX_CELLS = 1000;

/** Waits before each reconnect; the relay gives up after the last. */
export const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;

// ---------------------------------------------------------------------------
// Server-Sent Events

export interface SseMessage {
	event: string;
	data: string;
}

/**
 * Incremental `text/event-stream` parser: feed it decoded text as it
 * arrives, get back each complete message. Comments (`: keepalive`) and
 * fields other than `event` and `data` are dropped; a message without
 * `event` is `message`, as in the spec.
 */
export class SseParser {
	private buffer = '';
	private event = '';
	private data: string[] = [];

	push(chunk: string): SseMessage[] {
		this.buffer += chunk;
		const out: SseMessage[] = [];
		for (;;) {
			const match = /\r\n|\r|\n/.exec(this.buffer);
			// A lone `\r` at the end may be the first half of `\r\n`.
			if (match === null || (match[0] === '\r' && match.index === this.buffer.length - 1)) break;
			const line = this.buffer.slice(0, match.index);
			this.buffer = this.buffer.slice(match.index + match[0].length);
			if (line === '') {
				if (this.data.length > 0) {
					out.push({ event: this.event || 'message', data: this.data.join('\n') });
				}
				this.event = '';
				this.data = [];
				continue;
			}
			if (line.startsWith(':')) continue;
			const colon = line.indexOf(':');
			const field = colon === -1 ? line : line.slice(0, colon);
			let value = colon === -1 ? '' : line.slice(colon + 1);
			if (value.startsWith(' ')) value = value.slice(1);
			if (field === 'event') this.event = value;
			else if (field === 'data') this.data.push(value);
		}
		return out;
	}
}

export type RelayFrame =
	| { event: 'open'; relay: string; mode: RelayMode; cols: number; rows: number }
	| { event: 'output'; bytes: Uint8Array }
	| { event: 'resize'; cols: number; rows: number }
	| { event: 'end'; reason: string };

function isCells(value: unknown): value is number {
	return (
		typeof value === 'number' &&
		Number.isInteger(value) &&
		value >= RELAY_MIN_CELLS &&
		value <= RELAY_MAX_CELLS
	);
}

/** Base64 to bytes without Node's Buffer (this runs in the browser). */
export function fromBase64(text: string): Uint8Array {
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** Bytes to base64, in slices so a large paste does not overflow the stack. */
export function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}

/** One relay message, or null for anything malformed or unknown. */
export function decodeRelayFrame(message: SseMessage): RelayFrame | null {
	try {
		if (message.event === 'output') return { event: 'output', bytes: fromBase64(message.data) };
		const value = JSON.parse(message.data) as Record<string, unknown>;
		if (message.event === 'open') {
			if (typeof value.relay !== 'string') return null;
			if (value.mode !== 'watch' && value.mode !== 'take_over') return null;
			if (!isCells(value.cols) || !isCells(value.rows)) return null;
			return {
				event: 'open',
				relay: value.relay,
				mode: value.mode,
				cols: value.cols,
				rows: value.rows
			};
		}
		if (message.event === 'resize') {
			if (!isCells(value.cols) || !isCells(value.rows)) return null;
			return { event: 'resize', cols: value.cols, rows: value.rows };
		}
		if (message.event === 'end') {
			return { event: 'end', reason: typeof value.reason === 'string' ? value.reason : 'closed' };
		}
	} catch {
		return null;
	}
	return null;
}

/** A grid the server will accept, from whatever the viewer's box measured. */
export function clampSize(size: RelaySize): RelaySize {
	const clamp = (n: number) =>
		Math.min(RELAY_MAX_CELLS, Math.max(RELAY_MIN_CELLS, Math.floor(n) || RELAY_MIN_CELLS));
	return { cols: clamp(size.cols), rows: clamp(size.rows) };
}

// ---------------------------------------------------------------------------
// States

export type RelayState =
	| { phase: 'idle' }
	| { phase: 'connecting'; mode: RelayMode; attempt: number }
	| { phase: 'live'; mode: RelayMode; relay: string; size: RelaySize }
	| { phase: 'reconnecting'; mode: RelayMode; attempt: number; delay_ms: number }
	| { phase: 'ended'; mode: RelayMode; reason: string }
	| { phase: 'unavailable'; message: string; retry: boolean };

export type RelayAction =
	| { type: 'open'; mode: RelayMode }
	| { type: 'frame'; frame: RelayFrame }
	/** The stream failed or finished without an `end` frame. */
	| { type: 'lost' }
	/** The open request was refused. */
	| { type: 'refused'; status: number; message: string }
	/** The viewer closed the terminal. */
	| { type: 'close' };

export const LOST_MESSAGE =
	"Lost the connection to the agent's terminal and could not get it back.";
export const ADMIN_ONLY_MESSAGE = "Only admins can open an agent's terminal.";

function modeOf(state: RelayState): RelayMode | undefined {
	return 'mode' in state ? state.mode : undefined;
}

/**
 * The relay's next state. Reconnects happen only for a connection that was
 * lost (the stream broke, or hc's channel dropped with `disconnected`); an
 * agent whose program exited, or a refusal, is final until the viewer acts.
 */
export function relayReducer(state: RelayState, action: RelayAction): RelayState {
	switch (action.type) {
		case 'open':
			return { phase: 'connecting', mode: action.mode, attempt: 0 };
		case 'close':
			return { phase: 'idle' };
		case 'refused':
			if (state.phase !== 'connecting') return state;
			return {
				phase: 'unavailable',
				message: action.status === 403 ? ADMIN_ONLY_MESSAGE : action.message,
				retry: action.status !== 403
			};
		case 'lost': {
			if (state.phase !== 'connecting' && state.phase !== 'live') return state;
			const attempt = state.phase === 'connecting' ? state.attempt : 0;
			const delay_ms = RECONNECT_DELAYS_MS[attempt];
			if (delay_ms === undefined)
				return { phase: 'unavailable', message: LOST_MESSAGE, retry: true };
			return { phase: 'reconnecting', mode: state.mode, attempt: attempt + 1, delay_ms };
		}
		case 'frame': {
			const frame = action.frame;
			const mode = modeOf(state);
			if (state.phase !== 'connecting' && state.phase !== 'live') return state;
			if (frame.event === 'open') {
				return {
					phase: 'live',
					mode: frame.mode,
					relay: frame.relay,
					size: { cols: frame.cols, rows: frame.rows }
				};
			}
			if (state.phase !== 'live') return state;
			if (frame.event === 'resize') {
				return { ...state, size: { cols: frame.cols, rows: frame.rows } };
			}
			if (frame.event === 'end') {
				if (frame.reason === 'disconnected') {
					return relayReducer(state, { type: 'lost' });
				}
				return { phase: 'ended', mode: mode!, reason: frame.reason };
			}
			return state;
		}
	}
}

/** The reconnect the state is waiting for, if any. */
export function pendingReconnect(state: RelayState): { mode: RelayMode; delay_ms: number } | null {
	return state.phase === 'reconnecting' ? { mode: state.mode, delay_ms: state.delay_ms } : null;
}

const END_TEXT: Record<string, string> = {
	exited: "The agent's program exited.",
	killed: "The agent's program was stopped.",
	detached: 'The terminal was detached.',
	closed: 'The terminal closed.'
};

export function endText(reason: string): string {
	return END_TEXT[reason] ?? 'The terminal closed.';
}

export type RelayTone = 'idle' | 'pending' | 'live' | 'typing' | 'ended' | 'danger';

export interface RelayView {
	/** Short status for the strip. */
	label: string;
	tone: RelayTone;
	/** One line on what is happening and who is typing. */
	detail: string;
	/** Draw the terminal box (it keeps the last screen while reconnecting). */
	show_screen: boolean;
	/** Keystrokes reach the agent. */
	input: boolean;
	can_watch: boolean;
	can_take_over: boolean;
	can_hand_back: boolean;
	can_retry: boolean;
	can_close: boolean;
}

/**
 * What the terminal view draws for a state. `allow_take_over` is false on a
 * screen without a keyboard (touch, narrow): there the relay is read-only.
 */
export function relayView(state: RelayState, allow_take_over: boolean): RelayView {
	const base: RelayView = {
		label: '',
		tone: 'idle',
		detail: '',
		show_screen: false,
		input: false,
		can_watch: false,
		can_take_over: false,
		can_hand_back: false,
		can_retry: false,
		can_close: false
	};
	switch (state.phase) {
		case 'idle':
			return {
				...base,
				label: 'Closed',
				detail: 'Watch the agent exactly as its CLI draws it. Watching never types or wakes it.',
				can_watch: true,
				can_take_over: allow_take_over
			};
		case 'connecting':
			return {
				...base,
				label: state.mode === 'take_over' ? 'Taking over…' : 'Connecting…',
				tone: 'pending',
				detail:
					state.mode === 'take_over'
						? 'Waking the sandbox if it is paused, then attaching.'
						: "Attaching to the agent's terminal.",
				show_screen: true,
				can_close: true
			};
		case 'live':
			if (state.mode === 'take_over') {
				return {
					...base,
					label: 'You are typing',
					tone: 'typing',
					detail:
						"Your keys go to the agent's terminal. Hand back when you are done; the agent waits while you have unsent text.",
					show_screen: true,
					input: true,
					can_hand_back: true,
					can_close: true
				};
			}
			return {
				...base,
				label: 'Watching',
				tone: 'live',
				detail: 'Read only. The agent is typing; nothing you press reaches it.',
				show_screen: true,
				can_take_over: allow_take_over,
				can_close: true
			};
		case 'reconnecting':
			return {
				...base,
				label: 'Reconnecting…',
				tone: 'pending',
				detail: `Connection lost. Trying again (attempt ${state.attempt} of ${RECONNECT_DELAYS_MS.length}).`,
				show_screen: true,
				can_close: true
			};
		case 'ended':
			return {
				...base,
				label: 'Ended',
				tone: 'ended',
				detail: endText(state.reason),
				show_screen: true,
				can_watch: true,
				can_close: true
			};
		case 'unavailable':
			return {
				...base,
				label: 'Unavailable',
				tone: 'danger',
				detail: state.message,
				can_retry: state.retry,
				can_close: true
			};
	}
}

// ---------------------------------------------------------------------------
// Connection

export type FetchLike = typeof globalThis.fetch;

export interface RelayConnectionDeps {
	fetch?: FetchLike;
	setTimeout?: (fn: () => void, ms: number) => unknown;
	clearTimeout?: (handle: unknown) => void;
}

export interface RelayConnectionEvents {
	onState(state: RelayState): void;
	onOutput(bytes: Uint8Array): void;
	/** The relay began (or began again): clear the screen and size it. */
	onOpen(size: RelaySize, mode: RelayMode): void;
	/** The agent's terminal changed size while watching. */
	onResize(size: RelaySize): void;
}

const TERMINALS = '/api/console/terminals';

async function refusal(response: Response): Promise<{ status: number; message: string }> {
	let message = `The terminal could not be opened (status ${response.status}).`;
	try {
		const body = (await response.json()) as { error?: { message?: unknown } };
		if (typeof body?.error?.message === 'string') message = body.error.message;
	} catch {
		// Not the API's error envelope; keep the generic message.
	}
	return { status: response.status, message };
}

/**
 * One terminal view's relay: opens it, follows its stream, reconnects a
 * lost one with backoff, and sends a take-over's keys in order. `size` is
 * read at each (re)open, so a reconnect asks for the box's current grid.
 */
export class RelayConnection {
	state: RelayState = { phase: 'idle' };
	private readonly fetch: FetchLike;
	private readonly set_timeout: (fn: () => void, ms: number) => unknown;
	private readonly clear_timeout: (handle: unknown) => void;
	private abort: AbortController | null = null;
	private timer: unknown = null;
	private generation = 0;
	private queue: Uint8Array[] = [];
	private pending_size: RelaySize | null = null;
	private sending = false;

	constructor(
		private readonly target: RelayTarget,
		private readonly size: () => RelaySize,
		private readonly events: RelayConnectionEvents,
		deps: RelayConnectionDeps = {}
	) {
		this.fetch = deps.fetch ?? ((...args) => globalThis.fetch(...args));
		this.set_timeout = deps.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
		this.clear_timeout =
			deps.clearTimeout ??
			((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
	}

	private dispatch(action: RelayAction) {
		const next = relayReducer(this.state, action);
		if (next === this.state) return;
		this.state = next;
		this.events.onState(next);
		const reconnect = pendingReconnect(next);
		if (reconnect !== null) {
			const generation = this.generation;
			this.timer = this.set_timeout(() => {
				this.timer = null;
				if (generation === this.generation) this.connect(reconnect.mode, true);
			}, reconnect.delay_ms);
		}
	}

	/** Start watching or taking over, replacing any relay this view holds. */
	open(mode: RelayMode) {
		this.connect(mode, false);
	}

	private connect(mode: RelayMode, reconnecting: boolean) {
		this.teardown();
		const generation = ++this.generation;
		const abort = new AbortController();
		this.abort = abort;
		if (reconnecting && this.state.phase === 'reconnecting') {
			// Keep counting attempts: a reconnect that fails moves to the next delay.
			this.state = { phase: 'connecting', mode, attempt: this.state.attempt };
			this.events.onState(this.state);
		} else {
			this.dispatch({ type: 'open', mode });
		}
		void this.follow(mode, generation, abort.signal);
	}

	private async follow(mode: RelayMode, generation: number, signal: AbortSignal) {
		const current = () => generation === this.generation;
		const body = { ...this.target, mode, ...clampSize(this.size()) };
		let response: Response;
		try {
			response = await this.fetch(TERMINALS, {
				method: 'POST',
				headers: {
					accept: 'text/event-stream',
					'content-type': 'application/json',
					'x-bdx-request': '1'
				},
				credentials: 'same-origin',
				body: JSON.stringify(body),
				signal
			});
		} catch {
			if (current() && !signal.aborted) this.dispatch({ type: 'lost' });
			return;
		}
		if (!current()) {
			void response.body?.cancel().catch(() => {});
			return;
		}
		if (!response.ok || response.body === null) {
			const { status, message } = await refusal(response);
			if (current()) this.dispatch({ type: 'refused', status, message });
			return;
		}
		const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
		const parser = new SseParser();
		let ended = false;
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done || !current()) break;
				for (const message of parser.push(value)) {
					const frame = decodeRelayFrame(message);
					if (frame === null) continue;
					if (frame.event === 'output') {
						this.events.onOutput(frame.bytes);
						continue;
					}
					if (frame.event === 'open') {
						this.events.onOpen({ cols: frame.cols, rows: frame.rows }, frame.mode);
					} else if (frame.event === 'resize') {
						this.events.onResize({ cols: frame.cols, rows: frame.rows });
					} else {
						ended = true;
					}
					this.dispatch({ type: 'frame', frame });
				}
			}
		} catch {
			// The stream broke; handled below as a lost connection.
		} finally {
			reader.releaseLock();
		}
		if (current() && !ended && !signal.aborted) this.dispatch({ type: 'lost' });
	}

	/** Keystrokes from a take-over. Dropped unless the relay takes input. */
	write(bytes: Uint8Array) {
		if (this.state.phase !== 'live' || this.state.mode !== 'take_over' || bytes.length === 0) {
			return;
		}
		this.queue.push(bytes);
		void this.flush();
	}

	/** The take-over's new grid (watching follows the agent's size instead). */
	resize(size: RelaySize) {
		if (this.state.phase !== 'live' || this.state.mode !== 'take_over') return;
		this.pending_size = clampSize(size);
		void this.flush();
	}

	private async flush() {
		if (this.sending) return;
		this.sending = true;
		try {
			while (this.state.phase === 'live' && this.state.mode === 'take_over') {
				const relay = this.state.relay;
				const size = this.pending_size;
				const parts = this.queue;
				if (size === null && parts.length === 0) break;
				this.pending_size = null;
				this.queue = [];
				const length = parts.reduce((sum, part) => sum + part.length, 0);
				const data = new Uint8Array(length);
				let offset = 0;
				for (const part of parts) {
					data.set(part, offset);
					offset += part.length;
				}
				const body: Record<string, unknown> = {};
				if (length > 0) body.data = toBase64(data);
				if (size !== null) Object.assign(body, size);
				try {
					const response = await this.fetch(`${TERMINALS}/${encodeURIComponent(relay)}`, {
						method: 'POST',
						headers: { 'content-type': 'application/json', 'x-bdx-request': '1' },
						credentials: 'same-origin',
						body: JSON.stringify(body)
					});
					// A refused write means the relay is gone; its stream says why.
					if (!response.ok) break;
				} catch {
					break;
				}
			}
		} finally {
			this.sending = false;
		}
	}

	private teardown() {
		this.generation += 1;
		this.abort?.abort();
		this.abort = null;
		if (this.timer !== null) {
			this.clear_timeout(this.timer);
			this.timer = null;
		}
		this.queue = [];
		this.pending_size = null;
	}

	/** Detach (hands back a take-over) and forget the relay. */
	close() {
		this.teardown();
		this.dispatch({ type: 'close' });
	}
}
