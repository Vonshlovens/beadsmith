/**
 * Production wiring for backups: a dedicated read-only Dolt connection, the
 * state store, and an in-process scheduler (ADR-0010).
 */
import { resolveDoltPassword } from '../dolt-password.js';
import { getDoltClient, toDoltConnectionError, DoltError, type SqlRow } from '../dolt/client.js';
import { getEnv } from '../env.js';
import { getBackupStore } from '../state/db.js';
import { isBackupRunning, runBackup, type BackupConnection, type BackupDeps } from './service.js';
import { isConfigured } from './store.js';

/** Minimum gap after any attempt before the scheduler retries. */
const RETRY_AFTER_MS = 15 * 60 * 1000;
const TICK_MS = 60 * 1000;

/**
 * One connection that returns dates, JSON, and big numbers as strings, so the
 * dump reproduces stored values byte for byte.
 */
export async function openBackupConnection(): Promise<BackupConnection> {
	const env = getEnv();
	if (env.dolt_host === undefined) throw new DoltError('Dolt server is not configured');
	const mysql = await import('mysql2/promise');
	try {
		const connection = await mysql.createConnection({
			host: env.dolt_host,
			port: env.dolt_port,
			user: env.dolt_user,
			password: await resolveDoltPassword(),
			connectTimeout: 5000,
			multipleStatements: false,
			dateStrings: true,
			jsonStrings: true,
			supportBigNumbers: true,
			bigNumberStrings: true,
			timezone: 'Z'
		});
		return {
			async query(sql: string, params: unknown[] = []): Promise<SqlRow[]> {
				try {
					const [rows] = await connection.query(sql, params);
					return Array.isArray(rows) ? (rows as SqlRow[]) : [];
				} catch (error) {
					throw toDoltConnectionError(error);
				}
			},
			async close() {
				await connection.end();
			}
		};
	} catch (error) {
		throw error instanceof DoltError ? error : toDoltConnectionError(error);
	}
}

export async function backupDeps(): Promise<BackupDeps> {
	return {
		store: await getBackupStore(),
		listDatabases: () => getDoltClient().listDatabases(),
		openConnection: openBackupConnection
	};
}

/**
 * Whether a scheduled run is due.
 * @param last_success Finish time of the last successful run.
 * @param last_attempt Start time of the last run of any status.
 */
export function isBackupDue(
	now: Date,
	interval_hours: number,
	last_success: string | undefined,
	last_attempt: string | undefined
): boolean {
	if (last_attempt !== undefined && now.getTime() - Date.parse(last_attempt) < RETRY_AFTER_MS) {
		return false;
	}
	if (last_success === undefined) return true;
	return now.getTime() - Date.parse(last_success) >= interval_hours * 3600 * 1000;
}

/** Run once if enabled, configured, idle, and due. Never throws. */
export async function backupTick(now = new Date()): Promise<void> {
	try {
		if (isBackupRunning()) return;
		const deps = await backupDeps();
		const config = await deps.store.getView();
		if (!config.enabled || !config.configured) return;
		const due = isBackupDue(
			now,
			config.interval_hours,
			await deps.store.lastSuccessAt(),
			await deps.store.lastAttemptAt()
		);
		if (due) await runBackup('schedule', deps);
	} catch {
		// Failures are recorded on the run; a broken store must not crash the server.
	}
}

let started = false;

/** Start the once-a-minute scheduler. Idempotent. */
export function startBackupScheduler(): void {
	if (started) return;
	started = true;
	void (async () => {
		try {
			await (await getBackupStore()).failInterrupted(new Date().toISOString());
		} catch {
			// State may be unavailable at boot; the tick retries.
		}
	})();
	const timer = setInterval(() => void backupTick(), TICK_MS);
	// Do not keep the process alive just for backups.
	(timer as unknown as { unref?: () => void }).unref?.();
}
