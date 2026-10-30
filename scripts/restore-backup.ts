/**
 * Restore a Beadsmith backup run (ADR-0010) into a Dolt (or MySQL) server.
 *
 *   pnpm run restore --list
 *   pnpm run restore --run latest --dry-run
 *   pnpm run restore --run 2026-10-17T01-02-03Z --database beads_web --suffix _restored
 *
 * Source bucket (same values as the console):
 *   BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_REGION (auto),
 *   BACKUP_S3_URL_STYLE (virtual-host|path), BACKUP_S3_PREFIX (beadsmith),
 *   BACKUP_S3_ACCESS_KEY_ID[_FILE], BACKUP_S3_SECRET_ACCESS_KEY[_FILE],
 *   BACKUP_PASSPHRASE[_FILE] for encrypted runs.
 * Target server (needs CREATE/INSERT rights; not the read-only web user):
 *   RESTORE_DOLT_HOST, RESTORE_DOLT_PORT (3306), RESTORE_DOLT_USER (root),
 *   RESTORE_DOLT_PASSWORD[_FILE].
 *
 * Each database is restored as `<name><suffix>` (default suffix `_restored`)
 * and is never overwritten unless --replace is given.
 */
import { readFileSync } from 'node:fs';
import { createS3Client, sha256Hex, type S3UrlStyle } from '../src/lib/server/backup/s3.ts';
import { decryptObject, gunzip } from '../src/lib/server/backup/crypto.ts';
import { splitStatements } from '../src/lib/server/backup/dump.ts';
import { DB_NAME_PATTERN } from '../src/lib/server/dolt/names.ts';

const RUN_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;

interface Manifest {
	format: string;
	run_id: string;
	encryption: null | { iterations: number };
	databases: Array<{
		name: string;
		object: string;
		sha256: string;
		tables: Record<string, number>;
	}>;
}

function fail(message: string): never {
	console.error(`restore: ${message}`);
	process.exit(1);
}

function secret(name: string, required: boolean): string | undefined {
	const file = process.env[`${name}_FILE`];
	if (file !== undefined && file !== '') {
		try {
			return readFileSync(file, 'utf8').trim();
		} catch {
			fail(`${name}_FILE could not be read`);
		}
	}
	const value = process.env[name];
	if (value !== undefined && value !== '') return value;
	if (required) fail(`${name} or ${name}_FILE is required`);
	return undefined;
}

function env(name: string, fallback?: string): string {
	const value = process.env[name];
	if (value !== undefined && value !== '') return value;
	if (fallback !== undefined) return fallback;
	fail(`${name} is required`);
}

function parseArgs(args: string[]) {
	const out = {
		list: false,
		run: undefined as string | undefined,
		databases: [] as string[],
		suffix: '_restored',
		replace: false,
		dry_run: false
	};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const next = () => args[++i] ?? fail(`${arg} needs a value`);
		if (arg === '--list') out.list = true;
		else if (arg === '--run') out.run = next();
		else if (arg === '--database') out.databases.push(next());
		else if (arg === '--suffix') out.suffix = next();
		else if (arg === '--replace') out.replace = true;
		else if (arg === '--dry-run') out.dry_run = true;
		else if (arg === '--') continue;
		else fail(`unknown argument ${arg}`);
	}
	if (!out.list && out.run === undefined) fail('pass --list or --run <run-id|latest>');
	return out;
}

const args = parseArgs(process.argv.slice(2));
const prefix = env('BACKUP_S3_PREFIX', 'beadsmith').replace(/^\/+|\/+$/g, '');
const root = prefix === '' ? '' : `${prefix}/`;
const s3 = createS3Client({
	endpoint: env('BACKUP_S3_ENDPOINT'),
	bucket: env('BACKUP_S3_BUCKET'),
	region: env('BACKUP_S3_REGION', 'auto'),
	url_style: env('BACKUP_S3_URL_STYLE', 'virtual-host') as S3UrlStyle,
	access_key_id: secret('BACKUP_S3_ACCESS_KEY_ID', true) as string,
	secret_access_key: secret('BACKUP_S3_SECRET_ACCESS_KEY', true) as string
});

