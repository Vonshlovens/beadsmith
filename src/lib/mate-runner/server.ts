/**
 * The mate runner's HTTP surface: mate runner contract v1 (docs/first-mate.md).
 *
 *   POST   /v1/mate/chats/{chat_id}/messages   send a user message (202)
 *   GET    /v1/mate/chats/{chat_id}/events     SSE: replay after ?after=, then live
 *   POST   /v1/mate/chats/{chat_id}/interrupt  interrupt the running turn (202)
 *   DELETE /v1/mate/chats/{chat_id}            stop the session and forget it (204)
 *   GET    /v1/health                          { ok: true }
 *
 * Every request is signed like webhook contract v1 (./signature.ts). Only
 * Beadsmith holds the secret; nothing here is reachable without it.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { encodeMissionEvent, type MissionEvent } from '../mission-events.js';
import { CHAT_ID_PATTERN, type ChatStore } from './event-log.js';
import { AgentSession, type SpawnAgent } from './session.js';
import { verifyRequest } from './signature.js';

export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_PROMPT_CHARS = 16_000;
const HEARTBEAT_MS = 15_000;
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPE_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export interface RunnerOptions {
	secret: string;
	store: ChatStore;
	spawn: SpawnAgent;
	/** Live agent processes at once; idle ones are stopped to make room. */
	max_live_sessions?: number;
	now?: () => Date;
	heartbeat_ms?: number;
}

// No parameter properties: Node runs this file with type stripping only.
class HttpError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

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

export function createRunnerHandler(options: RunnerOptions) {
	const now = options.now ?? (() => new Date());
	const max_live = options.max_live_sessions ?? 3;
	const heartbeat_ms = options.heartbeat_ms ?? HEARTBEAT_MS;
	const sessions = new Map<string, AgentSession>();

	function session(chat_id: string): AgentSession {
		let found = sessions.get(chat_id);
		if (found === undefined) {
			found = new AgentSession(options.store.get(chat_id), options.spawn);
			sessions.set(chat_id, found);
		}
		return found;
	}

	/** Make room for one more live process, or refuse when every one is busy. */
	function reserveSlot(chat_id: string): void {
		const live = [...sessions.entries()].filter(([id, s]) => id !== chat_id && s.running);
		if (live.length < max_live) return;
		const idle = live
			.filter(([, s]) => !s.busy)
			.sort(([, a], [, b]) => a.last_active - b.last_active);
		const oldest = idle[0];
		if (oldest === undefined) throw new HttpError(503, 'Every agent session is busy.');
		oldest[1].stop();
	}

	async function postMessage(chat_id: string, body: string, res: ServerResponse): Promise<void> {
		let input: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(body);
			if (typeof parsed !== 'object' || parsed === null) throw new Error();
			input = parsed as Record<string, unknown>;
		} catch {
			throw new HttpError(400, 'The body must be a JSON object.');
		}
		const { session_id, prompt, scope, message_id } = input;
		if (typeof session_id !== 'string' || !SESSION_ID_PATTERN.test(session_id)) {
			throw new HttpError(400, 'session_id must be a UUID.');
		}
		if (typeof message_id !== 'string' || !MESSAGE_ID_PATTERN.test(message_id)) {
			throw new HttpError(400, 'message_id is required.');
		}
		if (typeof prompt !== 'string' || prompt.trim().length === 0) {
			throw new HttpError(400, 'prompt is required.');
		}
		if (prompt.length > MAX_PROMPT_CHARS) throw new HttpError(400, 'prompt is too long.');
		if (
			scope !== null &&
			scope !== undefined &&
			(typeof scope !== 'string' || !SCOPE_PATTERN.test(scope))
		) {
			throw new HttpError(400, 'scope must be a project id or null.');
		}

		const log = options.store.get(chat_id);
		if (log.meta === undefined) {
			log.setMeta({
				session_id,
				scope: typeof scope === 'string' ? scope : null,
				started: false,
				created_at: now().toISOString()
			});
		} else if (log.meta.session_id !== session_id) {
			throw new HttpError(409, 'This chat belongs to another session.');
		}

		const { event, created } = log.appendUser(prompt, message_id);
		if (created) {
			const agent = session(chat_id);
			if (!agent.running) reserveSlot(chat_id);
			agent.send(prompt);
		}
		sendJson(res, 202, { event_id: event.id });
	}

	function streamEvents(
		chat_id: string,
		after: string | undefined,
		req: IncomingMessage,
		res: ServerResponse
	): void {
		const log = options.store.get(chat_id);
		res.writeHead(200, {
			'content-type': 'text/event-stream',
			'cache-control': 'no-store',
			connection: 'keep-alive',
			'x-accel-buffering': 'no'
		});
		res.write(': connected\n\n');
		for (const event of log.after(after)) res.write(sseFrame(event));
		const unsubscribe = log.subscribe((event) => res.write(sseFrame(event)));
		const heartbeat = setInterval(() => res.write(': ping\n\n'), heartbeat_ms);
		const close = () => {
			clearInterval(heartbeat);
			unsubscribe();
		};
		req.once('close', close);
		res.once('close', close);
	}

	return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		try {
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
			const match = /^\/v1\/mate\/chats\/([^/]+)(\/messages|\/events|\/interrupt)?$/.exec(
				url.pathname
			);
			if (match === null) throw new HttpError(404, 'Not found.');
			const chat_id = decodeURIComponent(match[1] ?? '');
			if (!CHAT_ID_PATTERN.test(chat_id)) throw new HttpError(400, 'Invalid chat id.');
			const action = match[2];

			if (action === '/messages' && method === 'POST') {
				await postMessage(chat_id, body, res);
			} else if (action === '/events' && method === 'GET') {
				streamEvents(chat_id, url.searchParams.get('after') ?? undefined, req, res);
			} else if (action === '/interrupt' && method === 'POST') {
				sessions.get(chat_id)?.interrupt();
				sendJson(res, 202, { ok: true });
			} else if (action === undefined && method === 'DELETE') {
				sessions.get(chat_id)?.stop();
				sessions.delete(chat_id);
				options.store.remove(chat_id);
				res.writeHead(204).end();
			} else {
				throw new HttpError(405, 'Method not allowed.');
			}
		} catch (error) {
			if (res.headersSent) {
				res.end();
				return;
			}
			if (error instanceof HttpError) {
				sendJson(res, error.status, { error: error.message });
			} else {
				sendJson(res, 500, { error: 'The runner failed.' });
			}
		}
	};
}
