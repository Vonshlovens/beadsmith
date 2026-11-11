/**
 * Client for the mate runner, the service that keeps each First Mate chat's
 * agent session alive (contract v1, docs/first-mate.md):
 *
 *   POST   {base}/v1/mate/chats/{chat}/messages   { session_id, message_id, prompt, scope } -> 202 { event_id }
 *   GET    {base}/v1/mate/chats/{chat}/events?after={event_id}   long-lived SSE of MissionEvents
 *   POST   {base}/v1/mate/chats/{chat}/interrupt  -> 202
 *   DELETE {base}/v1/mate/chats/{chat}            -> 204
 *   POST   {base}/v1/mate/chats/{chat}/terminal   { mode, cols, rows } -> SSE of the raw terminal
 *   POST   {base}/v1/mate/chats/{chat}/terminal/{attach}   { data?, cols?, rows? } -> 204
 *   GET    {base}/v1/health                       -> { ok: true }
 *
 * Requests are signed exactly as the webhook dispatch contract signs them
 * (`signWebhookRequest`): HMAC-SHA256 under the shared secret of
 * `<timestamp>.<METHOD> <path>\n<body>`, where `<path>` is the request target
 * as sent (base path, route, and query string) and a GET's body is empty.
 */
import { readFileSync } from 'node:fs';
import { parseMissionEventJson, type MissionEvent } from '#lib/mission-events.js';
import { getEnv, type ServerEnv } from '../env.js';
import { readGithubPullUrl, stripTerminalNoise } from '../dispatch/sanitize.js';
import { signWebhookRequest } from '../dispatch/webhook-provider.js';
import type { HcStreamEnd } from '#lib/hc/client.js';
import {
	RELAY_FINISHED_MESSAGE,
	RELAY_UNAVAILABLE_MESSAGE,
	TerminalRelayError,
	type TerminalAttachRequest,
	type TerminalRelay
} from '../terminal-relay/relay.js';
import type { MateRunnerId, MateRunnerInfo } from '#lib/mate.js';
import { createE2bMateRunner } from './e2b-runner.js';

export const MATE_CONTRACT_VERSION = 1;
export const MIN_MATE_SECRET_LENGTH = 32;
/** Longest text Beadsmith keeps from one event. */
export const MATE_EVENT_TEXT_MAX = 32_000;
const REQUEST_TIMEOUT_MS = 15_000;
/** The runner pings about every 15 s; a stream silent this long is dead. */
export const STREAM_IDLE_TIMEOUT_MS = 45_000;
const ERROR_TEXT_MAX = 300;
/** Raw keystroke bytes per input request; base64 keeps it under the runner's 64 KiB body cap. */
const TERMINAL_INPUT_MAX = 32 * 1024;
const ATTACH_ID = /^ta_[a-f0-9]{32}$/;
const END_REASON = /^[a-z_]{1,32}$/;

export type MateRunnerErrorCode = 'unavailable' | 'not_found' | 'conflict' | 'bad_request';

/** A runner failure whose message is safe to show an admin. */
export class MateRunnerError extends Error {
	readonly code: MateRunnerErrorCode;

	constructor(code: MateRunnerErrorCode, message: string) {
		super(message);
		this.name = 'MateRunnerError';
		this.code = code;
	}
}

export interface MateMessageInput {
	session_id: string;
	message_id: string;
	prompt: string;
	scope: string | null;
}

/** Why `streamEvents` returned. */
export type MateStreamOutcome = 'ended' | 'aborted';

export interface MateRunner {
	sendMessage(chat_id: string, input: MateMessageInput): Promise<{ event_id: string }>;
	/**
	 * Follow a chat's events after `after` (all of them when undefined) until
	 * the runner closes the stream, it goes silent, or `signal` aborts.
	 */
	streamEvents(
		chat_id: string,
		after: string | undefined,
		on_event: (event: MissionEvent) => Promise<void> | void,
		signal: AbortSignal
	): Promise<MateStreamOutcome>;
	interrupt(chat_id: string): Promise<void>;
	/** Stop and forget the session. A chat the runner never knew is fine. */
	deleteChat(chat_id: string): Promise<void>;
	health(): Promise<boolean>;
	/**
	 * Attach the admin relay to the chat's agent terminal (ADR-0021 rule 4).
	 * Present only on runners Beadsmith can relay; throws `TerminalRelayError`.
	 */
	attachTerminal?(chat_id: string, request: TerminalAttachRequest): Promise<TerminalRelay>;
}

