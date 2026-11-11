/**
 * The mate runner's HTTP surface: mate runner contract v1 (docs/first-mate.md).
 *
 *   POST   /v1/mate/chats/{chat_id}/messages   send a user message (202)
 *   GET    /v1/mate/chats/{chat_id}/events     SSE: replay after ?after=, then live
 *   POST   /v1/mate/chats/{chat_id}/interrupt  interrupt the running turn (202)
 *   DELETE /v1/mate/chats/{chat_id}            stop the session and forget it (204)
 *   POST   /v1/mate/chats/{chat_id}/terminal   SSE: the agent's raw terminal (admin relay)
 *   POST   /v1/mate/chats/{chat_id}/terminal/{attach_id}   keystrokes and size (204)
 *   GET    /v1/health                          { ok: true }
 *
 * Every request is signed like webhook contract v1 (./signature.ts). Only
 * Beadsmith holds the secret; nothing here is reachable without it.
 */

import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EFFORT_PATTERN, MODEL_PATTERN } from '../agent-session/claude-code.js';
import { SESSION_LABEL } from '../agent-session/session.js';
import { encodeMissionEvent, type MissionEvent } from '../mission-events.js';
import {
	attachHcTerminal,
	RELAY_NOT_STARTED_MESSAGE,
	RELAY_UNAVAILABLE_MESSAGE,
	TerminalRelayError,
	type TerminalAttachRequest,
	type TerminalRelay
} from '../server/terminal-relay/relay.js';
import { CHAT_ID_PATTERN, type ChatStore } from './event-log.js';
import {
	ChatAgent,
	type AgentConnection,
	type ChatAgentOptions,
	type ConnectAgent
} from './session.js';
import { verifyRequest } from './signature.js';

export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_PROMPT_CHARS = 16_000;
const HEARTBEAT_MS = 15_000;
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Lowercase, as Beadsmith makes them: Claude Code names the transcript after it. */
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SCOPE_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
/** Ids the runner gives each open terminal attach. */
export const ATTACH_ID_PATTERN = /^ta_[a-f0-9]{32}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
/** hc's bounds for a viewer's grid (src/lib/hc/validate.ts). */
const MAX_CELLS = 1000;

/** What the runner core needs: chat logs and a way to reach a chat's hc core. */
export interface RunnerCoreOptions {
	store: ChatStore;
	connect: ConnectAgent;
	/** Live agent CLIs at once; idle ones are stopped to make room. */
	max_live_sessions?: number;
	now?: () => Date;
	/** Session timing and server-side diagnostics, passed to each chat. */
	agent?: ChatAgentOptions;
}

export interface RunnerOptions extends RunnerCoreOptions {
	secret: string;
	heartbeat_ms?: number;
}

// No parameter properties: Node runs this file with type stripping only.
/** A refusal with the HTTP status the contract gives it. */
export class RunnerFault extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = 'RunnerFault';
		this.status = status;
	}
}
const HttpError = RunnerFault;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		'content-type': 'application/json',
		'content-length': Buffer.byteLength(text),
		'cache-control': 'no-store'
	});
	res.end(text);
}

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = chunk as Buffer;
		size += buffer.length;
		if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large.');
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString('utf8');
}

function header(req: IncomingMessage, name: string): string | undefined {
	const value = req.headers[name];
	return Array.isArray(value) ? value[0] : value;
}

function sseFrame(event: MissionEvent): string {
	return `id: ${event.id}\ndata: ${JSON.stringify(encodeMissionEvent(event))}\n\n`;
}

/**
 * The runner without its transport: chat sessions, admission and message
 * handling. The HTTP handler below serves it to a remote Beadsmith; Beadsmith
 * also runs it in-process for chats in E2B sandboxes (src/lib/server/mate/e2b-runner.ts).
 */
