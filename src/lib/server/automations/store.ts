/**
 * Automations in `state.db` (ADR-0019 rule 7, ADR-0004): a dispatch template
 * with a cron schedule, and the history of the slots it fired, skipped or
 * was refused. Templates hold the same validated payload a launch stores on
 * its mission, never credentials.
 */
import { randomBytes } from 'node:crypto';
import type { Client } from '@libsql/client';
import type {
	AutomationOverlap,
	AutomationRunOutcome,
	AutomationTrigger
} from '#lib/automations.js';
import type { DispatchProviderId } from '#lib/types.js';
import type { DispatchPayload } from '../dispatch/types.js';

export const AUTOMATION_SCHEMA_SQL: string[] = [
	`CREATE TABLE IF NOT EXISTS automations (
		id TEXT PRIMARY KEY,
		project_id TEXT NOT NULL,
		name TEXT NOT NULL,
		cron TEXT NOT NULL,
		time_zone TEXT NOT NULL,
		provider TEXT,
		payload_json TEXT NOT NULL,
		overlap TEXT NOT NULL,
		enabled INTEGER NOT NULL,
		paused_reason TEXT,
		created_by TEXT NOT NULL,
		last_slot TEXT NOT NULL,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS automation_runs (
		automation_id TEXT NOT NULL,
		slot TEXT NOT NULL,
		trigger TEXT NOT NULL,
		outcome TEXT NOT NULL,
		mission_id TEXT,
		message TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		PRIMARY KEY (automation_id, slot)
	)`,
	`CREATE INDEX IF NOT EXISTS automation_runs_pending
		ON automation_runs (outcome, slot) WHERE outcome IN ('firing', 'queued')`
];

export interface Automation {
	id: string;
	project_id: string;
	name: string;
	cron: string;
	time_zone: string;
	/** Launch on this runner; absent means the default one. */
	provider?: DispatchProviderId;
	payload: DispatchPayload;
	overlap: AutomationOverlap;
	enabled: boolean;
	/** Why the scheduler paused it, when it did (the creator lost admin). */
	paused_reason?: string;
	/** Account id of the admin it acts on behalf of. */
	created_by: string;
	/**
	 * The latest slot handled, or the time it was created or last enabled:
	 * only slots after it can fire, so creating or re-enabling one never
	 * fires a slot from before.
	 */
	last_slot: string;
	created_at: string;
	updated_at: string;
}

export interface AutomationRun {
	automation_id: string;
	/** ISO instant of the slot, to the minute. */
	slot: string;
	trigger: AutomationTrigger;
	outcome: AutomationRunOutcome;
	mission_id?: string;
	message?: string;
	created_at: string;
	updated_at: string;
}

export interface CreateAutomationInput {
	project_id: string;
	name: string;
	cron: string;
	time_zone: string;
	provider?: DispatchProviderId;
	payload: DispatchPayload;
	overlap: AutomationOverlap;
	created_by: string;
}

/** What an edit replaces; the project, runner and creator stay. */
export interface UpdateAutomationInput {
	name: string;
	cron: string;
	time_zone: string;
	overlap: AutomationOverlap;
	payload: DispatchPayload;
}

/** Runs kept per automation; an every-minute schedule would grow without bound. */
export const AUTOMATION_RUNS_KEPT = 1000;

export interface AutomationStore {
	create(input: CreateAutomationInput): Promise<Automation>;
	get(id: string): Promise<Automation | undefined>;
	list(filter?: { project_id?: string }): Promise<Automation[]>;
	listEnabled(): Promise<Automation[]>;
	/**
	 * Turn one on or off. Enabling clears the pause reason and moves the
	 * cursor to now, so slots missed while it was off never fire.
	 */
	setEnabled(id: string, enabled: boolean, paused_reason?: string): Promise<Automation | undefined>;
	/**
	 * Replace its name, schedule, overlap and launch, keeping its history.
	 * The cursor moves to now, so an edit never fires a slot from before it
	 * (a schedule moved earlier in the day would otherwise fire at once).
	 */
	update(id: string, input: UpdateAutomationInput): Promise<Automation | undefined>;
	remove(id: string): Promise<boolean>;
	/**
	 * Claim a slot: record it as `firing` and advance the cursor. False when
	 * the slot was already claimed (a double tick, or a restart), which is
	 * the guarantee that a slot fires once.
	 */
	claimSlot(id: string, slot: string, trigger: AutomationTrigger): Promise<boolean>;
	/** Resolve a claimed or queued slot. */
	resolveRun(
		id: string,
		slot: string,
		patch: { outcome: AutomationRunOutcome; mission_id?: string; message?: string }
	): Promise<void>;
	getRun(id: string, slot: string): Promise<AutomationRun | undefined>;
	/** Claimed or queued slots across automations, oldest first. */
	listPending(): Promise<AutomationRun[]>;
	/** One automation's runs, newest first. */
	listRuns(id: string, limit: number): Promise<AutomationRun[]>;
	/** The newest run that launched a mission, other than `except_slot`. */
	latestMissionRun(id: string, except_slot?: string): Promise<AutomationRun | undefined>;
}