export interface MateRunnerDeps {
	server_env?: ServerEnv;
	fetch?: typeof fetch;
	now?: () => Date;
	/** Secret override for tests; production reads the file or env. */
	secret?: string;
	idle_timeout_ms?: number;
}

/** Resolve the shared secret from `BDX_MATE_RUNNER_SECRET_FILE` or the env fallback. */
export function resolveMateRunnerSecret(source: NodeJS.ProcessEnv = process.env): string {
	const file = source.BDX_MATE_RUNNER_SECRET_FILE?.trim();
	let secret: string | undefined;
	if (file !== undefined && file.length > 0) {
		try {
			secret = readFileSync(file, 'utf8').trim();
		} catch {
			throw new MateRunnerError('unavailable', 'The mate runner secret file could not be read.');
		}
	} else {
		secret = source.BDX_MATE_RUNNER_SECRET?.trim();
	}
	if (secret === undefined || secret.length < MIN_MATE_SECRET_LENGTH) {
		throw new MateRunnerError(
			'unavailable',
			`The mate runner secret must be at least ${MIN_MATE_SECRET_LENGTH} characters.`
		);
	}
	return secret;
}

/** One parsed SSE frame. Comments (heartbeats) never become frames. */
export interface SseFrame {
	id?: string;
	event?: string;
	data: string;
}

/**
 * Split a text/event-stream body into frames. `on_activity` fires for every
 * chunk, heartbeats included, so a caller can tell a quiet stream from a dead
 * one.
 */
export async function readSseStream(
	body: ReadableStream<Uint8Array>,
	on_frame: (frame: SseFrame) => Promise<void> | void,
	on_activity: () => void = () => {}
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let frame: SseFrame = { data: '' };
	let has_data = false;

	const dispatchLine = async (line: string) => {
		if (line === '') {
			if (has_data) {
				await on_frame(frame);
			}
			frame = { data: '' };
			has_data = false;
			return;
		}
		if (line.startsWith(':')) {
			return;
		}
		const colon = line.indexOf(':');
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? '' : line.slice(colon + 1);
		if (value.startsWith(' ')) {
			value = value.slice(1);
		}
		if (field === 'data') {
			frame.data = has_data ? `${frame.data}\n${value}` : value;
			has_data = true;
		} else if (field === 'id') {
			frame.id = value;
		} else if (field === 'event') {
			frame.event = value;
		}
	};

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			on_activity();
			buffer += decoder.decode(value, { stream: true });
			let index = buffer.search(/\r\n|\r|\n/);
			while (index !== -1) {
				const line = buffer.slice(0, index);
				const skip = buffer.startsWith('\r\n', index) ? 2 : 1;
				// A lone trailing \r may be the first half of \r\n: wait for more.
				if (buffer[index] === '\r' && index === buffer.length - 1) {
					break;
				}
				buffer = buffer.slice(index + skip);
				await dispatchLine(line);
				index = buffer.search(/\r\n|\r|\n/);
			}
		}
	} finally {
		reader.releaseLock();
	}
}

/** Control characters other than tab and newlines: terminal noise. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function cleanText(value: string, secret: string): string {
	let text = stripTerminalNoise(value).replace(CONTROL_CHARS, '');
	if (secret.length > 0) {
		text = text.split(secret).join('[redacted]');
	}
	return text.length > MATE_EVENT_TEXT_MAX ? `${text.slice(0, MATE_EVENT_TEXT_MAX - 1)}…` : text;
}

/**
 * Validate one SSE frame as a MissionEvent and bound what it carries. The
 * SSE `id:` wins over `data.id` when both are present: it is the cursor
 * `after` refers to. Returns undefined for anything that is not a valid event.
 */
