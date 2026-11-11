import type { Client } from '@libsql/client';
import { randomBytes } from 'node:crypto';
import type {
	DispatchOperation,
	DispatchProviderId,
	DispatchStatus,
	DispatchTurn,
	LoopIteration
} from '#lib/types.js';
import { DISPATCH_PROVIDER_IDS } from '#lib/types.js';
import { DispatchError, type DispatchPayload, type DispatchRecord } from './types.js';
import {
	RALPH_ITERATION_OUTCOMES,
	RALPH_STOP_REASONS,
	type RalphIterationOutcome,
	type RalphStopReason
} from '#lib/ralph.js';
import type { LoopEnd } from './provider.js';
import type { RalphIteration } from './ralph.js';

export interface CreateDispatchInput {
	idempotency_key: string;
	project_id: string;
	dolt_database: string;
	operation: DispatchOperation;
	actor: string;
	payload: DispatchPayload;
	/** First Mate chat launching it through a crew tool. */
	chat_id?: string;
	now?: () => Date;
}

/** A turn as the service appends it; the store assigns `seq` and the time. */
export interface AppendTurnInput {
	role: DispatchTurn['role'];
	text: string;
	run_id?: string;
	status?: DispatchTurn['status'];
}

/**
 * Conversation turns per mission: operator messages and
 * each finished run's reply, one agent turn per run. `seq` is the rowid, so
 * it only grows; turns are never deleted.
 */
export const DISPATCH_TURNS_SCHEMA_SQL: string[] = [
	`CREATE TABLE IF NOT EXISTS dispatch_turns (
		seq INTEGER PRIMARY KEY,
		request_id TEXT NOT NULL,
		role TEXT NOT NULL,
		text TEXT NOT NULL,
		run_id TEXT,
		status TEXT,
		created_at TEXT NOT NULL
	)`,
	'CREATE INDEX IF NOT EXISTS dispatch_turns_request ON dispatch_turns (request_id, seq)',
	`CREATE UNIQUE INDEX IF NOT EXISTS dispatch_turns_agent_run
		ON dispatch_turns (request_id, run_id) WHERE role = 'agent' AND run_id IS NOT NULL`
];

/**
 * A loop mission's finished iterations (ADR-0019 rule 5), copied from ralph as
 * each one ends, because the sandbox holding ralph's own database is destroyed
 * with the loop. Keyed by run so a restarted loop (a new run on the same
 * mission) keeps its earlier iterations. Numbers and a commit range only: the
 * agent's words and errors stay in the sandbox.
 */
export const DISPATCH_ITERATIONS_SCHEMA_SQL: string[] = [
	`CREATE TABLE IF NOT EXISTS dispatch_loop_iterations (
		request_id TEXT NOT NULL,
		run_id TEXT NOT NULL,
		iteration INTEGER NOT NULL,
		outcome TEXT NOT NULL,
		started_at TEXT NOT NULL,
		finished_at TEXT NOT NULL,
		duration_ms INTEGER NOT NULL,
		head_before TEXT,
		head_after TEXT,
		input_tokens INTEGER NOT NULL,
		output_tokens INTEGER NOT NULL,
		cost_usd REAL,
		validate_ok INTEGER,
		plan_open INTEGER,
		PRIMARY KEY (request_id, run_id, iteration)
	)`
];

/** Turn text is display copy, so it is capped like a follow-up. */
export const TURN_TEXT_MAX = 8000;

export interface ListDispatchFilter {
	project_id?: string;
	issue_id?: string;
	/** Missions a First Mate chat's crew tools launched (ADR-0020 rule 5). */
	chat_id?: string;
	/** Only rows in one of these states (the missions still worth following). */
	statuses?: DispatchStatus[];
	limit: number;
}