async function completeRuns(): Promise<string[]> {
	const listed = await s3.list(root, '/');
	const ids = listed.prefixes
		.map((p) => p.slice(root.length).replace(/\/$/, ''))
		.filter((id) => RUN_ID.test(id))
		.sort()
		.reverse();
	const complete: string[] = [];
	for (const id of ids) {
		const keys = (await s3.list(`${root}${id}/`)).keys;
		if (keys.includes(`${root}${id}/manifest.json`)) complete.push(id);
	}
	return complete;
}

if (args.list) {
	const runs = await completeRuns();
	if (runs.length === 0) console.log('No complete runs found.');
	for (const id of runs) console.log(id);
	process.exit(0);
}

const run_id = args.run === 'latest' ? (await completeRuns())[0] : args.run;
if (run_id === undefined || !RUN_ID.test(run_id)) fail('no matching complete run');
const manifest = JSON.parse(
	new TextDecoder().decode(await s3.get(`${root}${run_id}/manifest.json`))
) as Manifest;
if (manifest.format !== 'beadsmith-backup/1')
	fail(`unsupported manifest format ${manifest.format}`);
const passphrase = manifest.encryption === null ? undefined : secret('BACKUP_PASSPHRASE', true);
const selected = manifest.databases.filter(
	(db) => args.databases.length === 0 || args.databases.includes(db.name)
);
if (selected.length === 0) fail('no databases selected');

const prepared: Array<{
	name: string;
	target: string;
	statements: string[];
	tables: Record<string, number>;
}> = [];
for (const db of selected) {
	const target = `${db.name}${args.suffix}`;
	if (!DB_NAME_PATTERN.test(target)) fail(`invalid target database name ${target}`);
	let body = await s3.get(`${root}${run_id}/${db.object}`);
	if ((await sha256Hex(body)) !== db.sha256) fail(`checksum mismatch for ${db.object}`);
	if (db.object.endsWith('.enc')) {
		body = await decryptObject(body, passphrase as string, manifest.encryption?.iterations);
	}
	const statements = splitStatements(new TextDecoder().decode(await gunzip(body)));
	prepared.push({ name: db.name, target, statements, tables: db.tables });
	const rows = Object.values(db.tables).reduce((a, b) => a + b, 0);
	console.log(`${db.name}: ${statements.length} statements, ${rows} rows -> ${target}`);
}
if (args.dry_run) {
	console.log(
		`Dry run of ${run_id}: checksums verified${passphrase ? ', decrypted' : ''}; nothing written.`
	);
	process.exit(0);
}

const mysql = (await import('mysql2/promise')).default;
const conn = await mysql.createConnection({
	host: env('RESTORE_DOLT_HOST'),
	port: Number(env('RESTORE_DOLT_PORT', '3306')),
	user: env('RESTORE_DOLT_USER', 'root'),
	password: secret('RESTORE_DOLT_PASSWORD', false) ?? '',
	multipleStatements: false
});
try {
	// Dumps escape with backslashes; make sure the session honours them.
	await conn.query("SET SESSION sql_mode = REPLACE(@@sql_mode, 'NO_BACKSLASH_ESCAPES', '')");
	for (const db of prepared) {
		const [existing] = (await conn.query('SHOW DATABASES LIKE ?', [db.target])) as [
			unknown[],
			unknown
		];
		if (existing.length > 0) {
			if (!args.replace) fail(`${db.target} already exists; pass --replace or another --suffix`);
			await conn.query(`DROP DATABASE \`${db.target}\``);
		}
		await conn.query(`CREATE DATABASE \`${db.target}\``);
		await conn.query(`USE \`${db.target}\``);
		for (const statement of db.statements) await conn.query(statement);
		let mismatched = 0;
		for (const [table, expected] of Object.entries(db.tables)) {
			const [rows] = (await conn.query(
				`SELECT COUNT(*) AS n FROM \`${table.replace(/`/g, '``')}\``
			)) as [Array<{ n: number | string }>, unknown];
			const actual = Number(rows[0]?.n ?? -1);
			if (actual !== expected) {
				mismatched += 1;
				console.error(`  ${table}: expected ${expected} rows, found ${actual}`);
			}
		}
		try {
			await conn.query("CALL DOLT_COMMIT('-Am', ?)", [`Restored from Beadsmith backup ${run_id}`]);
		} catch {
			// Not a Dolt server, or nothing to commit.
		}
		if (mismatched > 0) fail(`${db.target}: ${mismatched} table(s) have unexpected row counts`);
		console.log(`${db.target}: restored, row counts match`);
	}
} finally {
	await conn.end();
}
