/**
 * Backup runs (ADR-0010): dump every project database, gzip, optionally
 * encrypt, upload to the configured bucket, write `manifest.json` last (its
 * presence marks a complete run), then prune runs beyond keep-N.
 */
import { DoltError } from '../dolt/client.js';
import { DB_NAME_PATTERN } from '../dolt/names.js';
import { encryptObject, gzip, PBKDF2_ITERATIONS } from './crypto.js';
import { dumpDatabase, DUMP_FORMAT, type DumpConnection } from './dump.js';
import { createS3Client, S3Error, sha256Hex, type S3Client, type S3Config } from './s3.js';
import {
	isConfigured,
	type BackupConfig,
	type BackupRun,
	type BackupStore,
	type BackupTrigger
} from './store.js';

export const MANIFEST_FORMAT = 'beadsmith-backup/1';
/** `2026-10-17T01-02-03Z`: sortable and safe in object keys. */
export const RUN_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;

export interface BackupManifest {
	format: typeof MANIFEST_FORMAT;
	dump_format: typeof DUMP_FORMAT;
	run_id: string;
	started_at: string;
	finished_at: string;
	generator: string;
	dolt_version?: string;
	encryption: null | { cipher: 'AES-256-GCM'; kdf: 'PBKDF2-SHA256'; iterations: number };
	databases: Array<{
		name: string;
		object: string;
		bytes: number;
		sha256: string;
		tables: Record<string, number>;
		head?: string;
	}>;
}

export interface BackupConnection extends DumpConnection {
	close(): Promise<void>;
}

export interface BackupDeps {
	store: BackupStore;
	listDatabases(): Promise<string[]>;
	openConnection(): Promise<BackupConnection>;
	s3?: (config: S3Config) => S3Client;
	now?: () => Date;
	/** Override for tests only. */
	pbkdf2_iterations?: number;
}

export class BackupConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BackupConfigError';
	}
}

let running = false;

/** Whether a run is in progress in this process. */
export function isBackupRunning(): boolean {
	return running;
}

export function runIdFor(date: Date): string {
	return date
		.toISOString()
		.replace(/\.\d{3}Z$/, 'Z')
		.replace(/:/g, '-');
}

function joinKey(...parts: string[]): string {
	return parts.filter((part) => part !== '').join('/');
}

function s3ConfigOf(config: BackupConfig): S3Config {
	if (!isConfigured(config)) {
		throw new BackupConfigError(
			'Backups are not configured: endpoint, bucket, and both keys are required.'
		);
	}
	return {
		endpoint: config.endpoint,
		bucket: config.bucket,
		region: config.region,
		url_style: config.url_style,
		access_key_id: config.access_key_id as string,
		secret_access_key: config.secret_access_key as string
	};
}

/** A sanitized, credential-free message for run history and API errors. */
export function publicBackupError(error: unknown): string {
	if (
		error instanceof S3Error ||
		error instanceof BackupConfigError ||
		error instanceof DoltError
	) {
		return error.message;
	}
	if (error instanceof Error && error.name === 'SecretBoxError') return error.message;
	return 'The backup failed unexpectedly.';
}

/**
 * Write and delete a probe object to prove the settings work.
 * @throws S3Error or BackupConfigError with a public message.
 */
export async function testBackupDestination(deps: Pick<BackupDeps, 'store' | 's3'>): Promise<void> {
	const config = await deps.store.getConfig();
	const client = (deps.s3 ?? createS3Client)(s3ConfigOf(config));
	const key = joinKey(config.prefix, '.beadsmith-write-test');
	await client.put(key, new TextEncoder().encode('ok'), 'text/plain');
	await client.delete(key);
}

/**
 * Delete runs older than the newest `keep` complete runs. Only prefixes that
 * look like run ids are touched.
 * @returns Number of runs deleted.
 */