export interface DispatchStore {
	create(input: CreateDispatchInput): Promise<{ record: DispatchRecord; created: boolean }>;
	get(id: string): Promise<DispatchRecord | undefined>;
	getByIdempotencyKey(key: string): Promise<DispatchRecord | undefined>;
	list(filter: ListDispatchFilter): Promise<DispatchRecord[]>;
	updateStatus(
		id: string,
		patch: {
			status: DispatchStatus;
			provider?: DispatchProviderId;
			agent_id?: string;
			agent_url?: string;
			run_id?: string;
			error_message?: string;
			result_summary?: string;
			duration_ms?: number;
			git_pr_url?: string;
			loop_end?: LoopEnd;
		},
		now?: () => Date
	): Promise<DispatchRecord | undefined>;
	/**
	 * Move a terminal mission onto a new run of the same agent (follow-up),
	 * or claim it for a loop restart (`launching`, keeping the ended run's id
	 * until the runner names the new one). Only one caller wins: undefined
	 * when the mission was not terminal.
	 */
	startFollowUp(
		id: string,
		patch: { run_id: string; status: 'launching' | 'launched' | 'running' },
		now?: () => Date
	): Promise<DispatchRecord | undefined>;
	/** Append a conversation turn. A second agent turn for the same run is ignored. */
	appendTurn(request_id: string, turn: AppendTurnInput, now?: () => Date): Promise<void>;
	/** Turns for one mission, oldest first. */
	listTurns(request_id: string): Promise<DispatchTurn[]>;
	/**
	 * Note that an operator asked a working loop to stop after its current
	 * iteration. A new run (restart) clears it. No-op once the mission ended.
	 */
	markLoopStopRequested(id: string, now?: () => Date): Promise<DispatchRecord | undefined>;
	/** Record that the launching chat has been told the outcome `key`. */
	markChatNotice(id: string, key: string): Promise<void>;
	/**
	 * A chat's finished missions whose current outcome it has not been told
	 * yet, oldest first.
	 */
	listChatNoticesDue(chat_id: string, limit: number): Promise<DispatchRecord[]>;
	/** Store a loop run's finished iterations; ones already stored are kept as they are. */
	recordLoopIterations(
		request_id: string,
		run_id: string,
		iterations: readonly RalphIteration[]
	): Promise<void>;
	/** A loop mission's iterations across its runs, oldest first. */
	listLoopIterations(request_id: string): Promise<LoopIteration[]>;
}

/**
 * Which outcome a chat-launched mission is in, for telling its chat once: the
 * terminal status of the current run. A follow-up starts a new run, so its
 * outcome is a new notice. Undefined while the mission is still working.
 * `listChatNoticesDue` computes the same key in SQL.
 */
export function chatNoticeKey(
	record: Pick<DispatchRecord, 'status' | 'run_id'>
): string | undefined {
	if (
		record.status !== 'succeeded' &&
		record.status !== 'cancelled' &&
		record.status !== 'failed'
	) {
		return undefined;
	}
	return `${record.status}:${record.run_id ?? ''}`;
}

const DISPATCH_SELECT = `SELECT
	id, idempotency_key, project_id, dolt_database, operation, actor, payload_json,
	status, provider, agent_id, agent_url, run_id, error_message,
	result_summary, duration_ms, git_pr_url, chat_id, chat_notice,
	loop_stop_reason, loop_needs_person, loop_stop_requested_at, created_at, updated_at
FROM dispatch_requests`;

function newId(): string {
	return `dq_${randomBytes(16).toString('hex')}`;
}

function asText(value: unknown): string | undefined {
	if (typeof value === 'string' && value.length > 0) {
		return value;
	}
	return undefined;
}

function asNonNegativeInteger(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
		return value;
	}
	if (typeof value === 'bigint' && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
		return Number(value);
	}
	return undefined;
}

function rowToTurn(row: Record<string, unknown>): DispatchTurn {
	const status = row.status;
	return {
		seq: asNonNegativeInteger(row.seq) ?? 0,
		role: row.role === 'agent' ? 'agent' : 'operator',
		text: String(row.text ?? ''),
		run_id: asText(row.run_id),
		status:
			status === 'succeeded' || status === 'cancelled' || status === 'failed' ? status : undefined,
		created_at: String(row.created_at)
	};
}

function payloadsEqual(left: DispatchPayload, right: DispatchPayload): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function rowToLoopEnd(row: Record<string, unknown>): { loop_end?: LoopEnd } {
	if (row.loop_needs_person === null || row.loop_needs_person === undefined) return {};
	const reason = row.loop_stop_reason;
	return {
		loop_end: {
			stop_reason: (RALPH_STOP_REASONS as readonly unknown[]).includes(reason)
				? (reason as RalphStopReason)
				: null,
			needs_person: Number(row.loop_needs_person) === 1
		}
	};
}

