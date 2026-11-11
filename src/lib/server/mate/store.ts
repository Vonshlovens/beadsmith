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
 *
 * Crew calls (`mate_crew_calls`) are a separate, bounded record of the crew
 * tool calls Beadsmith answered for a chat: the arguments and the result or
 * error text it sent back, each cut short, keyed by Claude Code's tool use id
 * so the chat can attach them to their activity lines. Crew tools run inside
 * Beadsmith, so this is Beadsmith's own action log for the chat's owner; the
 * agent's other tools' arguments and output are still never stored.
 */
import type { Client } from '@libsql/client';
import { randomBytes, randomUUID } from 'node:crypto';
import {
	CREW_CALL_ARGUMENTS_MAX,
	CREW_CALL_REASON_MAX,
	CREW_CALL_RESULT_MAX,
	CREW_CALLS_PER_CHAT,
	MATE_RUNNER_IDS,
	type MateChat,
	type MateCrewCall,
	type MateCrewCallDetail,
	type MateEvent,
	type MateRunnerId
} from '#lib/mate.js';
import type { MissionEvent } from '#lib/mission-events.js';
import { accountRole, type AccountRole } from '../auth/roles.js';

export const MATE_SCHEMA_SQL: string[] = [
	`CREATE TABLE IF NOT EXISTS mate_chats (
		id TEXT PRIMARY KEY,
		owner_id TEXT NOT NULL,
		title TEXT NOT NULL,
		scope TEXT,
		session_id TEXT NOT NULL UNIQUE,
		runner TEXT,
		model TEXT,
		effort TEXT,
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
		message_id TEXT,
		call_id TEXT,
		tool_name TEXT,
		status TEXT,
		duration_ms INTEGER,
		git_pr_url TEXT,
		at TEXT NOT NULL,
		UNIQUE (chat_id, event_id)
	)`,
	`CREATE TABLE IF NOT EXISTS mate_crew_calls (
		chat_id TEXT NOT NULL REFERENCES mate_chats (id) ON DELETE CASCADE,
		call_id TEXT NOT NULL,
		tool TEXT NOT NULL,
		arguments TEXT NOT NULL,
		result TEXT NOT NULL,
		is_error INTEGER NOT NULL,
		mission_id TEXT,
		at TEXT NOT NULL,
		PRIMARY KEY (chat_id, call_id)
	)`,
	'CREATE INDEX IF NOT EXISTS mate_crew_calls_at ON mate_crew_calls (chat_id, at)'
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
	createChat(
		owner_id: string,
		input: {
			title: string;
			scope: string | null;
			runner?: MateRunnerId;
			/** Already checked against the operator's list by the caller. */
			model?: string;
			effort?: string;
		}
	): Promise<MateChat>;
	updateChat(
		owner_id: string,
		id: string,
		patch: { title?: string; scope?: string | null }
	): Promise<MateChat | undefined>;
	deleteChat(owner_id: string, id: string): Promise<boolean>;
	/**
	 * Who a runner session acts for (crew tools, ADR-0020 rule 3): the chat,
	 * its owner and the owner's current role. Undefined when the chat is gone,
	 * or its owner is gone or banned, so a call from a stale sandbox is refused.
	 */
	crewCaller(session_id: string): Promise<CrewCaller | undefined>;
	/**
	 * The chat a crew notice goes to, whoever owns it. Undefined when the chat
	 * is gone or its owner is banned, as for `crewCaller`. Server-internal:
	 * never answer a browser request with it.
	 */
	noticeChat(chat_id: string): Promise<StoredMateChat | undefined>;
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
	 * The chat's most recent `limit` events, oldest first; with `after`, the next
	 * `limit` events instead (from the beginning for an unknown cursor).
	 */
	listEvents(chat_id: string, options: { after?: string; limit: number }): Promise<MateEvent[]>;
	/** The newest event id that came from the runner: the catch-up cursor. */
	lastRunnerEventId(chat_id: string): Promise<string | undefined>;
	/**
	 * Keep one crew call, bounded, replacing an earlier answer to the same call
	 * (a retry), and prune the chat to its newest `CREW_CALLS_PER_CHAT`.
	 * Server-internal: the chat id comes from the caller Beadsmith resolved.
	 */
	recordCrewCall(chat_id: string, call: CrewCallInput): Promise<void>;
	/** The chat's crew calls without their bodies, oldest first. Callers check ownership. */
	listCrewCalls(chat_id: string): Promise<MateCrewCall[]>;
	/** One crew call with its arguments and result. Callers check ownership. */
	getCrewCall(chat_id: string, call_id: string): Promise<MateCrewCallDetail | undefined>;
}

