import { createClient } from '@libsql/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { initStateSchema } from '../state/db.js';
import { createSecretBox } from '../secret-box.js';
import { decryptObject, gunzip } from './crypto.js';
import { splitStatements } from './dump.js';
import { S3Error, type S3Client } from './s3.js';
import {
	pruneRuns,
	runBackup,
	runIdFor,
	testBackupDestination,
	type BackupConnection,
	type BackupManifest
} from './service.js';
import { createBackupStore, type BackupStore } from './store.js';

const FAST = 1_000;

class MemoryS3 implements S3Client {
	objects = new Map<string, Uint8Array>();
	fail_put: string | undefined;

	async put(key: string, body: Uint8Array) {
		if (this.fail_put !== undefined && key.endsWith(this.fail_put)) {
			throw new S3Error('upload', 403, 'AccessDenied');
		}
		this.objects.set(key, body);
	}
	async get(key: string) {
		const body = this.objects.get(key);
		if (body === undefined) throw new S3Error('download', 404, 'NoSuchKey');
		return body;
	}
	async list(prefix: string, delimiter?: string) {
		const keys: string[] = [];
		const prefixes = new Set<string>();
		for (const key of [...this.objects.keys()].sort()) {
			if (!key.startsWith(prefix)) continue;
			const rest = key.slice(prefix.length);
			const cut = delimiter === undefined ? -1 : rest.indexOf(delimiter);
			if (cut >= 0) prefixes.add(prefix + rest.slice(0, cut + 1));
			else keys.push(key);
		}
		return { keys, prefixes: [...prefixes] };
	}
	async delete(key: string) {
		this.objects.delete(key);
	}
}

function connection(): BackupConnection {
	return {
		async query(sql, params = []) {
			if (sql.startsWith('SELECT dolt_version')) return [{ v: '1.80.0' }];
			if (sql.startsWith('SHOW FULL TABLES'))
				return [{ Tables_in_x: 'issues', Table_type: 'BASE TABLE' }];
			if (sql.startsWith('SHOW CREATE TABLE')) {
				return [{ 'Create Table': 'CREATE TABLE `issues` (\n  `id` varchar(64) NOT NULL\n)' }];
			}
			if (sql.startsWith('SELECT COLUMN_NAME')) return [{ COLUMN_NAME: 'id', EXTRA: '' }];
			const select = /FROM `(\w+)`\.`issues`$/.exec(sql);
			if (select) return [{ id: `${select[1]}-1` }, { id: `${select[1]}-2` }];
			void params;
			return [];
		},
		async close() {
			return;
		}
	};
}

let store: BackupStore;
let s3: MemoryS3;
let clock: Date;

function deps() {
	return {
		store,
		listDatabases: async () => ['von', 'beads_web', 'Bad-Name'],
		openConnection: async () => connection(),
		s3: () => s3,
		now: () => clock,
		pbkdf2_iterations: FAST
	};
}

beforeEach(async () => {
	const client = createClient({ url: ':memory:' });
	await initStateSchema(client);
	const box = await createSecretBox(new Uint8Array(32).fill(5), 'generated');
	store = createBackupStore(client, async () => box);
	await store.update({
		endpoint: 'https://t3.storageapi.dev',
		bucket: 'b',
		access_key_id: 'AKID',
		secret_access_key: 'secret',
		keep_runs: 2
	});
	s3 = new MemoryS3();
	clock = new Date('2026-10-17T01:02:03.456Z');
});

describe('runIdFor', () => {
	it('is sortable and key-safe', () => {
		expect(runIdFor(new Date('2026-10-17T01:02:03.456Z'))).toBe('2026-10-17T01-02-03Z');
	});
});

