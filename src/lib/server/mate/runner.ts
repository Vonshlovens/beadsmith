/**
 * Client for the mate runner, the service that keeps each First Mate chat's
 * agent session alive (contract v1, docs/first-mate.md):
 *
 *   POST   {base}/v1/mate/chats/{chat}/messages   { session_id, message_id, prompt, scope } -> 202 { event_id }
 *   GET    {base}/v1/mate/chats/{chat}/events?after={event_id}   long-lived SSE of MissionEvents
 *   POST   {base}/v1/mate/chats/{chat}/interrupt  -> 202
 *   DELETE {base}/v1/mate/chats/{chat}            -> 204
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

export const MATE_CONTRACT_VERSION = 1;
export const MIN_MATE_SECRET_LENGTH = 32;
/** Longest text Beadsmith keeps from one event. */
export const MATE_EVENT_TEXT_MAX = 32_000;
const REQUEST_TIMEOUT_MS = 15_000;
/** The runner pings about every 15 s; a stream silent this long is dead. */
export const STREAM_IDLE_TIMEOUT_MS = 45_000;
const ERROR_TEXT_MAX = 300;

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

	return {
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

/** The configured runner, or undefined when First Mate is not connected. */
export function getMateRunner(): MateRunner | undefined {
	if (override !== undefined) {
		return override ?? undefined;
	}
	return createMateRunner();
}

/** Replace the runner (tests only): null forces "not configured", undefined restores the env. */
export function setMateRunner(runner: MateRunner | null | undefined): void {
	override = runner;
}
