/**
 * An in-memory mate runner (contract v1, docs/first-mate.md) behind a `fetch`
 * stand-in, for tests. Nothing opens a socket: requests become `Response`
 * objects. It checks every signature, keeps each chat's event log with
 * ordered ids (`e000001`, …), replays after `?after=`, follows live until the
 * request aborts, and dedupes messages on `message_id`. Its terminal attach
 * serves a scripted terminal: tests write its output and read the input.
 */
import type { MissionEvent } from '#lib/mission-events.js';
import { signWebhookRequest } from '#lib/server/dispatch/webhook-provider.js';

export const FAKE_RUNNER_URL = 'https://mate.runner.test/base';
export const FAKE_RUNNER_SECRET = 'fake-mate-runner-secret-0123456789abcdef';

type EventInput = MissionEvent extends infer E
	? E extends MissionEvent
		? Omit<E, 'id'>
		: never
	: never;

interface FakeChat {
	session_id?: string;
	events: MissionEvent[];
	messages: Map<string, string>;
	listeners: Set<(event: MissionEvent) => void>;
}

export interface FakeRequest {
	method: string;
	/** Signed request target: path and query. */
	target: string;
	headers: Headers;
	body: string;
}

/** One attach Beadsmith opened on the fake runner's terminal route. */
export interface FakeRunnerAttach {
	id: string;
	chat_id: string;
	mode: 'watch' | 'take_over';
	/** Bodies of the input requests, parsed. */
	inputs: Array<{ data?: string; cols?: number; rows?: number }>;
	/** Beadsmith closed the stream. */
	closed: boolean;
	output(text: string): void;
	resize(cols: number, rows: number): void;
	/** The program ended: an `end` frame, then the stream closes. */
	end(reason: string): void;
}

/** The grid the fake terminal reports when attached. */
export const FAKE_TERMINAL_SIZE = { cols: 120, rows: 40 };

export interface FakeMateRunner {
	fetch: typeof fetch;
	requests: FakeRequest[];
	/** Append an agent event to a chat (live listeners get it too). Returns its id. */
	emit(chat_id: string, event: EventInput): string;
	events(chat_id: string): MissionEvent[];
	sessionOf(chat_id: string): string | undefined;
	/** Number of open event streams on a chat. */
	listeners(chat_id: string): number;
	/** Answer the next request to `pathSuffix` with this status and body. */
	failNext(pathSuffix: string, status: number, body?: unknown): void;
	/** End event streams right after the replay instead of following live. */
	end_after_replay: boolean;
	interrupts: string[];
	deleted: string[];
	/** Terminal attaches in the order they were opened. */
	attaches: FakeRunnerAttach[];
}

