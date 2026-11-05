/**
 * First Mate chats in `state.db` (ADR-0004). A chat belongs to one account
 * and names the runner session behind it. Its events are the MissionEvents
 * Beadsmith has seen for that session, in order, so a reconnecting view can
 * catch up from the runner with `after=<last runner event id>`.
 *
 * Events keep compact fields only: text for user, assistant, result and
 * error; name and status for a tool call (never its arguments or output);
 * thinking cut short. `origin` tells runner events from the placeholder
 * replies Beadsmith writes itself when no runner is connected; only runner
 * ids are ever sent back to the runner.
 */
import type { Client } from '@libsql/client';
import { randomBytes, randomUUID } from 'node:crypto';
import type { MateChat, MateEvent } from '#lib/mate.js';
import type { MissionEvent } from '#lib/mission-events.js';

export const MATE_SCHEMA_SQL: string[] = [
	`CREATE TABLE IF NOT EXISTS mate_chats (
		id TEXT PRIMARY KEY,
		owner_id TEXT NOT NULL,
		title TEXT NOT NULL,
		scope TEXT,
		session_id TEXT NOT NULL UNIQUE,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`,
	'CREATE INDEX IF NOT EXISTS mate_chats_owner ON mate_chats (owner_id, updated_at)',
	`CREATE TABLE IF NOT EXISTS mate_events (
		seq INTEGER PRIMARY KEY,
		chat_id TEXT NOT NULL REFERENCES mate_chats (id) ON DELETE CASCADE,
		event_id TEXT NOT NULL,
		origin TEXT NOT NULL,
		type TEXT NOT NULL,
		text TEXT,
		call_id TEXT,
		tool_name TEXT,
		status TEXT,
		duration_ms INTEGER,
		git_pr_url TEXT,
		at TEXT NOT NULL,
		UNIQUE (chat_id, event_id)
	)`
];

/** Thinking is kept short: the UI shows it folded, if at all. */
export const THINKING_TEXT_MAX = 2_000;

export type MateEventOrigin = 'runner' | 'local';

/** A chat with the runner session id, which never leaves the server. */
export interface StoredMateChat extends MateChat {
	session_id: string;
}

export interface MateStore {
	listChats(owner_id: string, limit: number): Promise<MateChat[]>;
	countChats(owner_id: string): Promise<number>;
	getChat(owner_id: string, id: string): Promise<StoredMateChat | undefined>;
	createChat(owner_id: string, input: { title: string; scope: string | null }): Promise<MateChat>;
	updateChat(
		owner_id: string,
		id: string,
		patch: { title?: string; scope?: string | null }
	): Promise<MateChat | undefined>;
	deleteChat(owner_id: string, id: string): Promise<boolean>;
	/**
	 * Store events in order, skipping ids the chat already has. Returns the
	 * ones that were new. Callers check ownership first.
	 */
	appendEvents(
		chat_id: string,
		events: readonly MissionEvent[],
		origin: MateEventOrigin
	): Promise<MateEvent[]>;
	/**
	 * The chat's most recent `limit` events, oldest first; only those after
	 * `after` when that id is stored (all of them otherwise).
	 */
	listEvents(chat_id: string, options: { after?: string; limit: number }): Promise<MateEvent[]>;
	/** The newest event id that came from the runner: the catch-up cursor. */
	lastRunnerEventId(chat_id: string): Promise<string | undefined>;
}

function row(value: unknown): Record<string, unknown> {
	return value as Record<string, unknown>;
}

