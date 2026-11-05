/**
 * First Mate on the server: the glue between the chat store, the mate runner
 * and the browser (docs/first-mate.md).
 *
 * The runner keeps each chat's agent session alive and is the durable log of
 * what happened in it. Beadsmith stores the events it has relayed, so a chat
 * opens from `state.db` and then catches up from the runner with
 * `after=<last stored runner event id>`. A browser that goes away only closes
 * Beadsmith's stream from the runner; the session keeps working, and the next
 * open picks up what it said meanwhile.
 *
 * Without a runner, a message gets the {@link UNWIRED_REPLY} placeholder,
 * stored as local events so the chat still reads like one.
 */
import { randomUUID } from 'node:crypto';
import { UNWIRED_REPLY, type MateEvent, type MateSendResult, type MateStatus } from '#lib/mate.js';
import { encodeMissionEvent, type MissionEvent } from '#lib/mission-events.js';
import { roleCan, type AccountRole } from '../auth/roles.js';
import { errorResponse } from '../security.js';
import { MateRunnerError, type MateRunner } from './runner.js';
import type { MateStore, StoredMateChat } from './store.js';

/** Events a chat replays from `state.db` when it opens. */
export const MAX_REPLAY_EVENTS = 2_000;
/** SSE comment the browser stream sends while nothing happens. */
export const HEARTBEAT_MS = 15_000;
/** EventSource reconnect delay after the runner stream ends normally. */
const RETRY_MS = 3_000;
/** EventSource reconnect delay after the runner failed. */
const RETRY_AFTER_ERROR_MS = 15_000;
const HEALTH_TTL_MS = 15_000;

let health_cache: { ok: boolean; at: number } | undefined;

/** Clear the cached runner health (tests only). */
export function resetMateHealthCache(): void {
	health_cache = undefined;
}

/**
 * Whether a viewer's messages reach a model. First Mate drives an agent that
 * can change Beads in every project, so only admins talk to it.
 */
export async function mateStatus(
	runner: MateRunner | undefined,
	role: AccountRole | undefined,
	now: () => number = Date.now
): Promise<MateStatus> {
	if (!roleCan(role, { console: ['manage'] })) {
		return { connected: false, reason: 'admin_only' };
	}
	if (runner === undefined) {
		return { connected: false, reason: 'unconfigured' };
	}
	if (health_cache === undefined || now() - health_cache.at > HEALTH_TTL_MS) {
		health_cache = { ok: await runner.health(), at: now() };
	}
	return { connected: true, reachable: health_cache.ok };
}

/** Map a runner failure onto the API error envelope. */
export function mateErrorResponse(error: unknown): Response {
	if (error instanceof MateRunnerError) {
		const code = error.code === 'not_found' ? 'unavailable' : error.code;
		return errorResponse(code, error.message);
	}
	return errorResponse('unavailable', 'The requested service is currently unavailable.');
}

/**
 * Hand one message to the runner, or answer it locally when there is none.
 * The runner's `user` event comes back through the chat's event stream.
 */
export async function sendMateMessage(
	store: MateStore,
	runner: MateRunner | undefined,
	chat: StoredMateChat,
	input: { text: string; message_id?: string }
): Promise<MateSendResult> {
	const message_id = input.message_id ?? randomUUID();
	if (runner === undefined) {
		const events: MissionEvent[] = [
			{ type: 'user', id: `local-${message_id}-u`, text: input.text, message_id },
			{ type: 'assistant', id: `local-${message_id}-a`, text: UNWIRED_REPLY },
			{ type: 'result', id: `local-${message_id}-r`, status: 'succeeded' }
		];
		return { events: await store.appendEvents(chat.id, events, 'local') };
	}
	const { event_id } = await runner.sendMessage(chat.id, {
		session_id: chat.session_id,
		message_id,
		prompt: input.text,
		scope: chat.scope
	});
	return { event_id };
}

function frame(event: MateEvent): string {
	const payload = { ...encodeMissionEvent(event), at: event.at };
	return `id: ${event.id}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export interface MateStreamOptions {
	store: MateStore;
	runner: MateRunner;
	chat: StoredMateChat;
	/** The last event id the browser has (Last-Event-ID or `?after=`). */
	after?: string;
	/** The browser request's signal. */
	signal: AbortSignal;
	heartbeat_ms?: number;
	now?: () => Date;
}

/**
 * The browser's SSE stream for one chat: stored events after `after`, then
 * the runner's live events, each stored before it is forwarded. Frames carry
 * the event id as SSE `id:` so EventSource resumes with Last-Event-ID. A
 * runner failure becomes an `event: runner_error` frame, and the stream
 * closes; EventSource reconnects on its own.
 */
export function mateEventStream(options: MateStreamOptions): ReadableStream<Uint8Array> {
	const { store, runner, chat, signal } = options;
	const now = options.now ?? (() => new Date());
	const encoder = new TextEncoder();
	const ac = new AbortController();
	const stop = () => ac.abort();
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	let closed = false;

	return new ReadableStream<Uint8Array>({
		start(controller) {
			const push = (chunk: string) => {
				if (!closed) {
					controller.enqueue(encoder.encode(chunk));
				}
			};
			const close = () => {
				if (closed) return;
				closed = true;
				clearInterval(heartbeat);
				signal.removeEventListener('abort', stop);
				try {
					controller.close();
				} catch {
					// Already cancelled by the browser.
				}
			};
			if (signal.aborted) {
				ac.abort();
				close();
				return;
			} else {
				signal.addEventListener('abort', stop, { once: true });
			}
			ac.signal.addEventListener('abort', close, { once: true });
			heartbeat = setInterval(() => push(': ping\n\n'), options.heartbeat_ms ?? HEARTBEAT_MS);

			void (async () => {
				try {
					push(`retry: ${RETRY_MS}\n\n`);
					// Capture before replay: another tab may append while we read. A
					// cursor read afterwards could skip events this browser never saw.
					const cursor = await store.lastRunnerEventId(chat.id);
					let after = options.after;
					while (!ac.signal.aborted) {
						const stored = await store.listEvents(chat.id, { after, limit: MAX_REPLAY_EVENTS });
						for (const event of stored) push(frame(event));
						if (stored.length < MAX_REPLAY_EVENTS) break;
						after = stored.at(-1)!.id;
					}
					await runner.streamEvents(
						chat.id,
						cursor,
						async (event) => {
							const fresh = await store.appendEvents(chat.id, [event], 'runner');
							// Another tab may have stored it first; this browser still needs it.
							push(frame(fresh[0] ?? { ...event, at: now().toISOString() }));
						},
						ac.signal
					);
				} catch (error) {
					if (!ac.signal.aborted) {
						const message =
							error instanceof MateRunnerError
								? error.message
								: 'The mate runner stream is temporarily unavailable.';
						push(`retry: ${RETRY_AFTER_ERROR_MS}\n\n`);
						push(`event: runner_error\ndata: ${JSON.stringify({ message })}\n\n`);
					}
				} finally {
					close();
				}
			})();
		},
		cancel() {
			ac.abort();
		}
	});
}

/** Response headers for an SSE stream. */
export const SSE_HEADERS = {
	'content-type': 'text/event-stream; charset=utf-8',
	'cache-control': 'no-store',
	connection: 'keep-alive',
	'x-accel-buffering': 'no'
} as const;