export function toMateEvent(frame: SseFrame, secret: string): MissionEvent | undefined {
	const parsed = parseMissionEventJson(frame.data);
	if (parsed === undefined) {
		return undefined;
	}
	const sse_id = frame.id?.trim();
	const event: MissionEvent =
		sse_id !== undefined && /^[A-Za-z0-9._:-]{1,128}$/.test(sse_id)
			? { ...parsed, id: sse_id }
			: parsed;
	switch (event.type) {
		case 'user': {
			const text = cleanText(event.text, secret);
			if (text.length === 0) return undefined;
			const { message_id, ...user } = event;
			return message_id !== undefined && (secret.length === 0 || !message_id.includes(secret))
				? { ...user, text, message_id }
				: { ...user, text };
		}
		case 'assistant':
		case 'thinking': {
			const text = cleanText(event.text, secret);
			return text.length === 0 ? undefined : { ...event, text };
		}
		case 'error': {
			const message = cleanText(event.message, secret);
			return { ...event, message: message.length === 0 ? 'The agent reported an error.' : message };
		}
		case 'result': {
			const result: MissionEvent = { type: 'result', id: event.id, status: event.status };
			const text = event.text === undefined ? '' : cleanText(event.text, secret);
			if (text.length > 0) result.text = text;
			if (
				typeof event.duration_ms === 'number' &&
				Number.isSafeInteger(event.duration_ms) &&
				event.duration_ms >= 0
			) {
				result.duration_ms = event.duration_ms;
			}
			const pr = readGithubPullUrl(event.git_pr_url, secret);
			if (pr !== undefined) result.git_pr_url = pr;
			return result;
		}
		case 'tool_call':
			return event.call_id.length > 128
				? { ...event, call_id: event.call_id.slice(0, 128) }
				: event;
	}
}

function chatPath(chat_id: string, rest = ''): string {
	return `/v1/mate/chats/${encodeURIComponent(chat_id)}${rest}`;
}

/**
 * A client for the configured runner, or undefined when First Mate is not
 * connected (`BDX_MATE_RUNNER_URL` unset or unusable).
 */