export function createRunnerCore(options: RunnerCoreOptions) {
	const now = options.now ?? (() => new Date());
	const max_live = options.max_live_sessions ?? 3;
	const sessions = new Map<string, ChatAgent>();
	if (!Number.isInteger(max_live) || max_live < 1) throw new Error('invalid session limit');
	// Serialize mutations across awaits so eviction, deletion and admission cannot race.
	let mutations: Promise<unknown> = Promise.resolve();
	let closing = false;
	function mutate<T>(action: () => Promise<T>): Promise<T> {
		const next = mutations.then(() => {
			if (closing) throw new RunnerFault(503, 'The runner is shutting down.');
			return action();
		});
		mutations = next.catch(() => undefined);
		return next;
	}

	function requireChat(chat_id: string): void {
		if (!CHAT_ID_PATTERN.test(chat_id)) throw new RunnerFault(400, 'Invalid chat id.');
	}

	function session(chat_id: string): ChatAgent {
		let found = sessions.get(chat_id);
		if (found === undefined) {
			found = new ChatAgent(options.store.get(chat_id), options.connect, options.agent);
			sessions.set(chat_id, found);
		}
		return found;
	}

	/** Make room for one more live CLI, or refuse when every one is busy. */
	async function reserveSlot(chat_id: string): Promise<void> {
		const live = [...sessions.entries()].filter(([id, s]) => id !== chat_id && s.running);
		if (live.length < max_live) return;
		const idle = live
			.filter(([, s]) => !s.busy)
			.sort(([, a], [, b]) => a.last_active - b.last_active);
		const oldest = idle[0];
		if (oldest === undefined) throw new RunnerFault(503, 'Every agent session is busy.');
		await oldest[1].stop();
	}

	async function postMessage(
		chat_id: string,
		input: Record<string, unknown>
	): Promise<{ event_id: string }> {
		const { session_id, prompt, scope, message_id, model, effort } = input;
		if (typeof session_id !== 'string' || !SESSION_ID_PATTERN.test(session_id)) {
			throw new RunnerFault(400, 'session_id must be a UUID.');
		}
		if (typeof message_id !== 'string' || !MESSAGE_ID_PATTERN.test(message_id)) {
			throw new RunnerFault(400, 'message_id is required.');
		}
		if (typeof prompt !== 'string' || prompt.trim().length === 0) {
			throw new RunnerFault(400, 'prompt is required.');
		}
		if (prompt.length > MAX_PROMPT_CHARS) throw new RunnerFault(400, 'prompt is too long.');
		if (
			scope !== null &&
			scope !== undefined &&
			(typeof scope !== 'string' || !SCOPE_PATTERN.test(scope))
		) {
			throw new RunnerFault(400, 'scope must be a project id or null.');
		}
		// Only the shape is checked here: they reach the CLI's argv. Which
		// models a chat may use is Beadsmith's call, made when it created the chat.
		if (model !== undefined && (typeof model !== 'string' || !MODEL_PATTERN.test(model))) {
			throw new RunnerFault(400, 'model must be a model name.');
		}
		if (effort !== undefined && (typeof effort !== 'string' || !EFFORT_PATTERN.test(effort))) {
			throw new RunnerFault(400, 'effort must be an effort level.');
		}

		const log = options.store.get(chat_id);
		if (log.meta === undefined) {
			log.setMeta({
				session_id,
				scope: typeof scope === 'string' ? scope : null,
				...(model === undefined ? {} : { model }),
				...(effort === undefined ? {} : { effort }),
				created_at: now().toISOString()
			});
		} else if (log.meta.session_id !== session_id) {
			throw new RunnerFault(409, 'This chat belongs to another session.');
		} else if (log.meta.model !== model || log.meta.effort !== effort) {
			// A chat keeps the model it started with: the CLI would otherwise
			// resume the same transcript under a different one, unannounced.
			throw new RunnerFault(409, 'This chat runs with another model or effort.');
		}

		const existing = log.user(message_id);
		if (existing !== undefined) {
			if (existing.type === 'user' && existing.text !== prompt)
				throw new RunnerFault(409, 'message_id already has a different prompt.');
			return { event_id: existing.id };
		}
		const agent = session(chat_id);
		if (!agent.running) await reserveSlot(chat_id);
		agent.prepare();
		const previousScope = log.meta!.scope;
		// Omission keeps the current project; only an explicit null clears it.
		const nextScope = typeof scope === 'string' || scope === null ? scope : previousScope;
		log.setMeta({ ...log.meta!, scope: nextScope });
		const { event } = log.appendUser(prompt, message_id);
		agent.send(prompt, previousScope === nextScope ? undefined : nextScope);
		return { event_id: event.id };
	}

	return {
		get closing(): boolean {
			return closing;
		},
		/** Send one user message (idempotent per `message_id`). */
		sendMessage(chat_id: string, input: Record<string, unknown>): Promise<{ event_id: string }> {
			requireChat(chat_id);
			return mutate(() => postMessage(chat_id, input));
		},
		/**
		 * Replay the chat's events after `after`, then pass on new ones until
		 * the returned function is called.
		 */
		follow(chat_id: string, after: string | undefined, listener: (event: MissionEvent) => void) {
			requireChat(chat_id);
			const log = options.store.get(chat_id);
			for (const event of log.after(after)) listener(event);
			return log.subscribe(listener);
		},
		/** Interrupt the running turn and drop queued messages; the session survives. */
		async interrupt(chat_id: string): Promise<void> {
			requireChat(chat_id);
			await sessions.get(chat_id)?.interrupt();
		},
		/**
		 * Attach to the chat's agent terminal for Beadsmith's admin relay
		 * (ADR-0021 rule 4) over a new hc connection of its own, so a relay
		 * never shares or disturbs the chat's channel. The terminal is the
		 * live one labelled with the chat's CLI session. Throws
		 * `TerminalRelayError`; nothing here stores or logs the bytes.
		 */
		async attachTerminal(chat_id: string, request: TerminalAttachRequest): Promise<TerminalRelay> {
			requireChat(chat_id);
			const session_id = options.store.get(chat_id).meta?.session_id;
			if (session_id === undefined) {
				throw new TerminalRelayError('conflict', RELAY_NOT_STARTED_MESSAGE);
			}
			let connection: AgentConnection;
			try {
				connection = await options.connect(session_id);
			} catch {
				throw new TerminalRelayError('unavailable', RELAY_UNAVAILABLE_MESSAGE);
			}
			let released = false;
			const release = () => {
				if (released) return;
				released = true;
				connection.release?.();
			};
			try {
				const relay = await attachHcTerminal(
					connection.client,
					(live) => live.find((terminal) => terminal.labels[SESSION_LABEL] === session_id),
					request
				);
				void relay.ended.then(release);
				return {
					...relay,
					close: () => {
						relay.close();
						release();
					}
				};
			} catch (error) {
				release();
				throw error;
			}
		},
		/** Stop the session and forget the chat. */
		deleteChat(chat_id: string): Promise<void> {
			requireChat(chat_id);
			return mutate(async () => {
				await sessions.get(chat_id)?.stop();
				sessions.delete(chat_id);
				options.store.remove(chat_id);
			});
		},
		async close(): Promise<void> {
			closing = true;
			await mutations;
			await Promise.all([...sessions.values()].map((agent) => agent.stop()));
		}
	};
}

