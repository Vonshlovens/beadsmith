import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dumpDatabase } from '../backup/dump.js';
import { createDoltClient, type QueryFn, type SqlRow } from './client.js';
import { inspectSchema, TESTED_BD_MINORS } from './schema.js';

/**
 * Schema compatibility against real databases created by released bd
 * versions. Runs only with BDX_COMPAT_DATABASES set, e.g.
 * in CI after scripts/ci/seed-beads-db.sh:
 *
 *   BDX_COMPAT_DATABASES=compat_1_2_2,compat_1_3_1 BEADS_DOLT_SERVER_HOST=127.0.0.1 \
 *   BEADS_DOLT_SERVER_PORT=3307 BEADS_DOLT_SERVER_USER=root BEADS_DOLT_PASSWORD=... \
 *   npx vitest run src/lib/server/dolt/compat.test.ts
 *
 * Each seeded database holds four issues: an epic, an open labelled task that
 * depends on an in-progress bug, and a closed feature, plus one comment.
 */
const DATABASES = (process.env.BDX_COMPAT_DATABASES ?? '')
	.split(',')
	.map((name) => name.trim())
	.filter((name) => name.length > 0);

describe.runIf(DATABASES.length > 0)('bd schema compatibility', () => {
	let pool: mysql.Pool;
	let query: QueryFn;

	beforeAll(() => {
		pool = mysql.createPool({
			host: process.env.BEADS_DOLT_SERVER_HOST,
			port: Number(process.env.BEADS_DOLT_SERVER_PORT ?? 3306),
			user: process.env.BEADS_DOLT_SERVER_USER ?? 'root',
			password: process.env.BEADS_DOLT_PASSWORD ?? '',
			timezone: 'Z',
			connectionLimit: 2
		});
		query = async (sql, params) => {
			const [rows] = await pool.query(sql, params);
			return Array.isArray(rows) ? (rows as SqlRow[]) : [];
		};
	});

	afterAll(async () => {
		await pool.end();
	});

	for (const database of DATABASES) {
		describe(database, () => {
			it('has every column the read plane needs, from a tested bd release', async () => {
				const info = await inspectSchema(query, database);
				expect(info.missing).toEqual([]);
				expect(info.status).toBe('supported');
				expect(TESTED_BD_MINORS.some((minor) => info.bd_version?.startsWith(minor))).toBe(true);
				expect(info.migration).toBeGreaterThan(0);
			});

			it('serves the list, detail, dependency, ready, and activity reads', async () => {
				const client = createDoltClient(query);
				expect(await client.listDatabases()).toContain(database);

				const counts = await client.issueCounts(database);
				expect(counts.total).toBe(4);
				expect(counts.closed).toBe(1);
				expect(counts.in_progress).toBe(1);

				const open = await client.browseIssues(database, { limit: 50, include_closed: false });
				expect(open).toHaveLength(3);
				const all = await client.browseIssues(database, { limit: 50, include_closed: true });
				expect(all).toHaveLength(4);
				const labelled = await client.browseIssues(database, {
					limit: 50,
					include_closed: true,
					label: 'backend'
				});
				expect(labelled.map((issue) => issue.title)).toEqual(['Open task with label']);

				const task = labelled[0];
				const detail = await client.issueDetail(database, task.id);
				expect(detail?.description).toBe('Line one\nline two');
				expect(detail?.labels).toContain('backend');
				expect(detail?.comments?.map((comment) => comment.text)).toEqual([
					'First comment; with punctuation'
				]);
				const blocker = all.find((issue) => issue.title === 'Blocking bug');
				expect(detail?.dependencies?.map((dep) => dep.id)).toContain(blocker?.id);
				expect((await client.dependents(database, blocker?.id ?? '')).map((d) => d.id)).toContain(
					task.id
				);

				const ready = await client.listReadyIssues(database, 50);
				expect(ready.map((issue) => issue.title)).not.toContain('Open task with label');
				expect(ready.map((issue) => issue.title)).not.toContain('Closed feature');

				expect((await client.recentEvents(database, 50)).length).toBeGreaterThan(0);
				expect(await client.lastActivity(database)).toBeDefined();
			});

			it('dumps for backup with row counts matching the issue count', async () => {
				const connection = await pool.getConnection();
				try {
					const dump = await dumpDatabase(
						{
							async query(sql, params = []) {
								const [rows] = await connection.query(sql, params);
								return Array.isArray(rows) ? (rows as SqlRow[]) : [];
							}
						},
						database
					);
					expect(dump.tables.issues).toBe(4);
					expect(dump.tables.comments).toBe(1);
					expect(dump.head).toMatch(/^[a-z0-9]+$/);
				} finally {
					connection.release();
				}
			});
		});
	}
});

describe.runIf(DATABASES.length === 0)('bd schema compatibility', () => {
	it('is skipped without BDX_COMPAT_DATABASES', () => {
		expect(DATABASES).toEqual([]);
	});
});