export function createMateRunner(deps: MateRunnerDeps = {}): MateRunner | undefined {
	const env = deps.server_env ?? getEnv();
	const base = env.mate_runner_url;
	if (base === undefined) {
		return undefined;
	}
	const fetch_impl = deps.fetch ?? fetch;
	const now = deps.now ?? (() => new Date());
	const idle_timeout_ms = deps.idle_timeout_ms ?? STREAM_IDLE_TIMEOUT_MS;
	const secret = () => deps.secret ?? resolveMateRunnerSecret();

	async function call(
		method: 'GET' | 'POST' | 'DELETE',
		path: string,
		options: { body?: unknown; accept?: string; signal?: AbortSignal } = {}
	): Promise<Response> {
		const key = secret();
		const text = options.body === undefined ? '' : JSON.stringify(options.body);
		const timestamp = String(Math.floor(now().getTime() / 1000));
		const url = new URL(base as string);
		const target = `${url.pathname.replace(/\/$/, '')}${path}`;
		try {
			return await fetch_impl(`${url.origin}${target}`, {
				method,
				headers: {
					accept: options.accept ?? 'application/json',
					...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
					'x-beadsmith-contract': String(MATE_CONTRACT_VERSION),
					'x-beadsmith-timestamp': timestamp,
					'x-beadsmith-signature': await signWebhookRequest(key, timestamp, method, target, text)
				},
				body: options.body === undefined ? undefined : text,
				signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
			});
		} catch (error) {
			if (options.signal?.aborted) {
				throw error;
			}
			throw new MateRunnerError('unavailable', 'The mate runner could not be reached.');
		}
	}

	async function refused(response: Response, action: string): Promise<MateRunnerError> {
		let detail = '';
		try {
			const body = (await response.json()) as { error?: unknown };
			if (typeof body?.error === 'string') {
				detail = cleanText(body.error, secret()).replace(/\s+/g, ' ').trim();
				if (detail.length > ERROR_TEXT_MAX) detail = `${detail.slice(0, ERROR_TEXT_MAX - 1)}…`;
			}
		} catch {
			detail = '';
		}
		const code: MateRunnerErrorCode =
			response.status === 404 ? 'not_found' : response.status === 409 ? 'conflict' : 'unavailable';
		const message = `The mate runner refused to ${action} (HTTP ${response.status})`;
		return new MateRunnerError(code, detail.length > 0 ? `${message}: ${detail}` : `${message}.`);
	}

	/** A relay refusal's message, as the runner gave it (bounded and redacted), for the admin. */
	async function relayRefused(response: Response): Promise<TerminalRelayError> {
		if (response.status !== 409) {
			return new TerminalRelayError('unavailable', RELAY_UNAVAILABLE_MESSAGE);
		}
		let detail = '';
		try {
			const body = (await response.json()) as { error?: unknown };
			if (typeof body?.error === 'string') {
				detail = cleanText(body.error, secret()).replace(/\s+/g, ' ').trim();
			}
		} catch {
			detail = '';
		}
		if (detail.length > ERROR_TEXT_MAX) detail = `${detail.slice(0, ERROR_TEXT_MAX - 1)}…`;
		return new TerminalRelayError('conflict', detail.length > 0 ? detail : RELAY_FINISHED_MESSAGE);
	}

	/**
	 * The admin relay over the runner (ADR-0021 rule 4): one SSE response
	 * carries the terminal's output, and keystrokes go up as signed POSTs,
	 * one at a time and in order. The runner attaches over its own hc
	 * connection and keeps nothing; neither does this side.
	 */
	async function attachTerminal(
		chat_id: string,
		request: TerminalAttachRequest
	): Promise<TerminalRelay> {
		const ac = new AbortController();
		let idle: ReturnType<typeof setTimeout> | undefined;
		const touch = () => {
			clearTimeout(idle);
			idle = setTimeout(() => ac.abort(), idle_timeout_ms);
		};
		touch();
		let response: Response;
		try {
			response = await call('POST', chatPath(chat_id, '/terminal'), {
				body: { mode: request.mode, cols: request.cols, rows: request.rows },
				accept: 'text/event-stream',
				signal: ac.signal
			});
		} catch {
			clearTimeout(idle);
			throw new TerminalRelayError('unavailable', RELAY_UNAVAILABLE_MESSAGE);
		}
		if (!response.ok || response.body === null) {
			clearTimeout(idle);
			ac.abort();
			throw await relayRefused(response);
		}

		let opened!: (open: { attach: string; cols: number; rows: number }) => void;
		let failed!: () => void;
		const open_frame = new Promise<{ attach: string; cols: number; rows: number }>(
			(resolve, reject) => {
				opened = resolve;
				failed = () => reject(new TerminalRelayError('unavailable', RELAY_UNAVAILABLE_MESSAGE));
			}
		);
		let is_open = false;
		let closed = false;
		let end: HcStreamEnd | undefined;
		const size = (raw: unknown): { cols: number; rows: number } | undefined => {
			const value = raw as { cols?: unknown; rows?: unknown } | null;
			const ok = (n: unknown) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 1000;
			return value !== null && ok(value?.cols) && ok(value?.rows)
				? { cols: value!.cols as number, rows: value!.rows as number }
				: undefined;
		};
		const parse = (data: string): unknown => {
			try {
				return JSON.parse(data);
			} catch {
				return undefined;
			}
		};
		const ended = readSseStream(
			response.body,
			async (frame) => {
				if (frame.event === 'open' && !is_open) {
					const value = parse(frame.data) as { attach?: unknown } | undefined;
					const grid = size(value);
					if (typeof value?.attach !== 'string' || !ATTACH_ID.test(value.attach) || !grid) {
						throw new Error('bad open frame');
					}
					is_open = true;
					opened({ attach: value.attach, ...grid });
				} else if (!is_open) {
					throw new Error('frame before open');
				} else if (frame.event === 'output') {
					await request.onData(new Uint8Array(Buffer.from(frame.data, 'base64')));
				} else if (frame.event === 'resize') {
					const grid = size(parse(frame.data));
					if (grid !== undefined) request.onResize?.(grid);
				} else if (frame.event === 'end') {
					const reason = (parse(frame.data) as { reason?: unknown } | undefined)?.reason;
					end = {
						reason: typeof reason === 'string' && END_REASON.test(reason) ? reason : 'exited'
					};
				}
			},
			touch
		)
			.catch(() => undefined)
			.then((): HcStreamEnd => {
				clearTimeout(idle);
				ac.abort();
				failed();
				closed = true;
				return end ?? { reason: 'disconnected' };
			});

		let open: { attach: string; cols: number; rows: number };
		try {
			open = await open_frame;
		} catch (error) {
			ac.abort();
			throw error;
		}

		const input_path = chatPath(chat_id, `/terminal/${open.attach}`);
		type Input = { data?: Uint8Array; size?: { cols: number; rows: number } };
		const pending: Input[] = [];
		let sending = false;
		const close = () => {
			if (closed) return;
			end ??= { reason: 'detached' };
			closed = true;
			ac.abort();
		};
		const pump = async () => {
			if (sending) return;
			sending = true;
			try {
				while (pending.length > 0 && !closed) {
					const item = pending.shift()!;
					const body: Record<string, unknown> = {};
					if (item.data !== undefined) body.data = Buffer.from(item.data).toString('base64');
					if (item.size !== undefined) Object.assign(body, item.size);
					const sent = await call('POST', input_path, { body });
					// Input that went missing would desynchronise the admin's terminal: end the relay.
					if (!sent.ok) close();
				}
			} catch {
				close();
			} finally {
				sending = false;
			}
		};
		const enqueue = (item: Input) => {
			if (closed) throw new TerminalRelayError('conflict', 'This terminal relay has closed.');
			if (request.mode !== 'take_over') {
				throw new TerminalRelayError('conflict', 'This relay is watching.');
			}
			const last = pending.at(-1);
			if (item.data !== undefined) {
				for (let at = 0; at < item.data.length; at += TERMINAL_INPUT_MAX) {
					const chunk = item.data.subarray(at, at + TERMINAL_INPUT_MAX);
					const tail = pending.at(-1);
					if (
						tail?.data !== undefined &&
						tail.size === undefined &&
						tail.data.length + chunk.length <= TERMINAL_INPUT_MAX
					) {
						const merged = new Uint8Array(tail.data.length + chunk.length);
						merged.set(tail.data);
						merged.set(chunk, tail.data.length);
						tail.data = merged;
					} else {
						pending.push({ data: chunk });
					}
				}
			} else if (last !== undefined && last.data === undefined) {
				// Only the newest size matters.
				last.size = item.size;
			} else {
				pending.push(item);
			}
			void pump();
		};

		return {
			mode: request.mode,
			size: { cols: open.cols, rows: open.rows },
			ended,
			write: (bytes) => enqueue({ data: bytes }),
			resize: (cols, rows) => enqueue({ size: { cols, rows } }),
			close
		};
	}

	return {
		attachTerminal,

		async sendMessage(chat_id, input) {
			const response = await call('POST', chatPath(chat_id, '/messages'), {
				body: {
					session_id: input.session_id,
					message_id: input.message_id,
					prompt: input.prompt,
					scope: input.scope
				}
			});
			if (response.status !== 202 && response.status !== 200) {
				throw await refused(response, 'take the message');
			}
			let event_id: unknown;
			try {
				event_id = ((await response.json()) as { event_id?: unknown })?.event_id;
			} catch {
				event_id = undefined;
			}
			if (typeof event_id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(event_id)) {
				throw new MateRunnerError('unavailable', 'The mate runner returned no valid event_id.');
			}
			return { event_id };
		},

		async streamEvents(chat_id, after, on_event, signal) {
			const ac = new AbortController();
			const abort = () => ac.abort();
			if (signal.aborted) {
				return 'aborted';
			}
			signal.addEventListener('abort', abort, { once: true });
			let idle: ReturnType<typeof setTimeout> | undefined;
			const touch = () => {
				clearTimeout(idle);
				idle = setTimeout(abort, idle_timeout_ms);
			};
			try {
				const query = after === undefined ? '' : `?${new URLSearchParams({ after })}`;
				touch();
				let response: Response;
				try {
					response = await call('GET', chatPath(chat_id, `/events${query}`), {
						accept: 'text/event-stream',
						signal: ac.signal
					});
				} catch (error) {
					if (signal.aborted) return 'aborted';
					if (ac.signal.aborted) {
						throw new MateRunnerError('unavailable', 'The mate runner did not answer.');
					}
					throw error;
				}
				if (!response.ok) {
					throw await refused(response, 'stream the chat');
				}
				if (response.body === null) {
					return 'ended';
				}
				const key = secret();
				try {
					await readSseStream(
						response.body,
						async (frame) => {
							// The `event:` name is informational; the payload carries the type.
							const event = toMateEvent(frame, key);
							if (event !== undefined) {
								await on_event(event);
							}
						},
						touch
					);
				} catch (error) {
					if (signal.aborted) return 'aborted';
					if (ac.signal.aborted) return 'ended';
					throw error instanceof MateRunnerError
						? error
						: new MateRunnerError('unavailable', 'The mate runner stream broke.');
				}
				return signal.aborted ? 'aborted' : 'ended';
			} finally {
				clearTimeout(idle);
				signal.removeEventListener('abort', abort);
				ac.abort();
			}
		},

		async interrupt(chat_id) {
			const response = await call('POST', chatPath(chat_id, '/interrupt'));
			if (!response.ok) {
				throw await refused(response, 'interrupt the agent');
			}
		},

		async deleteChat(chat_id) {
			const response = await call('DELETE', chatPath(chat_id));
			if (!response.ok && response.status !== 404) {
				throw await refused(response, 'stop the session');
			}
		},

		async health() {
			try {
				const response = await call('GET', '/v1/health');
				if (!response.ok) return false;
				const body = (await response.json()) as { ok?: unknown };
				return body?.ok === true;
			} catch {
				return false;
			}
		}
	};
}

