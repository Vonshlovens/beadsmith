/**
 * The admin terminal relay's browser side (ADR-0021 rule 4). An admin opens a
 * mission's or chat's agent terminal with one POST whose response is a
 * Server-Sent Events stream of the raw output; with `take_over`, keystrokes
 * and size go up through a second route naming the relay. SSE over a POST
 * response rather than a WebSocket: the Node adapter serves no upgrades, and a
 * POST keeps the same-origin and CSRF checks every console mutation gets
 * (opening a take-over changes the agent's terminal size and who types, so it
 * must not be a cross-site GET).
 *
 * Frames: `open` (`{ relay, mode, cols, rows }`) first, then `output`
 * (base64 bytes), `resize` (`{ cols, rows }`, while watching) and a final
 * `end` (`{ reason }`). Comments keep idle proxies from closing the stream.
 *
 * Bytes pass through untouched: never scrubbed, stored or logged (0015 rule 6
 * is why that is acceptable). Each relay is audited in `state.db` before its
 * first byte goes out, and stamped when it ends; one that cannot be recorded
 * is not opened.
 */
import { getTerminalRelayAuditStore } from '../state/db.js';
import type { RelayTargetKind, TerminalRelayAuditStore } from './audit.js';
import {
	TerminalRelayError,
	type RelayMode,
	type TerminalAttachRequest,
	type TerminalRelay
} from './relay.js';

const HEARTBEAT_MS = 15_000;
/** Frames the stream holds before the hc stream waits for the browser. */
const QUEUED_FRAMES = 64;

export const RELAY_NOT_AUDITED_MESSAGE =
	'The terminal could not be opened because the attach could not be recorded.';
export const RELAY_WATCH_ONLY_MESSAGE = 'This relay is watching. Take over to type.';
export const RELAY_CLOSED_MESSAGE = 'This terminal relay has closed.';

interface OpenRelay {
	/** The browser session that opened it; input from any other is "not found". */
	owner: string;
	mode: RelayMode;
	relay: TerminalRelay;
}

const relays = new Map<string, OpenRelay>();

export interface OpenRelayInput {
	/** The browser session (`locals.session_id`) the relay belongs to. */
	owner: string;
	/** Who it is recorded as. */
	actor: string;
	target: { kind: RelayTargetKind; id: string };
	mode: RelayMode;
	cols: number;
	rows: number;
	attach: (request: TerminalAttachRequest) => Promise<TerminalRelay>;
	/** The request's signal: the browser going away ends the relay. */
	signal: AbortSignal;
}

export interface RelayDeps {
	audit?: TerminalRelayAuditStore;
	heartbeat_ms?: number;
	/** Audit write failures at the end of a relay (never bytes). */
	log?: (message: string) => void;
}

const encoder = new TextEncoder();

function frame(event: string, data: string): Uint8Array {
	return encoder.encode(`event: ${event}\ndata: ${data}\n\n`);
}

/**
 * Attach and audit, then return the relay id and its SSE body. Throws
 * `TerminalRelayError` (nothing opened, nothing left recorded as open)
 * when the target has no terminal to attach to or the audit cannot be written.
 */
