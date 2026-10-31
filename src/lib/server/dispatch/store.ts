import type { Client } from '@libsql/client';
import { randomBytes } from 'node:crypto';
import type {
	DispatchOperation,
	DispatchProviderId,
	DispatchStatus,
	DispatchTurn
} from '$lib/types.js';
import { DispatchError, type DispatchPayload, type DispatchRecord } from './types.js';

export interface CreateDispatchInput {
	idempotency_key: string;
	project_id: string;
	dolt_database: string;
	operation: DispatchOperation;
	actor: string;
	payload: DispatchPayload;
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

/** Turn text is display copy, so it is capped like a follow-up. */
export const TURN_TEXT_MAX = 8000;

export interface ListDispatchFilter {
	project_id?: string;
	issue_id?: string;
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
		},
		now?: () => Date
	): Promise<DispatchRecord | undefined>;
	/** Move a terminal mission onto a new run of the same agent (follow-up). */
	startFollowUp(
		id: string,
		patch: { run_id: string; status: 'launched' | 'running' },
		now?: () => Date
	): Promise<DispatchRecord | undefined>;
	/** Append a conversation turn. A second agent turn for the same run is ignored. */
	appendTurn(request_id: string, turn: AppendTurnInput, now?: () => Date): Promise<void>;
	/** Turns for one mission, oldest first. */
	listTurns(request_id: string): Promise<DispatchTurn[]>;
}

const DISPATCH_SELECT = `SELECT
	id, idempotency_key, project_id, dolt_database, operation, actor, payload_json,
	status, provider, agent_id, agent_url, run_id, error_message,
	result_summary, duration_ms, git_pr_url,
	created_at, updated_at
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
		provider: row.provider === 'webhook' ? row.provider : undefined,
		agent_id: asText(row.agent_id),
		agent_url: asText(row.agent_url),
		run_id: asText(row.run_id),
		error_message: asText(row.error_message),
		result_summary: asText(row.result_summary),
		duration_ms: asNonNegativeInteger(row.duration_ms),
		git_pr_url: asText(row.git_pr_url),
		created_at: String(row.created_at),
		updated_at: String(row.updated_at)
	};
}

/** Build a dispatch store over an already-initialised libsql client. */
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
						status, created_at, updated_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
					args: [
						id,
						input.idempotency_key,
						input.project_id,
						input.dolt_database,
						input.operation,
						input.actor,
						JSON.stringify(input.payload),
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
					now().toISOString(),
					id,
					patch.status
				]
			});
			return this.get(id);
		},

		async startFollowUp(
			id: string,
			patch: { run_id: string; status: 'launched' | 'running' },
			now: () => Date = () => new Date()
		): Promise<DispatchRecord | undefined> {
			await client.execute({
				sql: `UPDATE dispatch_requests SET
					status = ?,
					run_id = ?,
					error_message = NULL,
					updated_at = ?
				WHERE id = ?
					AND agent_id IS NOT NULL
					AND status IN ('succeeded', 'cancelled', 'failed')`,
				args: [patch.status, patch.run_id, now().toISOString(), id]
			});
			const updated = await this.get(id);
			if (
				updated === undefined ||
				updated.status !== patch.status ||
				updated.run_id !== patch.run_id
			) {
				return undefined;
			}
			return updated;
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
		}
	};
}
