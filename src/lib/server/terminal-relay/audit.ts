/**
 * The terminal relay's audit trail in `state.db` (ADR-0021 rule 4, ADR-0004):
 * who attached to which mission's or chat's terminal, watching or taking
 * over, from when until when. One row per attach; a take-over is its own
 * attach, so its row says `take_over`. No terminal bytes are ever stored.
 */
import { randomUUID } from 'node:crypto';
import type { Client } from '@libsql/client';
import type { RelayMode } from './relay.js';

export const TERMINAL_RELAY_SCHEMA_SQL: string[] = [
	`CREATE TABLE IF NOT EXISTS terminal_relay_sessions (
		id TEXT PRIMARY KEY,
		actor TEXT NOT NULL,
		target_kind TEXT NOT NULL,
		target_id TEXT NOT NULL,
		mode TEXT NOT NULL,
		started_at TEXT NOT NULL,
		ended_at TEXT,
		end_reason TEXT
	)`,
	`CREATE INDEX IF NOT EXISTS terminal_relay_sessions_target
		ON terminal_relay_sessions (target_kind, target_id, started_at)`
];

export type RelayTargetKind = 'mission' | 'chat';

export interface RelayAuditRow {
	id: string;
	actor: string;
	target_kind: RelayTargetKind;
	target_id: string;
	mode: RelayMode;
	started_at: string;
	ended_at: string | null;
	end_reason: string | null;
}

export interface TerminalRelayAuditStore {
	/** Record an attach as it begins; returns the row id. */
	start(input: {
		actor: string;
		target_kind: RelayTargetKind;
		target_id: string;
		mode: RelayMode;
	}): Promise<string>;
	/** Stamp the end once; later calls leave the first end in place. */
	end(id: string, reason: string): Promise<void>;
	/** A target's attaches, newest first. */
	list(target_kind: RelayTargetKind, target_id: string, limit: number): Promise<RelayAuditRow[]>;
}

export function createTerminalRelayAuditStore(
	client: Client,
	now: () => Date = () => new Date()
): TerminalRelayAuditStore {
	return {
		async start(input) {
			const id = `tr_${randomUUID().replaceAll('-', '')}`;
			await client.execute({
				sql: `INSERT INTO terminal_relay_sessions (id, actor, target_kind, target_id, mode, started_at)
					VALUES (?, ?, ?, ?, ?, ?)`,
				args: [id, input.actor, input.target_kind, input.target_id, input.mode, now().toISOString()]
			});
			return id;
		},
		async end(id, reason) {
			await client.execute({
				sql: `UPDATE terminal_relay_sessions SET ended_at = ?, end_reason = ?
					WHERE id = ? AND ended_at IS NULL`,
				args: [now().toISOString(), reason, id]
			});
		},
		async list(target_kind, target_id, limit) {
			const result = await client.execute({
				sql: `SELECT id, actor, target_kind, target_id, mode, started_at, ended_at, end_reason
					FROM terminal_relay_sessions WHERE target_kind = ? AND target_id = ?
					ORDER BY started_at DESC, id DESC LIMIT ?`,
				args: [target_kind, target_id, limit]
			});
			return result.rows.map((row) => ({
				id: String(row.id),
				actor: String(row.actor),
				target_kind: String(row.target_kind) as RelayTargetKind,
				target_id: String(row.target_id),
				mode: String(row.mode) as RelayMode,
				started_at: String(row.started_at),
				ended_at: row.ended_at === null ? null : String(row.ended_at),
				end_reason: row.end_reason === null ? null : String(row.end_reason)
			}));
		}
	};
}