function rowToRecord(row: Record<string, unknown>): DispatchRecord {
	const payload = JSON.parse(String(row.payload_json)) as DispatchPayload;
	return {
		id: String(row.id),
		idempotency_key: String(row.idempotency_key),
		project_id: String(row.project_id),
		dolt_database: String(row.dolt_database),
		operation: row.operation as DispatchOperation,
		actor: String(row.actor),
		payload,
		status: row.status as DispatchStatus,
		provider: (DISPATCH_PROVIDER_IDS as readonly unknown[]).includes(row.provider)
			? (row.provider as DispatchProviderId)
			: undefined,
		agent_id: asText(row.agent_id),
		agent_url: asText(row.agent_url),
		run_id: asText(row.run_id),
		error_message: asText(row.error_message),
		result_summary: asText(row.result_summary),
		duration_ms: asNonNegativeInteger(row.duration_ms),
		git_pr_url: asText(row.git_pr_url),
		chat_id: asText(row.chat_id),
		chat_notice: asText(row.chat_notice),
		...rowToLoopEnd(row),
		...(asText(row.loop_stop_requested_at) === undefined ? {} : { loop_stop_requested: true }),
		created_at: String(row.created_at),
		updated_at: String(row.updated_at)
	};
}

/** Build a dispatch store over an already-initialised libsql client. */
function rowToIteration(row: Record<string, unknown>): LoopIteration | undefined {
	const outcome = String(row.outcome);
	if (!(RALPH_ITERATION_OUTCOMES as readonly string[]).includes(outcome)) {
		return undefined;
	}
	const optionalText = (value: unknown) =>
		value === null || value === undefined ? null : String(value);
	const optionalNumber = (value: unknown) =>
		value === null || value === undefined ? null : Number(value);
	return {
		run_id: String(row.run_id),
		iteration: Number(row.iteration),
		outcome: outcome as RalphIterationOutcome,
		started_at: String(row.started_at),
		finished_at: String(row.finished_at),
		duration_ms: Number(row.duration_ms),
		head_before: optionalText(row.head_before),
		head_after: optionalText(row.head_after),
		input_tokens: Number(row.input_tokens),
		output_tokens: Number(row.output_tokens),
		cost_usd: optionalNumber(row.cost_usd),
		validate_ok:
			row.validate_ok === null || row.validate_ok === undefined
				? null
				: Number(row.validate_ok) === 1,
		plan_open: optionalNumber(row.plan_open)
	};
}

