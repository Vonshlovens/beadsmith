/**
 * Regenerate the quickstart sample databases.
 *
 *   pnpm run quickstart:sample /path/to/bd
 *
 * Needs Docker and a bd release Beadsmith tests (TESTED_BD_MINORS; prefer the
 * newest). Starts a throwaway Dolt container, creates every project in
 * quickstart/sample/projects.ts with `bd init` and `bd import`, rewrites the
 * events table from each issue's timeline, and writes one
 * quickstart/initdb/20-<database>.sql per project.
 *
 * Times are written relative to a fixed anchor; each SQL file moves them so
 * the anchor becomes the moment Dolt loads it.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dumpDatabase, quoteIdent, sqlLiteral } from '../src/lib/server/backup/dump.ts';
import { TESTED_BD_MINORS } from '../src/lib/server/dolt/schema.ts';
import {
	SAMPLE_PROJECTS,
	type SampleIssue,
	type SampleProject
} from '../quickstart/sample/projects.ts';

const DOLT_IMAGE = 'dolthub/dolt-sql-server:2.5.0';
const OUT_DIR = new URL('../quickstart/initdb/', import.meta.url);
const DAY_MS = 24 * 60 * 60 * 1000;

function fail(message: string): never {
	console.error(`quickstart:sample: ${message}`);
	process.exit(1);
}

async function run(
	cmd: string,
	args: string[],
	options: { cwd?: string; env?: Record<string, string> } = {}
): Promise<string> {
	const out = spawnSync(cmd, args, {
		cwd: options.cwd,
		env: { ...process.env, ...options.env },
		encoding: 'utf8'
	});
	if (out.status !== 0) {
		fail(`${cmd} ${args[0] ?? ''} failed:\n${out.stderr ?? out.error}${out.stdout ?? ''}`);
	}
	return out.stdout;
}

const bd = process.argv[2] ?? fail('usage: pnpm run quickstart:sample /path/to/bd');
const bd_version = (await run(bd, ['version'])).match(/bd version (\d+\.\d+\.\d+)/)?.[1];
if (bd_version === undefined) fail('could not read the bd version');
const minor = bd_version.split('.').slice(0, 2).join('.');
if (!(TESTED_BD_MINORS as readonly string[]).includes(minor)) {
	fail(`bd ${bd_version} is not a tested release (${TESTED_BD_MINORS.join(', ')})`);
}

// Whole minutes keep the generated files stable to read.
const anchor = Math.floor(Date.now() / 60_000) * 60_000;
const at = (days: number): string => new Date(anchor + Math.round(days * DAY_MS)).toISOString();
/** Dolt DATETIME literal (naive UTC). */
const sqlTime = (days: number): string => at(days).replace('T', ' ').replace('Z', '');