export function createFakeMateRunner(secret = FAKE_RUNNER_SECRET): FakeMateRunner {
	const chats = new Map<string, FakeChat>();
	const failures: { suffix: string; status: number; body?: unknown }[] = [];
	let seq = 0;

	const chatOf = (id: string): FakeChat => {
		let chat = chats.get(id);
		if (chat === undefined) {
			chat = { events: [], messages: new Map(), listeners: new Set() };
			chats.set(id, chat);
		}
		return chat;
	};

	const append = (chat_id: string, event: EventInput): string => {
		seq += 1;
		const id = `e${String(seq).padStart(6, '0')}`;
		const full = { ...event, id } as MissionEvent;
		const chat = chatOf(chat_id);
		chat.events.push(full);
		for (const listener of chat.listeners) listener(full);
		return id;
	};

	const json = (status: number, body?: unknown) =>
		new Response(body === undefined ? null : JSON.stringify(body), {
			status,
			headers: body === undefined ? {} : { 'content-type': 'application/json' }
		});

	const encoder = new TextEncoder();
	const sse = (event: string, data: string) => encoder.encode(`event: ${event}\ndata: ${data}\n\n`);

	const openTerminal = (chat_id: string, body: string, signal: AbortSignal | undefined) => {
		const { mode } = JSON.parse(body) as { mode: 'watch' | 'take_over' };
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const attach: FakeRunnerAttach = {
			id: `ta_${String(fake.attaches.length + 1).padStart(32, '0')}`,
			chat_id,
			mode,
			inputs: [],
			closed: false,
			output: (text) => push(sse('output', Buffer.from(text).toString('base64'))),
			resize: (cols, rows) => push(sse('resize', JSON.stringify({ cols, rows }))),
			end(reason) {
				push(sse('end', JSON.stringify({ reason })));
				attach.closed = true;
				controller.close();
			}
		};
		const push = (bytes: Uint8Array) => {
			if (!attach.closed) controller.enqueue(bytes);
		};
		fake.attaches.push(attach);
		const stream = new ReadableStream<Uint8Array>({
			start(c) {
				controller = c;
				c.enqueue(encoder.encode(': connected\n\n'));
				c.enqueue(sse('open', JSON.stringify({ attach: attach.id, mode, ...FAKE_TERMINAL_SIZE })));
				signal?.addEventListener(
					'abort',
					() => {
						attach.closed = true;
						try {
							controller.error(signal.reason);
						} catch {
							// Already closed.
						}
					},
					{ once: true }
				);
			},
			cancel() {
				attach.closed = true;
			}
		});
		return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
	};

	const frame = (event: MissionEvent) => `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;

	const fake: FakeMateRunner = {
		requests: [],
		interrupts: [],
		deleted: [],
		attaches: [],
		end_after_replay: false,

		async fetch(input, init) {
			const url = new URL(typeof input === 'string' ? input : input.toString());
			const method = (init?.method ?? 'GET').toUpperCase();
			const headers = new Headers(init?.headers);
			const body = typeof init?.body === 'string' ? init.body : '';
			const target = `${url.pathname}${url.search}`;
			fake.requests.push({ method, target, headers, body });

			const timestamp = headers.get('x-beadsmith-timestamp') ?? '';
			const expected = await signWebhookRequest(secret, timestamp, method, target, body);
			if (headers.get('x-beadsmith-signature') !== expected) {
				return json(401, { error: 'bad signature' });
			}
			if (headers.get('x-beadsmith-contract') !== '1') {
				return json(400, { error: 'unknown contract' });
			}
			const failure = failures.findIndex((item) => url.pathname.endsWith(item.suffix));
			if (failure !== -1) {
				const [item] = failures.splice(failure, 1);
				return json(item!.status, item!.body);
			}

			const path = url.pathname.replace(/^\/base/, '');
			if (method === 'GET' && path === '/v1/health') {
				return json(200, { ok: true });
			}
			const match =
				/^\/v1\/mate\/chats\/([^/]+)(\/messages|\/events|\/interrupt|\/terminal(?:\/([^/]+))?)?$/.exec(
					path
				);
			if (match === null) {
				return json(404, { error: 'no route' });
			}
			const chat_id = decodeURIComponent(match[1]!);
			const action = match[3] === undefined ? match[2] : '/terminal/:attach';

			if (method === 'POST' && action === '/terminal') {
				return openTerminal(chat_id, body, init?.signal ?? undefined);
			}
			if (method === 'POST' && action === '/terminal/:attach') {
				const attach = fake.attaches.find((a) => a.id === match[3] && a.chat_id === chat_id);
				if (attach === undefined || attach.closed) return json(404, { error: 'not open' });
				if (attach.mode !== 'take_over') return json(409, { error: 'watching' });
				attach.inputs.push(JSON.parse(body) as FakeRunnerAttach['inputs'][number]);
				return new Response(null, { status: 204 });
			}

			if (method === 'POST' && action === '/messages') {
				const payload = JSON.parse(body) as {
					session_id: string;
					message_id: string;
					prompt: string;
				};
				const chat = chatOf(chat_id);
				chat.session_id ??= payload.session_id;
				const seen = chat.messages.get(payload.message_id);
				if (seen !== undefined) {
					return json(202, { event_id: seen });
				}
				// The real runner records the message id on the user event (event-log.ts).
				const event_id = append(chat_id, {
					type: 'user',
					text: payload.prompt,
					message_id: payload.message_id
				});
				chat.messages.set(payload.message_id, event_id);
				return json(202, { event_id });
			}
			if (method === 'POST' && action === '/interrupt') {
				fake.interrupts.push(chat_id);
				return json(202, {});
			}
			if (method === 'DELETE' && action === undefined) {
				fake.deleted.push(chat_id);
				chats.delete(chat_id);
				return new Response(null, { status: 204 });
			}
			if (method === 'GET' && action === '/events') {
				const after = url.searchParams.get('after');
				const chat = chatOf(chat_id);
				const signal = init?.signal ?? undefined;
				let listener: ((event: MissionEvent) => void) | undefined;
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						const start = after === null ? 0 : chat.events.findIndex((e) => e.id === after) + 1;
						controller.enqueue(encoder.encode(': ping\n\n'));
						for (const event of chat.events.slice(start)) {
							controller.enqueue(encoder.encode(frame(event)));
						}
						if (fake.end_after_replay) {
							controller.close();
							return;
						}
						listener = (event) => controller.enqueue(encoder.encode(frame(event)));
						chat.listeners.add(listener);
						signal?.addEventListener(
							'abort',
							() => {
								if (listener) chat.listeners.delete(listener);
								try {
									controller.error(signal.reason);
								} catch {
									// Already closed.
								}
							},
							{ once: true }
						);
					},
					cancel() {
						if (listener) chat.listeners.delete(listener);
					}
				});
				return new Response(stream, {
					status: 200,
					headers: { 'content-type': 'text/event-stream' }
				});
			}
			return json(405, { error: 'method not allowed' });
		},

		emit: append,
		events: (chat_id) => chatOf(chat_id).events,
		sessionOf: (chat_id) => chats.get(chat_id)?.session_id,
		listeners: (chat_id) => chats.get(chat_id)?.listeners.size ?? 0,
		failNext(suffix, status, body) {
			failures.push({ suffix, status, body });
		}
	};
	return fake;
}