function optText(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function toChat(value: unknown): StoredMateChat {
	const r = row(value);
	return {
		id: String(r.id),
		title: String(r.title),
		scope: optText(r.scope) ?? null,
		session_id: String(r.session_id),
		created_at: String(r.created_at),
		updated_at: String(r.updated_at)
	};
}

/** A chat without its session id, for the browser. */
export function publicChat(chat: StoredMateChat): MateChat {
	return {
		id: chat.id,
		title: chat.title,
		scope: chat.scope,
		created_at: chat.created_at,
		updated_at: chat.updated_at
	};
}

/** Rebuild the event a row stored; undefined for a row this build cannot read. */
function toEvent(value: unknown): MateEvent | undefined {
	const r = row(value);
	const id = String(r.event_id);
	const at = String(r.at);
	const text = optText(r.text);
	switch (r.type) {
		case 'user':
		case 'assistant':
		case 'thinking':
			return text === undefined ? undefined : { type: r.type, id, text, at };
		case 'error':
			return { type: 'error', id, message: text ?? 'The agent reported an error.', at };
		case 'tool_call': {
			const name = optText(r.tool_name);
			const call_id = optText(r.call_id);
			if (name === undefined || call_id === undefined) return undefined;
			return {
				type: 'tool_call',
				id,
				call_id,
				name,
				status: r.status === 'completed' ? 'completed' : 'running',
				at
			};
		}
		case 'result': {
			const status =
				r.status === 'succeeded' || r.status === 'cancelled' || r.status === 'failed'
					? r.status
					: 'failed';
			const event: MateEvent = { type: 'result', id, status, at };
			if (text !== undefined) event.text = text;
			if (typeof r.duration_ms === 'number' || typeof r.duration_ms === 'bigint') {
				event.duration_ms = Number(r.duration_ms);
			}
			const pr = optText(r.git_pr_url);
			if (pr !== undefined) event.git_pr_url = pr;
			return event;
		}
		default:
			return undefined;
	}
}

type Columns = {
	text: string | null;
	call_id: string | null;
	tool_name: string | null;
	status: string | null;
	duration_ms: number | null;
	git_pr_url: string | null;
};

function columnsFor(event: MissionEvent): Columns {
	const empty: Columns = {
		text: null,
		call_id: null,
		tool_name: null,
		status: null,
		duration_ms: null,
		git_pr_url: null
	};
	switch (event.type) {
		case 'user':
		case 'assistant':
			return { ...empty, text: event.text };
		case 'thinking':
			return {
				...empty,
				text:
					event.text.length > THINKING_TEXT_MAX
						? `${event.text.slice(0, THINKING_TEXT_MAX - 1)}…`
						: event.text
			};
		case 'error':
			return { ...empty, text: event.message };
		case 'tool_call':
			return { ...empty, call_id: event.call_id, tool_name: event.name, status: event.status };
		case 'result':
			return {
				...empty,
				text: event.text ?? null,
				status: event.status,
				duration_ms: event.duration_ms ?? null,
				git_pr_url: event.git_pr_url ?? null
			};
	}
}

const EVENT_COLUMNS =
	'seq, event_id, type, text, call_id, tool_name, status, duration_ms, git_pr_url, at';

export function createMateStore(client: Client, now: () => Date = () => new Date()): MateStore {
	async function getChat(owner_id: string, id: string): Promise<StoredMateChat | undefined> {
		const result = await client.execute({
			sql: `SELECT id, title, scope, session_id, created_at, updated_at
				FROM mate_chats WHERE id = ? AND owner_id = ?`,
			args: [id, owner_id]
		});
		return result.rows[0] === undefined ? undefined : toChat(result.rows[0]);
	}

	return {
		async listChats(owner_id, limit) {
			const result = await client.execute({
				sql: `SELECT id, title, scope, session_id, created_at, updated_at FROM mate_chats
					WHERE owner_id = ? ORDER BY updated_at DESC, id LIMIT ?`,
				args: [owner_id, limit]
			});
			return result.rows.map((value) => publicChat(toChat(value)));
		},

		async countChats(owner_id) {
			const result = await client.execute({
				sql: 'SELECT COUNT(*) AS n FROM mate_chats WHERE owner_id = ?',
				args: [owner_id]
			});
			return Number(row(result.rows[0]).n ?? 0);
		},

		getChat,

		async createChat(owner_id, input) {
			const stamp = now().toISOString();
			const id = `mc_${randomBytes(12).toString('hex')}`;
			await client.execute({
				sql: `INSERT INTO mate_chats (id, owner_id, title, scope, session_id, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?)`,
				args: [id, owner_id, input.title, input.scope, randomUUID(), stamp, stamp]
			});
			return { id, title: input.title, scope: input.scope, created_at: stamp, updated_at: stamp };
		},

		async updateChat(owner_id, id, patch) {
			const sets: string[] = [];
			const args: (string | null)[] = [];
			if (patch.title !== undefined) {
				sets.push('title = ?');
				args.push(patch.title);
			}
			if (patch.scope !== undefined) {
				sets.push('scope = ?');
				args.push(patch.scope);
			}
			if (sets.length > 0) {
				args.push(id, owner_id);
				await client.execute({
					sql: `UPDATE mate_chats SET ${sets.join(', ')} WHERE id = ? AND owner_id = ?`,
					args
				});
			}
			const chat = await getChat(owner_id, id);
			return chat === undefined ? undefined : publicChat(chat);
		},

		async deleteChat(owner_id, id) {
			// Events go with the chat (foreign key, ON DELETE CASCADE); delete them
			// explicitly too, for a connection opened without foreign keys.
			const owned = await getChat(owner_id, id);
			if (owned === undefined) {
				return false;
			}
			await client.batch(
				[
					{ sql: 'DELETE FROM mate_events WHERE chat_id = ?', args: [id] },
					{ sql: 'DELETE FROM mate_chats WHERE id = ? AND owner_id = ?', args: [id, owner_id] }
				],
				'write'
			);
			return true;
		},

		async appendEvents(chat_id, events, origin) {
			const stored: MateEvent[] = [];
			for (const event of events) {
				const at = now().toISOString();
				const c = columnsFor(event);
				const result = await client.execute({
					sql: `INSERT OR IGNORE INTO mate_events
						(chat_id, event_id, origin, type, text, call_id, tool_name, status, duration_ms, git_pr_url, at)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					args: [
						chat_id,
						event.id,
						origin,
						event.type,
						c.text,
						c.call_id,
						c.tool_name,
						c.status,
						c.duration_ms,
						c.git_pr_url,
						at
					]
				});
				if (result.rowsAffected > 0) {
					stored.push({ ...event, at } as MateEvent);
				}
			}
			if (stored.length > 0) {
				await client.execute({
					sql: 'UPDATE mate_chats SET updated_at = ? WHERE id = ?',
					args: [now().toISOString(), chat_id]
				});
			}
			return stored;
		},

		async listEvents(chat_id, options) {
			let after_seq = 0;
			if (options.after !== undefined) {
				const found = await client.execute({
					sql: 'SELECT seq FROM mate_events WHERE chat_id = ? AND event_id = ?',
					args: [chat_id, options.after]
				});
				if (found.rows[0] !== undefined) {
					after_seq = Number(row(found.rows[0]).seq);
				}
			}
			const result = await client.execute({
				sql: `SELECT ${EVENT_COLUMNS} FROM (
						SELECT ${EVENT_COLUMNS} FROM mate_events
						WHERE chat_id = ? AND seq > ? ORDER BY seq DESC LIMIT ?
					) ORDER BY seq`,
				args: [chat_id, after_seq, options.limit]
			});
			return result.rows.map(toEvent).filter((event) => event !== undefined);
		},

		async lastRunnerEventId(chat_id) {
			const result = await client.execute({
				sql: `SELECT event_id FROM mate_events WHERE chat_id = ? AND origin = 'runner'
					ORDER BY seq DESC LIMIT 1`,
				args: [chat_id]
			});
			return result.rows[0] === undefined ? undefined : String(row(result.rows[0]).event_id);
		}
	};
}