export type RunnerCore = ReturnType<typeof createRunnerCore>;

function parseObject(body: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(body);
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
		return parsed as Record<string, unknown>;
	} catch {
		throw new HttpError(400, 'The body must be a JSON object.');
	}
}

function isCells(value: unknown): value is number {
	return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_CELLS;
}

const RELAY_STATUS = { not_found: 404, conflict: 409, unavailable: 503 } as const;

/** Resolves once `res` can take more, or has closed. */
function drained(res: ServerResponse): Promise<void> {
	return new Promise((resolve) => {
		const done = () => {
			res.off('drain', done);
			res.off('close', done);
			resolve();
		};
		res.on('drain', done);
		res.on('close', done);
	});
}

export function createRunnerHandler(options: RunnerOptions) {
	const now = options.now ?? (() => new Date());
	const heartbeat_ms = options.heartbeat_ms ?? HEARTBEAT_MS;
	const core = createRunnerCore(options);
	/** Open terminal attaches by id; each lives as long as its SSE response. */
	const attaches = new Map<string, { chat_id: string; relay: TerminalRelay; end: () => void }>();

	/**
	 * Open the chat's agent terminal and stream it as SSE: `open`
	 * (`{ attach, mode, cols, rows }`), `output` (base64 bytes), `resize`
	 * (`{ cols, rows }`, while watching) and a final `end` (`{ reason }`).
	 * Output is written only as fast as Beadsmith reads it. The attach ends
	 * when Beadsmith closes the request, the program exits, or the runner
	 * shuts down. Nothing is kept or logged.
	 */
	async function openTerminal(chat_id: string, body: string, res: ServerResponse): Promise<void> {
		const input = parseObject(body);
		const { mode, cols, rows } = input;
		if (mode !== 'watch' && mode !== 'take_over') {
			throw new HttpError(400, 'mode must be watch or take_over.');
		}
		if (!isCells(cols) || !isCells(rows)) {
			throw new HttpError(400, `cols and rows must be whole numbers from 1 to ${MAX_CELLS}.`);
		}
		let ended = false;
		let opened!: () => void;
		const ready = new Promise<void>((resolve) => (opened = resolve));
		const send = (event: string, data: string): boolean =>
			!ended && res.write(`event: ${event}\ndata: ${data}\n\n`);
		const relay = await core.attachTerminal(chat_id, {
			mode,
			cols,
			rows,
			async onData(bytes) {
				await ready;
				if (!send('output', Buffer.from(bytes).toString('base64')) && !ended) await drained(res);
			},
			onResize(size) {
				void ready.then(() => send('resize', JSON.stringify(size)));
			}
		});
		// Only the response tells: a POST's request stream has closed once its body was read.
		if (res.destroyed) {
			relay.close();
			return;
		}
		const attach_id = `ta_${randomBytes(16).toString('hex')}`;
		const heartbeat = setInterval(() => !ended && res.write(': ping\n\n'), heartbeat_ms);
		const end = () => {
			if (ended) return;
			ended = true;
			clearInterval(heartbeat);
			attaches.delete(attach_id);
			relay.close();
			res.end();
		};
		attaches.set(attach_id, { chat_id, relay, end });
		res.once('close', end);
		res.writeHead(200, {
			'content-type': 'text/event-stream',
			'cache-control': 'no-store',
			connection: 'keep-alive',
			'x-accel-buffering': 'no'
		});
		send('open', JSON.stringify({ attach: attach_id, mode, ...relay.size }));
		opened();
		void relay.ended.then((result) => {
			send('end', JSON.stringify({ reason: result.reason }));
			end();
		});
	}

	/** Keystrokes (`data`, base64) and a new size (`cols` and `rows`) for a take-over. */
	function terminalInput(chat_id: string, attach_id: string, body: string): void {
		const open = attaches.get(attach_id);
		if (open === undefined || open.chat_id !== chat_id) {
			throw new HttpError(404, 'This terminal attach is not open.');
		}
		const { data, cols, rows } = parseObject(body);
		if (data !== undefined && (typeof data !== 'string' || !BASE64_PATTERN.test(data))) {
			throw new HttpError(400, 'data must be base64.');
		}
		const sized = cols !== undefined || rows !== undefined;
		if (sized && (!isCells(cols) || !isCells(rows))) {
			throw new HttpError(400, `cols and rows must be whole numbers from 1 to ${MAX_CELLS}.`);
		}
		if (open.relay.mode !== 'take_over') {
			throw new HttpError(409, 'This attach is watching. Take over to type.');
		}
		try {
			if (sized) open.relay.resize(cols as number, rows as number);
			if (typeof data === 'string' && data.length > 0) {
				open.relay.write(new Uint8Array(Buffer.from(data, 'base64')));
			}
		} catch {
			throw new HttpError(409, 'This terminal attach has closed.');
		}
	}

	async function postMessage(chat_id: string, body: string, res: ServerResponse): Promise<void> {
		const { event_id } = await core.sendMessage(chat_id, parseObject(body));
		sendJson(res, 202, { event_id });
	}

	function streamEvents(
		chat_id: string,
		after: string | undefined,
		req: IncomingMessage,
		res: ServerResponse
	): void {
		res.writeHead(200, {
			'content-type': 'text/event-stream',
			'cache-control': 'no-store',
			connection: 'keep-alive',
			'x-accel-buffering': 'no'
		});
		res.write(': connected\n\n');
		const unsubscribe = core.follow(chat_id, after, (event) => res.write(sseFrame(event)));
		const heartbeat = setInterval(() => res.write(': ping\n\n'), heartbeat_ms);
		const close = () => {
			clearInterval(heartbeat);
			unsubscribe();
		};
		req.once('close', close);
		res.once('close', close);
	}

	const handle = async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		try {
			if (core.closing) throw new HttpError(503, 'The runner is shutting down.');
			const method = req.method ?? 'GET';
			const target = req.url ?? '/';
			const body = method === 'GET' || method === 'DELETE' ? '' : await readBody(req);
			const signed = verifyRequest(
				options.secret,
				{
					method,
					target,
					body,
					timestamp: header(req, 'x-beadsmith-timestamp'),
					signature: header(req, 'x-beadsmith-signature')
				},
				now()
			);
			if (!signed) throw new HttpError(401, 'Unsigned or stale request.');

			const url = new URL(target, 'http://runner.invalid');
			if (url.pathname === '/v1/health') {
				if (method !== 'GET') throw new HttpError(405, 'Method not allowed.');
				sendJson(res, 200, { ok: true });
				return;
			}
			const match =
				/^\/v1\/mate\/chats\/([^/]+)(\/messages|\/events|\/interrupt|\/terminal(?:\/([^/]+))?)?$/.exec(
					url.pathname
				);
			if (match === null) throw new HttpError(404, 'Not found.');
			const chat_id = decodeURIComponent(match[1] ?? '');
			if (!CHAT_ID_PATTERN.test(chat_id)) throw new HttpError(400, 'Invalid chat id.');
			const attach_id = match[3];
			const action = attach_id === undefined ? match[2] : '/terminal/:attach';
			if (attach_id !== undefined && !ATTACH_ID_PATTERN.test(attach_id)) {
				throw new HttpError(404, 'This terminal attach is not open.');
			}

			if (action === '/messages' && method === 'POST') {
				await postMessage(chat_id, body, res);
			} else if (action === '/events' && method === 'GET') {
				streamEvents(chat_id, url.searchParams.get('after') ?? undefined, req, res);
			} else if (action === '/interrupt' && method === 'POST') {
				await core.interrupt(chat_id);
				sendJson(res, 202, { ok: true });
			} else if (action === '/terminal' && method === 'POST') {
				await openTerminal(chat_id, body, res);
			} else if (action === '/terminal/:attach' && method === 'POST') {
				terminalInput(chat_id, attach_id!, body);
				res.writeHead(204).end();
			} else if (action === undefined && method === 'DELETE') {
				await core.deleteChat(chat_id);
				res.writeHead(204).end();
			} else {
				throw new HttpError(405, 'Method not allowed.');
			}
		} catch (error) {
			if (res.headersSent) {
				res.end();
				return;
			}
			if (error instanceof RunnerFault) {
				sendJson(res, error.status, { error: error.message });
			} else if (error instanceof TerminalRelayError) {
				sendJson(res, RELAY_STATUS[error.code], { error: error.message });
			} else {
				sendJson(res, 500, { error: 'The runner failed.' });
			}
		}
	};
	return Object.assign(handle, {
		close: () => {
			// Each end() deletes its own entry; a Map tolerates that while iterating.
			for (const open of attaches.values()) open.end();
			return core.close();
		}
	});
}