function newId(): string {
	return `au_${randomBytes(16).toString('hex')}`;
}

function optText(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function toAutomation(raw: unknown): Automation {
	const row = raw as Record<string, unknown>;
	const provider = optText(row.provider) as DispatchProviderId | undefined;
	const paused_reason = optText(row.paused_reason);
	return {
		id: String(row.id),
		project_id: String(row.project_id),
		name: String(row.name),
		cron: String(row.cron),
		time_zone: String(row.time_zone),
		...(provider === undefined ? {} : { provider }),
		payload: JSON.parse(String(row.payload_json)) as DispatchPayload,
		overlap: row.overlap === 'queue' ? 'queue' : 'skip',
		enabled: Number(row.enabled) !== 0,
		...(paused_reason === undefined ? {} : { paused_reason }),
		created_by: String(row.created_by),
		last_slot: String(row.last_slot),
		created_at: String(row.created_at),
		updated_at: String(row.updated_at)
	};
}

function toRun(raw: unknown): AutomationRun {
	const row = raw as Record<string, unknown>;
	const mission_id = optText(row.mission_id);
	const message = optText(row.message);
	return {
		automation_id: String(row.automation_id),
		slot: String(row.slot),
		trigger: row.trigger === 'manual' ? 'manual' : 'schedule',
		outcome: String(row.outcome) as AutomationRunOutcome,
		...(mission_id === undefined ? {} : { mission_id }),
		...(message === undefined ? {} : { message }),
		created_at: String(row.created_at),
		updated_at: String(row.updated_at)
	};
}

const AUTOMATION_SELECT = `SELECT id, project_id, name, cron, time_zone, provider, payload_json,
	overlap, enabled, paused_reason, created_by, last_slot, created_at, updated_at FROM automations`;
const RUN_SELECT = `SELECT automation_id, slot, trigger, outcome, mission_id, message, created_at,
	updated_at FROM automation_runs`;

export function createAutomationStore(
	client: Client,
	now: () => Date = () => new Date()
): AutomationStore {
	async function get(id: string): Promise<Automation | undefined> {
		const result = await client.execute({ sql: `${AUTOMATION_SELECT} WHERE id = ?`, args: [id] });
		const row = result.rows[0];
		return row === undefined ? undefined : toAutomation(row);
	}

	return {
		async create(input) {
			const id = newId();
			const at = now().toISOString();
			await client.execute({
				sql: `INSERT INTO automations (id, project_id, name, cron, time_zone, provider,
					payload_json, overlap, enabled, created_by, last_slot, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
				args: [
					id,
					input.project_id,
					input.name,
					input.cron,
					input.time_zone,
					input.provider ?? null,
					JSON.stringify(input.payload),
					input.overlap,
					input.created_by,
					at,
					at,
					at
				]
			});
			const created = await get(id);
			if (created === undefined) throw new Error('The automation could not be read back.');
			return created;
		},

		get,

		async list(filter = {}) {
			const result =
				filter.project_id === undefined
					? await client.execute(`${AUTOMATION_SELECT} ORDER BY name, id`)
					: await client.execute({
							sql: `${AUTOMATION_SELECT} WHERE project_id = ? ORDER BY name, id`,
							args: [filter.project_id]
						});
			return result.rows.map(toAutomation);
		},

		async listEnabled() {
			const result = await client.execute(`${AUTOMATION_SELECT} WHERE enabled = 1 ORDER BY id`);
			return result.rows.map(toAutomation);
		},

		async setEnabled(id, enabled, paused_reason) {
			const at = now().toISOString();
			await client.execute(
				enabled
					? {
							sql: `UPDATE automations SET enabled = 1, paused_reason = NULL, last_slot = ?,
								updated_at = ? WHERE id = ? AND enabled = 0`,
							args: [at, at, id]
						}
					: {
							sql: 'UPDATE automations SET enabled = 0, paused_reason = ?, updated_at = ? WHERE id = ?',
							args: [paused_reason ?? null, at, id]
						}
			);
			return get(id);
		},

		async update(id, input) {
			const at = now().toISOString();
			await client.execute({
				sql: `UPDATE automations SET name = ?, cron = ?, time_zone = ?, overlap = ?,
					payload_json = ?, last_slot = MAX(last_slot, ?), updated_at = ? WHERE id = ?`,
				args: [
					input.name,
					input.cron,
					input.time_zone,
					input.overlap,
					JSON.stringify(input.payload),
					at,
					at,
					id
				]
			});
			return get(id);
		},

		async remove(id) {
			const result = await client.batch(
				[
					{ sql: 'DELETE FROM automation_runs WHERE automation_id = ?', args: [id] },
					{ sql: 'DELETE FROM automations WHERE id = ?', args: [id] }
				],
				'write'
			);
			return (result[1]?.rowsAffected ?? 0) > 0;
		},

		async claimSlot(id, slot, trigger) {
			const at = now().toISOString();
			const [inserted] = await client.batch(
				[
					{
						sql: `INSERT OR IGNORE INTO automation_runs
							(automation_id, slot, trigger, outcome, created_at, updated_at)
							VALUES (?, ?, ?, 'firing', ?, ?)`,
						args: [id, slot, trigger, at, at]
					},
					// A manual run's instant is not a schedule slot, so it leaves the
					// cursor alone; MAX keeps the cursor from moving backwards.
					{
						sql: `UPDATE automations SET last_slot = MAX(last_slot, ?), updated_at = ?
							WHERE id = ? AND ? = 'schedule'`,
						args: [slot, at, id, trigger]
					},
					{
						sql: `DELETE FROM automation_runs WHERE automation_id = ? AND slot NOT IN (
							SELECT slot FROM automation_runs WHERE automation_id = ?
							ORDER BY slot DESC LIMIT ?)`,
						args: [id, id, AUTOMATION_RUNS_KEPT]
					}
				],
				'write'
			);
			return (inserted?.rowsAffected ?? 0) > 0;
		},

		async resolveRun(id, slot, patch) {
			await client.execute({
				sql: `UPDATE automation_runs SET outcome = ?, mission_id = ?, message = ?, updated_at = ?
					WHERE automation_id = ? AND slot = ?`,
				args: [
					patch.outcome,
					patch.mission_id ?? null,
					patch.message ?? null,
					now().toISOString(),
					id,
					slot
				]
			});
		},

		async getRun(id, slot) {
			const result = await client.execute({
				sql: `${RUN_SELECT} WHERE automation_id = ? AND slot = ?`,
				args: [id, slot]
			});
			const row = result.rows[0];
			return row === undefined ? undefined : toRun(row);
		},

		async listPending() {
			const result = await client.execute(
				`${RUN_SELECT} WHERE outcome IN ('firing', 'queued') ORDER BY slot, automation_id`
			);
			return result.rows.map(toRun);
		},

		async listRuns(id, limit) {
			const result = await client.execute({
				sql: `${RUN_SELECT} WHERE automation_id = ? ORDER BY slot DESC LIMIT ?`,
				args: [id, limit]
			});
			return result.rows.map(toRun);
		},

		async latestMissionRun(id, except_slot) {
			const result = await client.execute({
				sql: `${RUN_SELECT} WHERE automation_id = ? AND mission_id IS NOT NULL AND slot != ?
					ORDER BY slot DESC LIMIT 1`,
				args: [id, except_slot ?? '']
			});
			const row = result.rows[0];
			return row === undefined ? undefined : toRun(row);
		}
	};
}
