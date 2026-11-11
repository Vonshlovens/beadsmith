/**
 * The runner's durable record of one chat: its session metadata and every
 * mission event, appended as JSON lines. Beadsmith catches up with
 * `?after=<event id>`, so ids are ordered: `e` and a zero-padded sequence.
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	truncateSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { isMissionEvent, type MissionEvent } from '../mission-events.js';

type Draft<T> = T extends MissionEvent ? Omit<T, 'id'> : never;
/** A mission event before the log gives it an id. */
export type MissionEventDraft = Draft<MissionEvent>;

export const CHAT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const EVENT_ID = /^e(\d{9})$/;

export interface ChatMeta {
	session_id: string;
	scope: string | null;
	/** Messages accepted whose turn has not ended (queued or running). */
	pending?: number;
	created_at: string;
}

export function eventId(seq: number): string {
	return `e${String(seq).padStart(9, '0')}`;
}

/** The sequence number of an event id, or undefined when it is not one. */
export function eventSeq(id: string | undefined): number | undefined {
	if (id === undefined) return undefined;
	const match = EVENT_ID.exec(id);
	return match === null ? undefined : Number(match[1]);
}

type Listener = (event: MissionEvent) => void;

export class ChatLog {
	readonly chat_id: string;
	readonly #events_path: string;
	readonly #meta_path: string;
	readonly #events: MissionEvent[] = [];
	readonly #listeners = new Set<Listener>();
	#meta: ChatMeta | undefined;

	constructor(dir: string, chat_id: string) {
		if (!CHAT_ID_PATTERN.test(chat_id)) throw new Error('invalid chat id');
		this.chat_id = chat_id;
		this.#events_path = join(dir, `${chat_id}.jsonl`);
		this.#meta_path = join(dir, `${chat_id}.json`);
		if (existsSync(this.#meta_path)) {
			this.#meta = JSON.parse(readFileSync(this.#meta_path, 'utf8')) as ChatMeta;
		}
		if (existsSync(this.#events_path)) {
			const bytes = readFileSync(this.#events_path);
			const end = bytes.lastIndexOf(10) + 1;
			// Remove an incomplete tail before appending, or it would swallow the next event.
			if (end < bytes.length) truncateSync(this.#events_path, end);
			for (const line of bytes.subarray(0, end).toString('utf8').split('\n')) {
				if (line.length === 0) continue;
				try {
					const event: unknown = JSON.parse(line);
					if (isMissionEvent(event)) this.#events.push(event);
				} catch {
					// A torn last line from a crash: keep what parsed.
				}
			}
		}
		const last = this.#events.at(-1);
		if (
			(this.#meta?.pending ?? 0) > 0 ||
			(last !== undefined && last.type !== 'result' && last.type !== 'error')
		) {
			// Delivery across a crashed process boundary is ambiguous. Never silently
			// replay potentially side-effecting work; surface the uncertainty instead.
			this.append({
				type: 'error',
				message:
					'The runner restarted during a turn. Its outcome is unknown; check the work before sending another message.'
			});
			if (this.#meta !== undefined) this.setMeta({ ...this.#meta, pending: 0 });
		}
	}

	get meta(): ChatMeta | undefined {
		return this.#meta;
	}

	setMeta(meta: ChatMeta): void {
		writeFileSync(`${this.#meta_path}.tmp`, JSON.stringify(meta), { mode: 0o600, flush: true });
		renameSync(`${this.#meta_path}.tmp`, this.#meta_path);
		this.#meta = meta;
	}

	append(draft: MissionEventDraft): MissionEvent {
		const last = this.#events.at(-1);
		const seq = (last === undefined ? 0 : (eventSeq(last.id) ?? this.#events.length)) + 1;
		const event = { ...draft, id: eventId(seq) } as MissionEvent;
		appendFileSync(this.#events_path, `${JSON.stringify(event)}\n`, { mode: 0o600, flush: true });
		this.#events.push(event);
		for (const listener of this.#listeners) listener(event);
		return event;
	}

	/**
	 * Record a user message under the caller's message id, once: a retried
	 * request with the same id returns the event recorded the first time and
	 * `created: false`, so the prompt is not sent to the agent twice.
	 */
	user(message_id: string): MissionEvent | undefined {
		return this.#events.find(
			(event) =>
				event.type === 'user' && (event as { message_id?: unknown }).message_id === message_id
		);
	}

	appendUser(text: string, message_id: string): { event: MissionEvent; created: boolean } {
		const existing = this.#events.find(
			(event) =>
				event.type === 'user' && (event as { message_id?: unknown }).message_id === message_id
		);
		if (existing !== undefined) return { event: existing, created: false };
		const draft = { type: 'user', text, message_id } as MissionEventDraft;
		return { event: this.append(draft), created: true };
	}

	/** Events after `id` (all of them when `id` is absent or unknown). */
	after(id: string | undefined): MissionEvent[] {
		const seq = eventSeq(id);
		if (seq === undefined) return [...this.#events];
		return this.#events.filter((event) => (eventSeq(event.id) ?? 0) > seq);
	}

	subscribe(listener: Listener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Forget the chat: files and listeners. */
	remove(): void {
		this.#listeners.clear();
		rmSync(this.#events_path, { force: true });
		rmSync(this.#meta_path, { force: true });
		this.#meta = undefined;
		this.#events.length = 0;
	}
}

export class ChatStore {
	readonly #dir: string;
	readonly #logs = new Map<string, ChatLog>();

	constructor(dir: string) {
		this.#dir = dir;
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}

	/** The chat's log; loads it from disk on first use. */
	get(chat_id: string): ChatLog {
		let log = this.#logs.get(chat_id);
		if (log === undefined) {
			log = new ChatLog(this.#dir, chat_id);
			this.#logs.set(chat_id, log);
		}
		return log;
	}

	remove(chat_id: string): void {
		this.get(chat_id).remove();
		this.#logs.delete(chat_id);
	}
}