export async function openTerminalRelay(
	input: OpenRelayInput,
	deps: RelayDeps = {}
): Promise<{ relay_id: string; body: ReadableStream<Uint8Array> }> {
	const log = deps.log ?? ((message: string) => console.warn(message));
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	let done = false;
	let waiters: Array<() => void> = [];
	const wake = () => {
		const pending = waiters;
		waiters = [];
		for (const resolve of pending) resolve();
	};
	let opened!: () => void;
	const ready = new Promise<void>((resolve) => (opened = resolve));
	let finish: (reason: string) => void = () => {};

	const body = new ReadableStream<Uint8Array>(
		{
			start(c) {
				controller = c;
			},
			pull() {
				wake();
			},
			cancel() {
				finish('detached');
			}
		},
		new CountQueuingStrategy({ highWaterMark: QUEUED_FRAMES })
	);

	const push = (bytes: Uint8Array): boolean => {
		if (done) return false;
		try {
			controller.enqueue(bytes);
			return true;
		} catch {
			return false;
		}
	};

	let relay: TerminalRelay;
	try {
		relay = await input.attach({
			mode: input.mode,
			cols: input.cols,
			rows: input.rows,
			// Output waits for the `open` frame, then for room in the stream:
			// a slow browser slows the hc stream instead of growing a buffer.
			async onData(bytes) {
				await ready;
				if (!push(frame('output', Buffer.from(bytes).toString('base64')))) return;
				if ((controller.desiredSize ?? 1) <= 0 && !done) {
					await new Promise<void>((resolve) => waiters.push(resolve));
				}
			},
			onResize(size) {
				void ready.then(() => push(frame('resize', JSON.stringify(size))));
			}
		});
	} catch (error) {
		controller.close();
		throw error;
	}
	if (input.signal.aborted) {
		relay.close();
		controller.close();
		throw new TerminalRelayError('conflict', RELAY_CLOSED_MESSAGE);
	}

	let relay_id: string;
	let audit: TerminalRelayAuditStore;
	try {
		audit = deps.audit ?? (await getTerminalRelayAuditStore());
		relay_id = await audit.start({
			actor: input.actor,
			target_kind: input.target.kind,
			target_id: input.target.id,
			mode: input.mode
		});
	} catch {
		relay.close();
		controller.close();
		throw new TerminalRelayError('unavailable', RELAY_NOT_AUDITED_MESSAGE);
	}
	relays.set(relay_id, { owner: input.owner, mode: input.mode, relay });

	const heartbeat = setInterval(
		() => push(encoder.encode(': keepalive\n\n')),
		deps.heartbeat_ms ?? HEARTBEAT_MS
	);
	heartbeat.unref?.();

	finish = (reason: string) => {
		if (done) return;
		done = true;
		clearInterval(heartbeat);
		relays.delete(relay_id);
		input.signal.removeEventListener('abort', on_abort);
		relay.close();
		wake();
		try {
			controller.close();
		} catch {
			// The browser cancelled the stream already.
		}
		audit.end(relay_id, reason).catch(() => log('terminal relay: could not record an end'));
	};
	const on_abort = () => finish('detached');
	input.signal.addEventListener('abort', on_abort, { once: true });

	push(
		frame(
			'open',
			JSON.stringify({
				relay: relay_id,
				mode: input.mode,
				cols: input.mode === 'take_over' ? input.cols : relay.size.cols,
				rows: input.mode === 'take_over' ? input.rows : relay.size.rows
			})
		)
	);
	opened();
	void relay.ended.then((end) => {
		push(frame('end', JSON.stringify({ reason: end.reason })));
		finish(end.reason);
	});
	return { relay_id, body };
}

export interface RelayInput {
	/** Keystrokes, as the terminal expects them. */
	data?: Uint8Array;
	size?: { cols: number; rows: number };
}

/**
 * Keystrokes or a new size from the admin who took over. A relay that is
 * unknown, closed or another browser session's is "not found"; a watching
 * one refuses input.
 */
export function sendTerminalRelayInput(relay_id: string, owner: string, input: RelayInput): void {
	const open = relays.get(relay_id);
	if (open === undefined || open.owner !== owner) {
		throw new TerminalRelayError('not_found', 'terminal relay not found');
	}
	if (open.mode !== 'take_over') throw new TerminalRelayError('conflict', RELAY_WATCH_ONLY_MESSAGE);
	try {
		if (input.size !== undefined) open.relay.resize(input.size.cols, input.size.rows);
		if (input.data !== undefined && input.data.length > 0) open.relay.write(input.data);
	} catch {
		throw new TerminalRelayError('conflict', RELAY_CLOSED_MESSAGE);
	}
}
