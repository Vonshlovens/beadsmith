import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { getEnv } from '../env.js';
import { createDispatchPolicyStore, type DispatchPolicyStore } from '../dispatch/policy.js';
import {
	createDispatchStore,
	DISPATCH_TURNS_SCHEMA_SQL,
	type DispatchStore
} from '../dispatch/store.js';
import { createFileMapStore, type FileMapStore } from '../dispatch/file-maps.js';
import { createTackleMapStore, type TackleMapStore } from '../dispatch/tackle-maps.js';
import { BACKUP_SCHEMA_SQL, createBackupStore, type BackupStore } from '../backup/store.js';
import { AUTH_SCHEMA_SQL } from '../auth/store.js';
import { createTodoStore, TODO_SCHEMA_SQL, type TodoStore } from '../todos/store.js';
import { getSecretBox } from '../secret-box.js';

/**
 * Service-local UI, dispatch, backup, and account state. It stores
 * preferences, File/Tackle request records, backup settings and runs, and
 * Beadsmith accounts. The only credentials are backup keys sealed by the
 * secret box (ADR-0010) and one-way account password hashes (ADR-0011); never
 * Dolt passwords, workspaces, discovery roots, or Beads issue data.
 *
 * Existing installations may retain old unused tables; this code deliberately
 * does not drop user state as part of the remote-only migration.
 */
export const STATE_SCHEMA_SQL: string[] = [
	`CREATE TABLE IF NOT EXISTS settings (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS dispatch_requests (
		id TEXT PRIMARY KEY,
		idempotency_key TEXT NOT NULL UNIQUE,
		project_id TEXT NOT NULL,
		dolt_database TEXT NOT NULL,
		operation TEXT NOT NULL,
		actor TEXT NOT NULL,
		payload_json TEXT NOT NULL,
		status TEXT NOT NULL,
		agent_id TEXT,
		agent_url TEXT,
		run_id TEXT,
		error_message TEXT,
		result_summary TEXT,
		duration_ms INTEGER,
		git_pr_url TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS tackle_repository_maps (
		project_id TEXT PRIMARY KEY,
		url TEXT NOT NULL,
		ref TEXT NOT NULL,
		auto_create_pr INTEGER NOT NULL,
		updated_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS file_checkout_maps (
		project_id TEXT PRIMARY KEY,
		url TEXT NOT NULL,
		ref TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS dispatch_project_allows (
		project_id TEXT PRIMARY KEY,
		file_allowed INTEGER NOT NULL,
		tackle_allowed INTEGER NOT NULL,
		updated_at TEXT NOT NULL
	)`,
	BACKUP_SCHEMA_SQL,
	...TODO_SCHEMA_SQL,
	...AUTH_SCHEMA_SQL
];

const DISPATCH_COLUMN_MIGRATIONS = [
	{ name: 'result_summary', sql: 'ALTER TABLE dispatch_requests ADD COLUMN result_summary TEXT' },
	{ name: 'duration_ms', sql: 'ALTER TABLE dispatch_requests ADD COLUMN duration_ms INTEGER' },
	{ name: 'git_pr_url', sql: 'ALTER TABLE dispatch_requests ADD COLUMN git_pr_url TEXT' },
	{ name: 'provider', sql: 'ALTER TABLE dispatch_requests ADD COLUMN provider TEXT' }
] as const;

export interface StateStore {
	getSetting(key: string): Promise<string | undefined>;
	setSetting(key: string, value: string): Promise<void>;
}

/** Create every required table if missing. */
export async function initStateSchema(client: Client): Promise<void> {
	// Account rows cascade to their sessions and sign-in methods.
	await client.execute('PRAGMA foreign_keys = ON');
	for (const statement of STATE_SCHEMA_SQL) {
		await client.execute(statement);
	}
	const columns = await client.execute('PRAGMA table_info(dispatch_requests)');
	const existing = new Set(
		columns.rows.map((row) => {
			return String((row as Record<string, unknown>).name);
		})
	);
	for (const migration of DISPATCH_COLUMN_MIGRATIONS) {
		if (!existing.has(migration.name)) {
			await client.execute(migration.sql);
		}
	}
	for (const statement of DISPATCH_TURNS_SCHEMA_SQL) {
		await client.execute(statement);
	}
}

/** Read a row value as a non-empty string. */
function asText(value: unknown): string | undefined {
	if (typeof value === 'string' && value.length > 0) {
		return value;
	}
	return undefined;
}

/** Build a preference store over an already-initialised libsql client. */
export function createStateStore(client: Client): StateStore {
	return {
		async getSetting(key: string): Promise<string | undefined> {
			const result = await client.execute({
				sql: 'SELECT value FROM settings WHERE key = ?',
				args: [key]
			});
			const row = result.rows[0];
			return row === undefined ? undefined : asText((row as Record<string, unknown>).value);
		},

		async setSetting(key: string, value: string): Promise<void> {
			await client.execute({
				sql: 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
				args: [key, value]
			});
		}
	};
}

/** Absolute path of the local preference database. */
export function stateDbPath(): string {
	return join(getEnv().state_dir, 'state.db');
}

