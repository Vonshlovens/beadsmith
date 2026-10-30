/**
 * Backup settings and run history in `state.db`. Credentials are stored only
 * sealed by the secret box (ADR-0010) and never returned to callers that build
 * API responses; use `toConfigView` for those.
 */
import type { Client } from '@libsql/client';
import type { SecretBox } from '../secret-box.js';
import type { S3UrlStyle } from './s3.js';

export const BACKUP_CONFIG_KEY = 'backup.config';
export const SECRET_FIELDS = ['access_key_id', 'secret_access_key', 'passphrase'] as const;
export type SecretField = (typeof SECRET_FIELDS)[number];

export interface BackupSettings {
	enabled: boolean;
	endpoint: string;
	bucket: string;
	region: string;
	url_style: S3UrlStyle;
	/** Object key prefix without leading or trailing slash. */
	prefix: string;
	interval_hours: number;
	keep_runs: number;
}

/** Settings plus decrypted secrets, for the backup engine only. */
export interface BackupConfig extends BackupSettings {
	access_key_id?: string;
	secret_access_key?: string;
	passphrase?: string;
}

/** What the API may return. */
export interface BackupConfigView extends BackupSettings {
	configured: boolean;
	access_key_id_set: boolean;
	/** Last four characters of the access key id, to tell keys apart. */
	access_key_id_hint?: string;
	secret_access_key_set: boolean;
	passphrase_set: boolean;
}

/** PUT body: settings fields optional; secrets are string = set, null = clear. */
export type BackupConfigUpdate = Partial<BackupSettings> & {
	[K in SecretField]?: string | null;
};

export type BackupTrigger = 'manual' | 'schedule';
export type BackupRunStatus = 'running' | 'succeeded' | 'failed';

export interface BackupRun {
	id: string;
	trigger: BackupTrigger;
	status: BackupRunStatus;
	started_at: string;
	finished_at?: string;
	databases: number;
	bytes: number;
	/** `<prefix>/<run-id>` in the bucket. */
	location?: string;
	pruned: number;
	error?: string;
}

export const DEFAULT_SETTINGS: BackupSettings = {
	enabled: false,
	endpoint: '',
	bucket: '',
	region: 'auto',
	url_style: 'virtual-host',
	prefix: 'beadsmith',
	interval_hours: 24,
	keep_runs: 30
};

interface StoredConfig extends BackupSettings {
	secrets: Partial<Record<SecretField, string>>;
}