export function createDispatchStore(client: Client): DispatchStore {
	return {
		async create(
			input: CreateDispatchInput
		): Promise<{ record: DispatchRecord; created: boolean }> {
			const clock = input.now ?? (() => new Date());
			const now = clock().toISOString();
			const id = newId();
			try {
				await client.execute({
					sql: `INSERT INTO dispatch_requests (
						id, idempotency_key, project_id, dolt_database, operation, actor, payload_json,
						chat_id, status, created_at, updated_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
					args: [
						id,
						input.idempotency_key,
						input.project_id,
						input.dolt_database,
						input.operation,
						input.actor,
						JSON.stringify(input.payload),
						input.chat_id ?? null,
						now,
						now
					]
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : '';
				if (!/unique/i.test(message)) {
					throw error;
				}
				const existing = await this.getByIdempotencyKey(input.idempotency_key);
				if (existing === undefined) {
					throw new DispatchError('conflict', 'A duplicate dispatch request already exists.');
				}
				if (
					existing.project_id !== input.project_id ||
					existing.operation !== input.operation ||
					!payloadsEqual(existing.payload, input.payload)
				) {
					throw new DispatchError(
						'conflict',
						'That idempotency key was already used for a different request.'
					);
				}
				return { record: existing, created: false };
			}

			const created = await this.get(id);
			if (created === undefined) {
				throw new DispatchError('unavailable', 'The dispatch record could not be read back.');
			}
			return { record: created, created: true };
		},

		async get(id: string): Promise<DispatchRecord | undefined> {
			const result = await client.execute({
				sql: `${DISPATCH_SELECT} WHERE id = ?`,
				args: [id]
			});
			const row = result.rows[0] as Record<string, unknown> | undefined;
			return row === undefined ? undefined : rowToRecord(row);
		},

		async getByIdempotencyKey(key: string): Promise<DispatchRecord | undefined> {
			const result = await client.execute({
				sql: `${DISPATCH_SELECT} WHERE idempotency_key = ?`,
				args: [key]
			});
			const row = result.rows[0] as Record<string, unknown> | undefined;
			return row === undefined ? undefined : rowToRecord(row);
		},

		async list(filter: ListDispatchFilter): Promise<DispatchRecord[]> {
			const clauses: string[] = [];
			const args: Array<string | number> = [];
			if (filter.project_id !== undefined) {
				clauses.push('project_id = ?');
				args.push(filter.project_id);
			}
			if (filter.issue_id !== undefined) {
				clauses.push("json_extract(payload_json, '$.issue_id') = ?");
				args.push(filter.issue_id);
			}
			if (filter.chat_id !== undefined) {
				clauses.push('chat_id = ?');
				args.push(filter.chat_id);
			}
			if (filter.statuses !== undefined) {
				if (filter.statuses.length === 0) return [];
				clauses.push(`status IN (${filter.statuses.map(() => '?').join(', ')})`);
				args.push(...filter.statuses);
			}
			args.push(filter.limit);
			const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
			const result = await client.execute({
				sql: `${DISPATCH_SELECT} ${where} ORDER BY datetime(created_at) DESC, id DESC LIMIT ?`,
				args
			});
			return result.rows.map((row) => rowToRecord(row as Record<string, unknown>));
		},

		async updateStatus(
			id: string,
			patch: {
				status: DispatchStatus;
				provider?: DispatchProviderId;
				agent_id?: string;
				agent_url?: string;
				run_id?: string;
				error_message?: string;
				result_summary?: string;
				duration_ms?: number;
				git_pr_url?: string;
				loop_end?: LoopEnd;
			},
			now: () => Date = () => new Date()
		): Promise<DispatchRecord | undefined> {
			await client.execute({
				sql: `UPDATE dispatch_requests SET
					status = ?,
					provider = COALESCE(?, provider),
					agent_id = COALESCE(?, agent_id),
					agent_url = COALESCE(?, agent_url),
					run_id = COALESCE(?, run_id),
					error_message = ?,
					result_summary = COALESCE(?, result_summary),
					duration_ms = COALESCE(?, duration_ms),
					git_pr_url = COALESCE(?, git_pr_url),
					loop_stop_reason = CASE WHEN ? THEN ? ELSE loop_stop_reason END,
					loop_needs_person = COALESCE(?, loop_needs_person),
					updated_at = ?
				WHERE id = ?
					AND (
						status NOT IN ('succeeded', 'cancelled', 'failed')
						OR status = ?
					)`,
				args: [
					patch.status,
					patch.provider ?? null,
					patch.agent_id ?? null,
					patch.agent_url ?? null,
					patch.run_id ?? null,
					patch.error_message ?? null,
					patch.result_summary ?? null,
					patch.duration_ms ?? null,
					patch.git_pr_url ?? null,
					patch.loop_end === undefined ? 0 : 1,
					patch.loop_end?.stop_reason ?? null,
					patch.loop_end === undefined ? null : patch.loop_end.needs_person ? 1 : 0,
					now().toISOString(),
					id,
					patch.status
				]
			});
			return this.get(id);
		},

		async startFollowUp(
			id: string,
			patch: { run_id: string; status: 'launching' | 'launched' | 'running' },
			now: () => Date = () => new Date()
		): Promise<DispatchRecord | undefined> {
			const claimed = await client.execute({
				sql: `UPDATE dispatch_requests SET
					status = ?,
					run_id = ?,
					error_message = NULL,
					loop_stop_reason = NULL,
					loop_needs_person = NULL,
					loop_stop_requested_at = NULL,
					updated_at = ?
				WHERE id = ?
					AND agent_id IS NOT NULL
					AND status IN ('succeeded', 'cancelled', 'failed')`,
				args: [patch.status, patch.run_id, now().toISOString(), id]
			});
			// The row count, not a read-back, says who won: a restart claim keeps
			// the run id, so a loser would read the winner's row as its own.
			if (claimed.rowsAffected === 0) {
				return undefined;
			}
			return this.get(id);
		},

		async appendTurn(
			request_id: string,
			turn: AppendTurnInput,
			now: () => Date = () => new Date()
		): Promise<void> {
			const text = turn.text.trim().slice(0, TURN_TEXT_MAX);
			if (text.length === 0) {
				return;
			}
			await client.execute({
				sql: `INSERT OR IGNORE INTO dispatch_turns (request_id, role, text, run_id, status, created_at)
					VALUES (?, ?, ?, ?, ?, ?)`,
				args: [
					request_id,
					turn.role,
					text,
					turn.run_id ?? null,
					turn.status ?? null,
					now().toISOString()
				]
			});
		},

		async listTurns(request_id: string): Promise<DispatchTurn[]> {
			const result = await client.execute({
				sql: `SELECT seq, role, text, run_id, status, created_at FROM dispatch_turns
					WHERE request_id = ? ORDER BY seq`,
				args: [request_id]
			});
			return result.rows.map((row) => rowToTurn(row as Record<string, unknown>));
		},

		async markLoopStopRequested(
			id: string,
			now: () => Date = () => new Date()
		): Promise<DispatchRecord | undefined> {
			const at = now().toISOString();
			await client.execute({
				sql: `UPDATE dispatch_requests SET
					loop_stop_requested_at = COALESCE(loop_stop_requested_at, ?),
					updated_at = ?
				WHERE id = ? AND status NOT IN ('succeeded', 'cancelled', 'failed')`,
				args: [at, at, id]
			});
			return this.get(id);
		},

		async markChatNotice(id: string, key: string): Promise<void> {
			await client.execute({
				sql: 'UPDATE dispatch_requests SET chat_notice = ? WHERE id = ?',
				args: [key, id]
			});
		},

		async listChatNoticesDue(chat_id: string, limit: number): Promise<DispatchRecord[]> {
			const result = await client.execute({
				sql: `${DISPATCH_SELECT}
					WHERE chat_id = ?
						AND status IN ('succeeded', 'cancelled', 'failed')
						AND (chat_notice IS NULL OR chat_notice != status || ':' || COALESCE(run_id, ''))
					ORDER BY datetime(updated_at), id LIMIT ?`,
				args: [chat_id, limit]
			});
			return result.rows.map((row) => rowToRecord(row as Record<string, unknown>));
		},

		async recordLoopIterations(
			request_id: string,
			run_id: string,
			iterations: readonly RalphIteration[]
		): Promise<void> {
			if (iterations.length === 0) {
				return;
			}
			await client.batch(
				iterations.map((it) => ({
					sql: `INSERT OR IGNORE INTO dispatch_loop_iterations (
							request_id, run_id, iteration, outcome, started_at, finished_at, duration_ms,
							head_before, head_after, input_tokens, output_tokens, cost_usd, validate_ok, plan_open
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					args: [
						request_id,
						run_id,
						it.iteration,
						it.outcome,
						it.started_at,
						it.finished_at,
						it.duration_ms,
						it.head_before,
						it.head_after,
						it.input_tokens,
						it.output_tokens,
						it.cost_usd,
						it.validate_ok === null ? null : it.validate_ok ? 1 : 0,
						it.plan_open
					]
				})),
				'write'
			);
		},

		async listLoopIterations(request_id: string): Promise<LoopIteration[]> {
			const result = await client.execute({
				sql: `SELECT run_id, iteration, outcome, started_at, finished_at, duration_ms, head_before,
						head_after, input_tokens, output_tokens, cost_usd, validate_ok, plan_open
					FROM dispatch_loop_iterations WHERE request_id = ?
					ORDER BY started_at, iteration`,
				args: [request_id]
			});
			return result.rows.flatMap((row) => rowToIteration(row as Record<string, unknown>) ?? []);
		}
	};
}
