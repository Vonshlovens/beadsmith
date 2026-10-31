import { createClient, type Client } from '@libsql/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { initStateSchema } from '../state/db.js';
import { createSecretBox, type SecretBox } from '../secret-box.js';
import { createBackupStore, DEFAULT_SETTINGS, type BackupStore } from './store.js';

let client: Client;
let box: SecretBox;
let store: BackupStore;

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	await initStateSchema(client);
	box = await createSecretBox(new Uint8Array(32).fill(3), 'generated');
	store = createBackupStore(client, async () => box);
});

describe('backup config', () => {
	it('returns defaults before anything is saved', async () => {
		expect(await store.getConfig()).toEqual(DEFAULT_SETTINGS);
		const view = await store.getView();
		expect(view.configured).toBe(false);
		expect(view.access_key_id_set).toBe(false);
	});

	it('seals secrets at rest and exposes only set flags and a hint', async () => {
		const view = await store.update({
			enabled: true,
			endpoint: 'https://t3.storageapi.dev',
			bucket: 'beads-backups-abc',
			access_key_id: 'AKID1234WXYZ',
			secret_access_key: 'very-secret',
			passphrase: 'long enough passphrase'
		});
		expect(view).toMatchObject({
			configured: true,
			access_key_id_set: true,
			access_key_id_hint: 'WXYZ',
			secret_access_key_set: true,
			passphrase_set: true
		});
		expect(JSON.stringify(view)).not.toContain('very-secret');
		expect(JSON.stringify(view)).not.toContain('AKID1234');

		const raw = await client.execute("SELECT value FROM settings WHERE key = 'backup.config'");
		const text = String((raw.rows[0] as Record<string, unknown>).value);
		expect(text).not.toContain('very-secret');
		expect(text).not.toContain('AKID1234WXYZ');
		expect(text).not.toContain('long enough passphrase');

		expect(await store.getConfig()).toMatchObject({
			access_key_id: 'AKID1234WXYZ',
			secret_access_key: 'very-secret',
			passphrase: 'long enough passphrase'
		});
	});

	it('keeps absent secrets, clears null ones, and merges settings', async () => {
		await store.update({ access_key_id: 'a', secret_access_key: 'b', passphrase: 'c' });
		await store.update({ passphrase: null, keep_runs: 7 });
		const config = await store.getConfig();
		expect(config.access_key_id).toBe('a');
		expect(config.passphrase).toBeUndefined();
		expect(config.keep_runs).toBe(7);
		expect(config.interval_hours).toBe(DEFAULT_SETTINGS.interval_hours);
	});

	it('fails loudly when the master key changed', async () => {
		await store.update({ access_key_id: 'a' });
		const other = createBackupStore(client, async () =>
			createSecretBox(new Uint8Array(32).fill(9), 'generated')
		);
		await expect(other.getConfig()).rejects.toThrow(/master key/);
		expect((await other.getView()).access_key_id_hint).toBeUndefined();
	});
});

describe('backup runs', () => {
	it('records runs and reports the last success and attempt', async () => {
		await store.startRun({ id: 'r1', trigger: 'manual', started_at: '2026-10-17T01:00:00.000Z' });
		await store.finishRun('r1', {
			status: 'succeeded',
			finished_at: '2026-10-17T01:01:00.000Z',
			databases: 8,
			bytes: 1234,
			pruned: 0,
			location: 'beadsmith/2026-10-17T01-00-00Z'
		});
		await store.startRun({ id: 'r2', trigger: 'schedule', started_at: '2026-10-18T01:00:00.000Z' });
		await store.finishRun('r2', {
			status: 'failed',
			finished_at: '2026-10-18T01:00:05.000Z',
			databases: 0,
			bytes: 0,
			pruned: 0,
			error: 'Storage upload failed with HTTP 403.'
		});
		expect(await store.lastSuccessAt()).toBe('2026-10-17T01:01:00.000Z');
		expect(await store.lastAttemptAt()).toBe('2026-10-18T01:00:00.000Z');
		const runs = await store.listRuns(10);
		expect(runs.map((r) => r.id)).toEqual(['r2', 'r1']);
		expect(runs[1]).toMatchObject({
			databases: 8,
			bytes: 1234,
			location: 'beadsmith/2026-10-17T01-00-00Z'
		});
	});

	it('marks interrupted runs failed', async () => {
		await store.startRun({ id: 'r1', trigger: 'schedule', started_at: '2026-10-17T01:00:00.000Z' });
		await store.failInterrupted('2026-10-17T02:00:00.000Z');
		const [run] = await store.listRuns(1);
		expect(run.status).toBe('failed');
		expect(run.error).toMatch(/Interrupted/);
	});
});