async function eventId(...parts: string[]): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('|')))
	);
	const hex = Array.from(digest.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function lastTouched(issue: SampleIssue): number {
	return Math.max(
		issue.created,
		issue.started ?? -Infinity,
		issue.closed ?? -Infinity,
		...(issue.comments ?? []).map((c) => c.at)
	);
}

/** One `bd export`-shaped JSONL line. */
function toJsonl(project: SampleProject, issue: SampleIssue): string {
	const id = (local: string) => `${project.prefix}-${local}`;
	const dependencies = [
		...(issue.parent === undefined
			? []
			: [
					{
						issue_id: id(issue.id),
						depends_on_id: id(issue.parent),
						type: 'parent-child',
						created_at: at(issue.created)
					}
				]),
		...(issue.blocked_by ?? []).map((blocker) => ({
			issue_id: id(issue.id),
			depends_on_id: id(blocker),
			type: 'blocks',
			created_at: at(issue.created + 1 / 1440)
		}))
	];
	return JSON.stringify({
		id: id(issue.id),
		title: issue.title,
		description: issue.description,
		design: issue.design,
		acceptance_criteria: issue.acceptance,
		notes: issue.notes,
		issue_type: issue.type,
		priority: issue.priority,
		status: issue.status,
		assignee: issue.assignee,
		owner: issue.by,
		created_by: issue.by,
		created_at: at(issue.created),
		updated_at: at(lastTouched(issue)),
		started_at: issue.started === undefined ? undefined : at(issue.started),
		closed_at: issue.closed === undefined ? undefined : at(issue.closed),
		close_reason: issue.close_reason,
		labels: issue.labels,
		dependencies,
		comments: (issue.comments ?? []).map((c) => ({
			author: c.by,
			text: c.text,
			created_at: at(c.at)
		})),
		due_at: issue.due === undefined ? undefined : at(issue.due),
		defer_until: issue.defer === undefined ? undefined : at(issue.defer),
		estimated_minutes: issue.estimate_minutes
	});
}

/** The events bd would have recorded had people done this work over time. */
async function timeline(project: SampleProject, issue: SampleIssue): Promise<string[]> {
	const id = `${project.prefix}-${issue.id}`;
	const rows: string[] = [];
	const add = async (
		type: string,
		actor: string,
		days: number,
		old_value: string | null,
		new_value: string | null,
		comment: string | null
	) => {
		const values = [
			id,
			type,
			actor,
			old_value,
			new_value,
			comment,
			sqlTime(days),
			await eventId(id, type, actor, String(days), String(rows.length))
		];
		rows.push(`(${values.map(sqlLiteral).join(', ')})`);
	};
	await add('created', issue.by, issue.created, '', '', null);
	for (const label of issue.labels ?? []) {
		await add(
			'label_added',
			issue.by,
			issue.created + 1 / 1440,
			null,
			null,
			`Added label: ${label}`
		);
	}
	if (issue.assignee !== undefined && issue.started !== undefined) {
		await add(
			'claimed',
			issue.assignee,
			issue.started,
			JSON.stringify({ id, title: issue.title }),
			JSON.stringify({ assignee: issue.assignee, status: 'in_progress' }),
			null
		);
	}
	for (const c of issue.comments ?? []) await add('commented', c.by, c.at, null, null, c.text);
	if (issue.closed !== undefined) {
		await add(
			'closed',
			issue.assignee ?? issue.by,
			issue.closed,
			null,
			issue.close_reason ?? 'Closed',
			null
		);
	}
	return rows;
}

const password = crypto.randomUUID();
const container = `beadsmith-sample-${process.pid}`;
await run('docker', [
	'run',
	'-d',
	'--rm',
	'--name',
	container,
	'-e',
	`DOLT_ROOT_PASSWORD=${password}`,
	'-e',
	'DOLT_ROOT_HOST=%',
	'-p',
	'127.0.0.1::3306',
	DOLT_IMAGE
]);
try {
	const port = Number(
		(await run('docker', ['port', container, '3306/tcp'])).trim().split(':').pop()
	);
	for (let i = 0; ; i++) {
		const probe = spawnSync('docker', [
			'exec',
			container,
			'test',
			'-f',
			'/var/lib/dolt/.init_completed'
		]);
		if (probe.status === 0) break;
		if (i > 90) fail('Dolt did not start');
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}

	const mysql = (await import('mysql2/promise')).default;
	const env = {
		TZ: 'UTC',
		BD_NON_INTERACTIVE: '1',
		BEADS_DOLT_SERVER_HOST: '127.0.0.1',
		BEADS_DOLT_SERVER_PORT: String(port),
		BEADS_DOLT_SERVER_USER: 'root',
		BEADS_DOLT_PASSWORD: password
	};

	for (const project of SAMPLE_PROJECTS) {
		const work = mkdtempSync(join(tmpdir(), `beadsmith-sample-${project.database}-`));
		try {
			await run('git', ['init', '-q'], { cwd: work });
			await run('git', ['config', 'user.email', 'sample@example.com'], { cwd: work });
			await run('git', ['config', 'user.name', 'sample'], { cwd: work });
			await run(
				bd,
				[
					'init',
					'--server',
					'--external',
					'--server-host',
					'127.0.0.1',
					'--server-port',
					String(port),
					'--server-user',
					'root',
					'--database',
					project.database,
					'--prefix',
					project.prefix,
					'--non-interactive'
				],
				{ cwd: work, env }
			);
			const file = `${work}/issues.jsonl`;
			writeFileSync(file, project.issues.map((issue) => toJsonl(project, issue)).join('\n') + '\n');
			await run(bd, ['import', file], { cwd: work, env });
		} finally {
			rmSync(work, { recursive: true, force: true });
		}

		const conn = await mysql.createConnection({
			host: '127.0.0.1',
			port,
			user: 'root',
			password,
			database: project.database,
			multipleStatements: false,
			dateStrings: true,
			jsonStrings: true,
			supportBigNumbers: true,
			bigNumberStrings: true,
			timezone: 'Z'
		});
		try {
			await conn.query('DELETE FROM events');
			const events = (
				await Promise.all(project.issues.map((issue) => timeline(project, issue)))
			).flat();
			await conn.query(
				`INSERT INTO events (issue_id, event_type, actor, old_value, new_value, comment, created_at, id) VALUES ${events.join(', ')}`
			);

			const dump = await dumpDatabase(
				{
					async query(sql, params = []) {
						const [rows] = await conn.query(sql, params);
						return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
					}
				},
				project.database
			);
			const [columns] = (await conn.query(
				`SELECT c.TABLE_NAME AS t, c.COLUMN_NAME AS c FROM information_schema.COLUMNS c
				 JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
				 WHERE c.TABLE_SCHEMA = ? AND t.TABLE_TYPE = 'BASE TABLE' AND c.DATA_TYPE IN ('datetime', 'timestamp')
				 ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`,
				[project.database]
			)) as unknown as [Array<{ t: string; c: string }>];
			const by_table = new Map<string, string[]>();
			for (const { t, c } of columns) {
				if ((dump.tables[t] ?? 0) > 0) by_table.set(t, [...(by_table.get(t) ?? []), c]);
			}
			const shift = [...by_table].map(
				([table, cols]) =>
					`UPDATE ${quoteIdent(table)} SET ${cols.map((c) => `${quoteIdent(c)} = TIMESTAMPADD(SECOND, @shift, ${quoteIdent(c)})`).join(', ')};`
			);

			const sql = [
				`-- Beadsmith quickstart sample project "${project.database}".`,
				`-- Generated by scripts/quickstart-sample.ts with bd ${bd_version}; edit quickstart/sample/projects.ts and regenerate.`,
				`CREATE DATABASE ${quoteIdent(project.database)};`,
				`USE ${quoteIdent(project.database)};`,
				dump.sql
					.split('\n')
					.filter(
						(line) => !line.startsWith('-- Beadsmith backup') && !line.startsWith('-- format:')
					)
					.join('\n'),
				'-- Move every time so the generation anchor becomes the load time.',
				`SET @shift = TIMESTAMPDIFF(SECOND, '${sqlTime(0)}', UTC_TIMESTAMP());`,
				...shift,
				''
			].join('\n');
			const target = new URL(`20-${project.database}.sql`, OUT_DIR);
			writeFileSync(target, sql);
			const issues = dump.tables.issues ?? 0;
			console.log(
				`${project.database}: ${issues} issues, ${events.length} events -> ${target.pathname}`
			);
		} finally {
			await conn.end();
		}
	}
} finally {
	spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
}