/** One crew call as the MCP handler answered it, before it is bounded. */
export interface CrewCallInput {
	call_id: string;
	tool: string;
	/** JSON text of the arguments the agent sent. */
	arguments: string;
	/** The text the agent was given. */
	result: string;
	is_error: boolean;
	mission_id?: string;
}

export interface CrewCaller {
	chat_id: string;
	owner_id: string;
	/** The owner's email: the actor recorded on missions a crew tool launches. */
	owner_email: string;
	role: AccountRole;
	scope: string | null;
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
		// Chats from before runners could be chosen ran on the HTTP runner.
		runner: (MATE_RUNNER_IDS as readonly unknown[]).includes(r.runner)
			? (r.runner as MateRunnerId)
			: 'remote',
		session_id: String(r.session_id),
		...agentChoiceOf(r),
		created_at: String(r.created_at),
		updated_at: String(r.updated_at)
	};
}

/** The chat's model and effort, each only when one was picked. */
function agentChoiceOf(source: { model?: unknown; effort?: unknown }): {
	model?: string;
	effort?: string;
} {
	const model = optText(source.model);
	const effort = optText(source.effort);
	return {
		...(model === undefined ? {} : { model }),
		...(effort === undefined ? {} : { effort })
	};
}

/** Whether an `auth_user` row's ban is in force at `at`. */
function banned(r: Record<string, unknown>, at: Date): boolean {
	const expires = r.ban_expires === null ? undefined : Number(r.ban_expires);
	return Number(r.banned ?? 0) !== 0 && (expires === undefined || expires > at.getTime());
}