describe('runBackup', () => {
	it('uploads one object per valid database and a manifest last', async () => {
		const run = await runBackup('manual', deps());
		expect(run).toMatchObject({
			status: 'succeeded',
			databases: 2,
			location: 'beadsmith/2026-10-17T01-02-03Z'
		});
		const keys = [...s3.objects.keys()];
		expect(keys).toEqual([
			'beadsmith/2026-10-17T01-02-03Z/beads_web.sql.gz',
			'beadsmith/2026-10-17T01-02-03Z/von.sql.gz',
			'beadsmith/2026-10-17T01-02-03Z/manifest.json'
		]);
		const manifest = JSON.parse(
			new TextDecoder().decode(s3.objects.get('beadsmith/2026-10-17T01-02-03Z/manifest.json'))
		) as BackupManifest;
		expect(manifest).toMatchObject({
			format: 'beadsmith-backup/1',
			dolt_version: '1.80.0',
			encryption: null
		});
		expect(manifest.databases[0]).toMatchObject({ name: 'beads_web', tables: { issues: 2 } });
		const sql = new TextDecoder().decode(
			await gunzip(s3.objects.get('beadsmith/2026-10-17T01-02-03Z/von.sql.gz') as Uint8Array)
		);
		expect(splitStatements(sql)).toContain(
			"INSERT INTO `issues` (`id`) VALUES\n  ('von-1'),\n  ('von-2')"
		);
		const [recorded] = await store.listRuns(1);
		expect(recorded).toMatchObject({ status: 'succeeded', databases: 2, trigger: 'manual' });
	});

	it('encrypts objects when a passphrase is set', async () => {
		await store.update({ passphrase: 'a long passphrase here' });
		await runBackup('schedule', deps());
		const key = 'beadsmith/2026-10-17T01-02-03Z/von.sql.gz.enc';
		const sealed = s3.objects.get(key) as Uint8Array;
		const sql = new TextDecoder().decode(
			await gunzip(await decryptObject(sealed, 'a long passphrase here', FAST))
		);
		expect(sql).toContain('von-1');
		const manifest = JSON.parse(
			new TextDecoder().decode(s3.objects.get('beadsmith/2026-10-17T01-02-03Z/manifest.json'))
		) as BackupManifest;
		expect(manifest.encryption).toEqual({
			cipher: 'AES-256-GCM',
			kdf: 'PBKDF2-SHA256',
			iterations: FAST
		});
	});

	it('records a sanitized failure and writes no manifest', async () => {
		s3.fail_put = 'von.sql.gz';
		const run = await runBackup('manual', deps());
		expect(run.status).toBe('failed');
		expect(run.error).toBe('Storage upload failed with HTTP 403 (AccessDenied).');
		expect([...s3.objects.keys()].some((k) => k.endsWith('manifest.json'))).toBe(false);
		const [recorded] = await store.listRuns(1);
		expect(recorded.error).not.toContain('secret');
	});

	it('fails when not configured, without touching storage', async () => {
		await store.update({ secret_access_key: null });
		const run = await runBackup('manual', deps());
		expect(run.status).toBe('failed');
		expect(run.error).toMatch(/not configured/);
		expect(s3.objects.size).toBe(0);
	});

	it('refuses a concurrent run', async () => {
		const first = runBackup('manual', deps());
		await expect(runBackup('manual', deps())).rejects.toThrow(/already running/);
		await first;
	});

	it('prunes complete runs beyond keep-N and leaves foreign objects alone', async () => {
		s3.objects.set('beadsmith/notes.txt', new Uint8Array([1]));
		s3.objects.set('exports/beads-export.tar.gz', new Uint8Array([1]));
		for (const iso of [
			'2026-10-14T00:00:00.000Z',
			'2026-10-15T00:00:00.000Z',
			'2026-10-16T00:00:00.000Z'
		]) {
			clock = new Date(iso);
			await runBackup('schedule', deps());
		}
		const runs = new Set([...s3.objects.keys()].map((k) => k.split('/')[1]));
		expect(runs).toEqual(
			new Set(['notes.txt', '2026-10-15T00-00-00Z', '2026-10-16T00-00-00Z', 'beads-export.tar.gz'])
		);
		const [latest] = await store.listRuns(1);
		expect(latest.pruned).toBe(1);
	});
});

describe('pruneRuns', () => {
	it('keeps everything until enough complete runs exist', async () => {
		s3.objects.set('p/2026-10-14T00-00-00Z/a.sql.gz', new Uint8Array([1]));
		s3.objects.set('p/2026-10-15T00-00-00Z/manifest.json', new Uint8Array([1]));
		expect(await pruneRuns(s3, 'p', 2, '2026-10-15T00-00-00Z')).toBe(0);
		expect(s3.objects.size).toBe(2);
	});

	it('deletes incomplete runs older than the kept window', async () => {
		s3.objects.set('p/2026-10-13T00-00-00Z/a.sql.gz', new Uint8Array([1]));
		s3.objects.set('p/2026-10-14T00-00-00Z/manifest.json', new Uint8Array([1]));
		expect(await pruneRuns(s3, 'p', 1, '2026-10-14T00-00-00Z')).toBe(1);
		expect([...s3.objects.keys()]).toEqual(['p/2026-10-14T00-00-00Z/manifest.json']);
	});
});

describe('testBackupDestination', () => {
	it('writes and removes a probe object', async () => {
		await testBackupDestination({ store, s3: () => s3 });
		expect(s3.objects.size).toBe(0);
	});
});