let override: MateRunner | null | undefined;
/** The in-process Sand runner holds live sessions, so there is one per process. */
let sand: { key: string; runner: MateRunner } | undefined;

/**
 * Which runners implement `attachTerminal`: both. Sand's relays its hc
 * terminal over the sandbox's process channel; the remote runner serves the
 * attach over its signed contract. The browser offers the terminal view only
 * on runners listed here.
 */
export const MATE_RUNNER_TERMINAL: Record<MateRunnerId, boolean> = { remote: true, e2b: true };

/** Configured chat runners with their labels, default first. */
export function configuredMateRunners(env: ServerEnv = getEnv()): MateRunnerInfo[] {
	return env.mate_runners.map((id) => ({
		id,
		label: env.mate_labels[id],
		terminal: MATE_RUNNER_TERMINAL[id]
	}));
}

/**
 * A configured runner, or undefined when it is not configured. Without `id`,
 * the default (first) one.
 */
export function getMateRunner(id?: MateRunnerId): MateRunner | undefined {
	if (override !== undefined) {
		return override ?? undefined;
	}
	const env = getEnv();
	const wanted = id ?? env.mate_runners[0];
	if (wanted === undefined || !env.mate_runners.includes(wanted)) return undefined;
	if (wanted === 'remote') return createMateRunner();
	const settings = env.mate_e2b;
	if (settings === undefined) return undefined;
	const key = JSON.stringify(settings);
	if (sand?.key !== key) {
		sand = { key, runner: createE2bMateRunner({ settings }) };
	}
	return sand.runner;
}

/** Replace the runner (tests only): null forces "not configured", undefined restores the env. */
export function setMateRunner(runner: MateRunner | null | undefined): void {
	override = runner;
}