let client_promise: Promise<Client> | undefined;
let store_promise: Promise<StateStore> | undefined;
let dispatch_promise: Promise<DispatchStore> | undefined;
let maps_promise: Promise<TackleMapStore> | undefined;
let file_maps_promise: Promise<FileMapStore> | undefined;
let policy_promise: Promise<DispatchPolicyStore> | undefined;
let backup_promise: Promise<BackupStore> | undefined;
let todo_promise: Promise<TodoStore> | undefined;
let state_ok = false;

async function openStateClient(): Promise<Client> {
	if (client_promise === undefined) {
		client_promise = (async () => {
			const dir = getEnv().state_dir;
			mkdirSync(dir, { recursive: true });
			const client = createClient({ url: `file:${join(dir, 'state.db')}` });
			await initStateSchema(client);
			state_ok = true;
			return client;
		})().catch((error: unknown) => {
			state_ok = false;
			client_promise = undefined;
			store_promise = undefined;
			dispatch_promise = undefined;
			maps_promise = undefined;
			file_maps_promise = undefined;
			policy_promise = undefined;
			backup_promise = undefined;
			todo_promise = undefined;
			throw error;
		});
	}
	return client_promise;
}

/** Open (once) the raw state client, for Better Auth's adapter (ADR-0011). */
export async function getStateClient(): Promise<Client> {
	return openStateClient();
}

/** Open (once) the on-disk preference database. */
export async function getStateStore(): Promise<StateStore> {
	if (store_promise === undefined) {
		store_promise = openStateClient().then(createStateStore);
	}
	return store_promise;
}

/** Open (once) the File/Tackle dispatch store on the same database. */
export async function getDispatchStore(): Promise<DispatchStore> {
	if (dispatch_promise === undefined) {
		dispatch_promise = openStateClient().then(createDispatchStore);
	}
	return dispatch_promise;
}

/** Open (once) the console-edited Tackle map store on the same database. */
export async function getTackleMapStore(): Promise<TackleMapStore> {
	if (maps_promise === undefined) {
		maps_promise = openStateClient().then(createTackleMapStore);
	}
	return maps_promise;
}

/** Open (once) the console-edited File checkout store on the same database. */
export async function getFileMapStore(): Promise<FileMapStore> {
	if (file_maps_promise === undefined) {
		file_maps_promise = openStateClient().then(createFileMapStore);
	}
	return file_maps_promise;
}

/** Open (once) the File/Tackle arm and allow store on the same database. */
export async function getDispatchPolicyStore(): Promise<DispatchPolicyStore> {
	if (policy_promise === undefined) {
		policy_promise = openStateClient().then(createDispatchPolicyStore);
	}
	return policy_promise;
}

/** Open (once) the backup settings and run store on the same database. */
export async function getBackupStore(): Promise<BackupStore> {
	if (backup_promise === undefined) {
		backup_promise = openStateClient().then((client) => createBackupStore(client, getSecretBox));
	}
	return backup_promise;
}

/** Open (once) the admin todo store on the same database. */
export async function getTodoStore(): Promise<TodoStore> {
	if (todo_promise === undefined) {
		todo_promise = openStateClient().then((client) => createTodoStore(client));
	}
	return todo_promise;
}

/** Whether the preference database opened successfully at least once. */
export function stateDbHealthy(): boolean {
	return state_ok;
}

/** Replace the cached store (tests only). */
export function setStateStore(store: StateStore | undefined): void {
	store_promise = store === undefined ? undefined : Promise.resolve(store);
	if (store === undefined) {
		client_promise = undefined;
		dispatch_promise = undefined;
		maps_promise = undefined;
		file_maps_promise = undefined;
		policy_promise = undefined;
		backup_promise = undefined;
		todo_promise = undefined;
		state_ok = false;
	} else {
		state_ok = true;
	}
}

/** Replace the cached dispatch store (tests only). */
export function setDispatchStore(store: DispatchStore | undefined): void {
	dispatch_promise = store === undefined ? undefined : Promise.resolve(store);
}

/** Replace the cached Tackle map store (tests only). */
export function setTackleMapStore(store: TackleMapStore | undefined): void {
	maps_promise = store === undefined ? undefined : Promise.resolve(store);
}

/** Replace the cached File checkout store (tests only). */
export function setFileMapStore(store: FileMapStore | undefined): void {
	file_maps_promise = store === undefined ? undefined : Promise.resolve(store);
}

/** Replace the cached dispatch-policy store (tests only). */
export function setDispatchPolicyStore(store: DispatchPolicyStore | undefined): void {
	policy_promise = store === undefined ? undefined : Promise.resolve(store);
}

/** Replace the cached backup store (tests only). */
export function setBackupStore(store: BackupStore | undefined): void {
	backup_promise = store === undefined ? undefined : Promise.resolve(store);
}

/** Replace the cached todo store (tests only). */
export function setTodoStore(store: TodoStore | undefined): void {
	todo_promise = store === undefined ? undefined : Promise.resolve(store);
}