/** A chat without its session id, for the browser. */
export function publicChat(chat: StoredMateChat): MateChat {
	return {
		id: chat.id,
		title: chat.title,
		scope: chat.scope,
		runner: chat.runner,
		...agentChoiceOf(chat),
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
		case 'user': {
			if (text === undefined) return undefined;
			const message_id = optText(r.message_id);
			return { type: 'user', id, text, at, ...(message_id === undefined ? {} : { message_id }) };
		}
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
				status: r.status === 'completed' || r.status === 'failed' ? r.status : 'running',
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
	message_id: string | null;
	call_id: string | null;
	tool_name: string | null;
	status: string | null;
	duration_ms: number | null;
	git_pr_url: string | null;
};

function columnsFor(event: MissionEvent): Columns {
	const empty: Columns = {
		text: null,
		message_id: null,
		call_id: null,
		tool_name: null,
		status: null,
		duration_ms: null,
		git_pr_url: null
	};
	switch (event.type) {
		case 'user':
			return { ...empty, text: event.text, message_id: event.message_id ?? null };
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

/** Cut text to `max` characters, saying so, as crew results are cut for the agent. */
function bound(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}… [cut ${text.length - max} chars]`;
}

function toCrewCall(value: unknown): MateCrewCall {
	const r = row(value);
	const is_error = Number(r.is_error ?? 0) !== 0;
	const call: MateCrewCall = {
		call_id: String(r.call_id),
		tool: String(r.tool),
		is_error,
		at: String(r.at)
	};
	const reason = optText(r.reason);
	if (is_error && reason !== undefined) call.reason = reason;
	const mission_id = optText(r.mission_id);
	if (mission_id !== undefined) call.mission_id = mission_id;
	return call;
}

const EVENT_COLUMNS =
	'seq, event_id, type, text, message_id, call_id, tool_name, status, duration_ms, git_pr_url, at';

export function createMateStore(client: Client, now: () => Date = () => new Date()): MateStore {
	async function getChat(owner_id: string, id: string): Promise<StoredMateChat | undefined> {
		const result = await client.execute({
			sql: `SELECT id, title, scope, session_id, runner, model, effort, created_at, updated_at
				FROM mate_chats WHERE id = ? AND owner_id = ?`,
			args: [id, owner_id]
		});
		return result.rows[0] === undefined ? undefined : toChat(result.rows[0]);
	}

	return {
		async listChats(owner_id, limit) {
			const result = await client.execute({
				sql: `SELECT id, title, scope, session_id, runner, model, effort, created_at, updated_at FROM mate_chats
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
			const runner = input.runner ?? 'remote';
			await client.execute({
				sql: `INSERT INTO mate_chats (id, owner_id, title, scope, session_id, runner, model, effort, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				args: [
					id,
					owner_id,
					input.title,
					input.scope,
					randomUUID(),
					runner,
					input.model ?? null,
					input.effort ?? null,
					stamp,
					stamp
				]
			});
			return {
				id,
				title: input.title,
				scope: input.scope,
				runner,
				...agentChoiceOf(input),
				created_at: stamp,
				updated_at: stamp
			};
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

		async crewCaller(session_id) {
			// Role and ban are read on every call, not cached with the sandbox: a
			// demotion or ban takes effect on the chat's next tool call.
			const result = await client.execute({
				sql: `SELECT c.id, c.owner_id, c.scope, u.email, u.role, u.banned, u.ban_expires
					FROM mate_chats c JOIN auth_user u ON u.id = c.owner_id
					WHERE c.session_id = ?`,
				args: [session_id]
			});
			if (result.rows[0] === undefined) return undefined;
			const r = row(result.rows[0]);
			if (banned(r, now())) return undefined;
			return {
				chat_id: String(r.id),
				owner_id: String(r.owner_id),
				owner_email: String(r.email),
				role: accountRole(optText(r.role)),
				scope: optText(r.scope) ?? null
			};
		},

		async noticeChat(chat_id) {
			const result = await client.execute({
				sql: `SELECT c.id, c.title, c.scope, c.session_id, c.runner, c.model, c.effort, c.created_at, c.updated_at,
						u.banned, u.ban_expires
					FROM mate_chats c JOIN auth_user u ON u.id = c.owner_id
					WHERE c.id = ?`,
				args: [chat_id]
			});
			if (result.rows[0] === undefined) return undefined;
			const r = row(result.rows[0]);
			return banned(r, now()) ? undefined : toChat(r);
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
					{ sql: 'DELETE FROM mate_crew_calls WHERE chat_id = ?', args: [id] },
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
						(chat_id, event_id, origin, type, text, message_id, call_id, tool_name, status, duration_ms, git_pr_url, at)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					args: [
						chat_id,
						event.id,
						origin,
						event.type,
						c.text,
						c.message_id,
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
						WHERE chat_id = ? AND seq > ? ORDER BY seq ${options.after === undefined ? 'DESC' : 'ASC'} LIMIT ?
					) ORDER BY seq`,
				args: [chat_id, after_seq, options.limit]
			});
			return result.rows.map(toEvent).filter((event) => event !== undefined);
		},

		async recordCrewCall(chat_id, call) {
			await client.batch(
				[
					{
						sql: `INSERT INTO mate_crew_calls
							(chat_id, call_id, tool, arguments, result, is_error, mission_id, at)
							VALUES (?, ?, ?, ?, ?, ?, ?, ?)
							ON CONFLICT (chat_id, call_id) DO UPDATE SET tool = excluded.tool,
								arguments = excluded.arguments, result = excluded.result,
								is_error = excluded.is_error, mission_id = excluded.mission_id,
								at = excluded.at`,
						args: [
							chat_id,
							call.call_id,
							call.tool,
							bound(call.arguments, CREW_CALL_ARGUMENTS_MAX),
							bound(call.result, CREW_CALL_RESULT_MAX),
							call.is_error ? 1 : 0,
							call.mission_id ?? null,
							now().toISOString()
						]
					},
					{
						sql: `DELETE FROM mate_crew_calls WHERE chat_id = ? AND call_id NOT IN (
								SELECT call_id FROM mate_crew_calls WHERE chat_id = ?
								ORDER BY at DESC, rowid DESC LIMIT ?
							)`,
						args: [chat_id, chat_id, CREW_CALLS_PER_CHAT]
					}
				],
				'write'
			);
		},

		async listCrewCalls(chat_id) {
			// Only a refusal's opening words travel with the list; bodies are read on demand.
			const result = await client.execute({
				sql: `SELECT call_id, tool, is_error, mission_id, at,
						CASE WHEN is_error <> 0 THEN substr(result, 1, ?) END AS reason
					FROM mate_crew_calls WHERE chat_id = ? ORDER BY at, rowid`,
				args: [CREW_CALL_REASON_MAX, chat_id]
			});
			return result.rows.map(toCrewCall);
		},

		async getCrewCall(chat_id, call_id) {
			const result = await client.execute({
				sql: `SELECT call_id, tool, is_error, mission_id, at, arguments, result,
						CASE WHEN is_error <> 0 THEN substr(result, 1, ?) END AS reason
					FROM mate_crew_calls WHERE chat_id = ? AND call_id = ?`,
				args: [CREW_CALL_REASON_MAX, chat_id, call_id]
			});
			const found = result.rows[0];
			if (found === undefined) return undefined;
			const r = row(found);
			return { ...toCrewCall(found), arguments: String(r.arguments), result: String(r.result) };
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