export async function pruneRuns(
	client: S3Client,
	prefix: string,
	keep: number,
	current: string
): Promise<number> {
	const root = prefix === '' ? '' : `${prefix}/`;
	const listed = await client.list(root, '/');
	const runs = listed.prefixes
		.map((p) => p.slice(root.length).replace(/\/$/, ''))
		.filter((id) => RUN_ID_PATTERN.test(id))
		.sort()
		.reverse();
	const complete: string[] = [];
	for (const id of runs) {
		if (complete.length >= keep) break;
		const keys = (await client.list(`${root}${id}/`)).keys;
		if (keys.includes(`${root}${id}/manifest.json`)) complete.push(id);
	}
	if (complete.length < keep) return 0;
	const oldest_kept = complete[complete.length - 1];
	let deleted = 0;
	for (const id of runs) {
		if (id >= oldest_kept || id === current) continue;
		for (const key of (await client.list(`${root}${id}/`)).keys) await client.delete(key);
		deleted += 1;
	}
	return deleted;
}

/**
 * Run one backup now. Concurrent calls in the same process are refused.
 * @returns The finished run record (succeeded or failed).
 */
export async function runBackup(trigger: BackupTrigger, deps: BackupDeps): Promise<BackupRun> {
	if (running) throw new BackupConfigError('A backup is already running.');
	running = true;
	const now = deps.now ?? (() => new Date());
	const started = now();
	const run_id = runIdFor(started);
	const run: BackupRun = {
		id: run_id,
		trigger,
		status: 'running',
		started_at: started.toISOString(),
		databases: 0,
		bytes: 0,
		pruned: 0
	};
	let recorded = false;
	try {
		await deps.store.startRun(run);
		recorded = true;
		const config = await deps.store.getConfig();
		const client = (deps.s3 ?? createS3Client)(s3ConfigOf(config));
		const location = joinKey(config.prefix, run_id);
		const databases = (await deps.listDatabases())
			.filter((name) => DB_NAME_PATTERN.test(name))
			.sort();
		const iterations = deps.pbkdf2_iterations ?? PBKDF2_ITERATIONS;
		const entries: BackupManifest['databases'] = [];
		let dolt_version: string | undefined;

		const conn = await deps.openConnection();
		try {
			try {
				const [row] = await conn.query('SELECT dolt_version() AS v');
				dolt_version = typeof row?.v === 'string' ? row.v : undefined;
			} catch {
				dolt_version = undefined;
			}
			for (const name of databases) {
				const dump = await dumpDatabase(conn, name);
				let body = await gzip(new TextEncoder().encode(dump.sql));
				let object = `${name}.sql.gz`;
				if (config.passphrase !== undefined) {
					body = await encryptObject(body, config.passphrase, iterations);
					object += '.enc';
				}
				await client.put(joinKey(location, object), body);
				entries.push({
					name,
					object,
					bytes: body.length,
					sha256: await sha256Hex(body),
					tables: dump.tables,
					head: dump.head
				});
				run.databases += 1;
				run.bytes += body.length;
			}
		} finally {
			await conn.close().catch(() => undefined);
		}

		const manifest: BackupManifest = {
			format: MANIFEST_FORMAT,
			dump_format: DUMP_FORMAT,
			run_id,
			started_at: run.started_at,
			finished_at: now().toISOString(),
			generator: 'Beadsmith',
			dolt_version,
			encryption:
				config.passphrase === undefined
					? null
					: { cipher: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', iterations },
			databases: entries
		};
		const manifest_bytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
		await client.put(joinKey(location, 'manifest.json'), manifest_bytes, 'application/json');
		run.bytes += manifest_bytes.length;
		run.location = location;
		run.pruned = await pruneRuns(client, config.prefix, config.keep_runs, run_id);
		run.status = 'succeeded';
	} catch (error) {
		run.status = 'failed';
		run.error = publicBackupError(error);
	} finally {
		run.finished_at = now().toISOString();
		if (recorded) {
			await deps.store
				.finishRun(run.id, {
					status: run.status,
					finished_at: run.finished_at,
					databases: run.databases,
					bytes: run.bytes,
					pruned: run.pruned,
					location: run.location,
					error: run.error
				})
				.catch(() => undefined);
		}
		running = false;
	}
	return run;
}