export const BACKUP_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS backup_runs (
	id TEXT PRIMARY KEY,
	trigger TEXT NOT NULL,
	status TEXT NOT NULL,
	started_at TEXT NOT NULL,
	finished_at TEXT,
	databases INTEGER NOT NULL DEFAULT 0,
	bytes INTEGER NOT NULL DEFAULT 0,
	location TEXT,
	pruned INTEGER NOT NULL DEFAULT 0,
	error TEXT
)`;

export interface BackupStore {
	/** Decrypted config for the engine; defaults when never saved. */
	getConfig(): Promise<BackupConfig>;
	/** Safe view for API responses. */
	getView(): Promise<BackupConfigView>;
	update(update: BackupConfigUpdate): Promise<BackupConfigView>;
	startRun(run: Pick<BackupRun, 'id' | 'trigger' | 'started_at'>): Promise<void>;
	finishRun(
		id: string,
		result: Pick<BackupRun, 'status' | 'finished_at' | 'databases' | 'bytes' | 'pruned'> &
			Partial<Pick<BackupRun, 'location' | 'error'>>
	): Promise<void>;
	listRuns(limit: number): Promise<BackupRun[]>;
	/** Finish time of the newest succeeded run. */
	lastSuccessAt(): Promise<string | undefined>;
	/** Start time of the newest run of any status. */
	lastAttemptAt(): Promise<string | undefined>;
	/** Mark rows left `running` by a crashed process as failed. */
	failInterrupted(now: string): Promise<void>;
}

function purpose(field: SecretField): string {
	return `backup.${field}`;
}

export function isConfigured(config: BackupSettings & { [K in SecretField]?: unknown }): boolean {
	return (
		config.endpoint !== '' &&
		config.bucket !== '' &&
		typeof config.access_key_id === 'string' &&
		typeof config.secret_access_key === 'string'
	);
}

function row(value: unknown): Record<string, unknown> {
	return value as Record<string, unknown>;
}

function optText(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function toRun(value: unknown): BackupRun {
	const r = row(value);
	return {
		id: String(r.id),
		trigger: r.trigger === 'schedule' ? 'schedule' : 'manual',
		status: r.status === 'succeeded' || r.status === 'failed' ? r.status : 'running',
		started_at: String(r.started_at),
		finished_at: optText(r.finished_at),
		databases: Number(r.databases ?? 0),
		bytes: Number(r.bytes ?? 0),
		location: optText(r.location),
		pruned: Number(r.pruned ?? 0),
		error: optText(r.error)
	};
}

export function createBackupStore(client: Client, box: () => Promise<SecretBox>): BackupStore {
	async function readStored(): Promise<StoredConfig> {
		const result = await client.execute({
			sql: 'SELECT value FROM settings WHERE key = ?',
			args: [BACKUP_CONFIG_KEY]
		});
		const raw = result.rows[0] === undefined ? undefined : row(result.rows[0]).value;
		if (typeof raw !== 'string') return { ...DEFAULT_SETTINGS, secrets: {} };
		try {
			const parsed = JSON.parse(raw) as Partial<StoredConfig>;
			return { ...DEFAULT_SETTINGS, ...parsed, secrets: { ...(parsed.secrets ?? {}) } };
		} catch {
			return { ...DEFAULT_SETTINGS, secrets: {} };
		}
	}

	async function viewOf(stored: StoredConfig): Promise<BackupConfigView> {
		const { secrets, ...settings } = stored;
		let hint: string | undefined;
		if (secrets.access_key_id !== undefined) {
			try {
				const key = await (await box()).open(secrets.access_key_id, purpose('access_key_id'));
				hint = key.slice(-4);
			} catch {
				hint = undefined;
			}
		}
		const view: BackupConfigView = {
			...settings,
			configured: false,
			access_key_id_set: secrets.access_key_id !== undefined,
			access_key_id_hint: hint,
			secret_access_key_set: secrets.secret_access_key !== undefined,
			passphrase_set: secrets.passphrase !== undefined
		};
		view.configured =
			settings.endpoint !== '' &&
			settings.bucket !== '' &&
			view.access_key_id_set &&
			view.secret_access_key_set;
		return view;
	}

	return {
		async getConfig() {
			const { secrets, ...settings } = await readStored();
			const config: BackupConfig = { ...settings };
			const opened = await box();
			for (const field of SECRET_FIELDS) {
				const sealed = secrets[field];
				if (sealed !== undefined) config[field] = await opened.open(sealed, purpose(field));
			}
			return config;
		},

		async getView() {
			return viewOf(await readStored());
		},

		async update(update) {
			const stored = await readStored();
			const next: StoredConfig = { ...stored, secrets: { ...stored.secrets } };
			for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof BackupSettings>) {
				if (update[key] !== undefined)
					(next as unknown as Record<string, unknown>)[key] = update[key];
			}
			for (const field of SECRET_FIELDS) {
				const value = update[field];
				if (value === null) delete next.secrets[field];
				else if (typeof value === 'string') {
					next.secrets[field] = await (await box()).seal(value, purpose(field));
				}
			}
			await client.execute({
				sql: 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
				args: [BACKUP_CONFIG_KEY, JSON.stringify(next)]
			});
			return viewOf(next);
		},

		async startRun(run) {
			await client.execute({
				sql: "INSERT INTO backup_runs (id, trigger, status, started_at) VALUES (?, ?, 'running', ?)",
				args: [run.id, run.trigger, run.started_at]
			});
		},

		async finishRun(id, result) {
			await client.execute({
				sql: `UPDATE backup_runs SET status = ?, finished_at = ?, databases = ?, bytes = ?,
				      pruned = ?, location = ?, error = ? WHERE id = ?`,
				args: [
					result.status,
					result.finished_at ?? null,
					result.databases,
					result.bytes,
					result.pruned,
					result.location ?? null,
					result.error ?? null,
					id
				]
			});
		},

		async listRuns(limit) {
			const result = await client.execute({
				sql: 'SELECT * FROM backup_runs ORDER BY started_at DESC LIMIT ?',
				args: [limit]
			});
			return result.rows.map(toRun);
		},

		async lastSuccessAt() {
			const result = await client.execute(
				"SELECT MAX(finished_at) AS at FROM backup_runs WHERE status = 'succeeded'"
			);
			return optText(row(result.rows[0] ?? {}).at);
		},

		async lastAttemptAt() {
			const result = await client.execute('SELECT MAX(started_at) AS at FROM backup_runs');
			return optText(row(result.rows[0] ?? {}).at);
		},

		async failInterrupted(now) {
			await client.execute({
				sql: "UPDATE backup_runs SET status = 'failed', finished_at = ?, error = ? WHERE status = 'running'",
				args: [now, 'Interrupted: the server stopped during this run.']
			});
		}
	};
}
