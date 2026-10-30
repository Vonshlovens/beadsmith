import { describe, expect, it } from 'vitest';
import type { SqlRow } from '../dolt/client.js';
import {
	dumpDatabase,
	quoteIdent,
	splitStatements,
	sqlLiteral,
	type DumpConnection
} from './dump.js';

describe('sqlLiteral', () => {
	it('encodes scalars', () => {
		expect(sqlLiteral(null)).toBe('NULL');
		expect(sqlLiteral(undefined)).toBe('NULL');
		expect(sqlLiteral(42)).toBe('42');
		expect(sqlLiteral(1.5)).toBe('1.5');
		expect(sqlLiteral(10n)).toBe('10');
		expect(sqlLiteral(true)).toBe('1');
		expect(() => sqlLiteral(Number.NaN)).toThrow();
	});

	it('escapes strings so a dump never contains a raw newline in a literal', () => {
		expect(sqlLiteral("it's a\\b\nc\r\0\x1a;")).toBe("'it\\'s a\\\\b\\nc\\r\\0\\Z;'");
		expect(sqlLiteral('end;\nDROP TABLE x')).not.toContain('\n');
	});

	it('encodes binary, dates, and JSON objects', () => {
		expect(sqlLiteral(new Uint8Array([0, 255]))).toBe("X'00ff'");
		expect(sqlLiteral(new Uint8Array([]))).toBe("''");
		expect(sqlLiteral(new Date('2026-10-17T01:02:03.004Z'))).toBe("'2026-10-17 01:02:03.004'");
		expect(sqlLiteral({ a: "b'c" })).toBe('\'{"a":"b\\\'c"}\'');
	});
});

describe('quoteIdent', () => {
	it('doubles backticks', () => {
		expect(quoteIdent('a`b')).toBe('`a``b`');
	});
});

function fakeConnection(): { conn: DumpConnection; statements: string[] } {
	const statements: string[] = [];
	const tables: Record<
		string,
		{ create: string; columns: Array<[string, string]>; rows: SqlRow[] }
	> = {
		issues: {
			create:
				'CREATE TABLE `issues` (\n  `id` varchar(64) NOT NULL,\n  `title` text,\n  PRIMARY KEY (`id`)\n)',
			// EXTRA values as Dolt reports them.
			columns: [
				['id', ''],
				['title', ''],
				['title_len', 'STORED GENERATED'],
				['title_words', 'VIRTUAL GENERATED'],
				['created_at', 'DEFAULT_GENERATED'],
				['updated_at', 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP']
			],
			rows: [
				{
					id: 'bw-1',
					title: 'Line one\nline two; with semicolon',
					created_at: '2026-07-01 10:00:00',
					updated_at: '2026-07-02 11:30:00.250'
				},
				{ id: 'bw-2', title: null, created_at: '2026-07-03 09:00:00', updated_at: null }
			]
		},
		labels: {
			create: 'CREATE TABLE `labels` (\n  `issue_id` varchar(64) NOT NULL\n)',
			columns: [['issue_id', '']],
			rows: []
		}
	};
	const conn: DumpConnection = {
		async query(sql, params = []) {
			statements.push(sql);
			if (sql.startsWith('SHOW FULL TABLES')) {
				return [
					{ Tables_in_beads_web: 'labels', Table_type: 'BASE TABLE' },
					{ Tables_in_beads_web: 'issues', Table_type: 'BASE TABLE' },
					{ Tables_in_beads_web: 'ready', Table_type: 'VIEW' }
				];
			}
			const create = /^SHOW CREATE TABLE `beads_web`\.`(\w+)`/.exec(sql);
			if (create) return [{ Table: create[1], 'Create Table': tables[create[1]].create }];
			if (sql.startsWith('SHOW CREATE VIEW')) {
				return [{ View: 'ready', 'Create View': 'CREATE VIEW `ready` AS select 1' }];
			}
			if (sql.startsWith('SELECT COLUMN_NAME')) {
				return tables[String(params[1])].columns.map(([COLUMN_NAME, EXTRA]) => ({
					COLUMN_NAME,
					EXTRA
				}));
			}
			const select = /^SELECT .* FROM `beads_web`\.`(\w+)`$/.exec(sql);
			if (select) return tables[select[1]].rows;
			if (sql.includes('dolt_log')) return [{ commit_hash: 'abc123' }];
			return [];
		}
	};
	return { conn, statements };
}

describe('dumpDatabase', () => {
	it('dumps schema and rows in one read-only transaction', async () => {
		const { conn, statements } = fakeConnection();
		const dump = await dumpDatabase(conn, 'beads_web');
		expect(statements[0]).toBe('START TRANSACTION READ ONLY');
		expect(statements.at(-1)).toBe('ROLLBACK');
		expect(dump.tables).toEqual({ issues: 2, labels: 0 });
		expect(dump.head).toBe('abc123');
		// Computed columns are skipped; defaulted timestamps are data and kept.
		expect(statements).toContain(
			'SELECT `id`, `title`, `created_at`, `updated_at` FROM `beads_web`.`issues`'
		);
		expect(dump.sql).toContain('-- format: beadsmith-sql/1');
		expect(dump.sql.indexOf('`issues`')).toBeLessThan(dump.sql.indexOf('`labels`'));
		expect(dump.sql.indexOf('CREATE VIEW')).toBeGreaterThan(dump.sql.indexOf('`labels`'));
	});

	it('produces statements a restore can split safely', async () => {
		const { conn } = fakeConnection();
		const statements = splitStatements((await dumpDatabase(conn, 'beads_web')).sql);
		expect(statements[0]).toBe('SET FOREIGN_KEY_CHECKS=0');
		expect(statements.at(-1)).toBe('SET FOREIGN_KEY_CHECKS=1');
		const insert = statements.find((s) => s.startsWith('INSERT INTO `issues`'));
		expect(insert).toBe(
			'INSERT INTO `issues` (`id`, `title`, `created_at`, `updated_at`) VALUES\n' +
				"  ('bw-1', 'Line one\\nline two; with semicolon', '2026-07-01 10:00:00', '2026-07-02 11:30:00.250'),\n" +
				"  ('bw-2', NULL, '2026-07-03 09:00:00', NULL)"
		);
		expect(statements.some((s) => s.startsWith('CREATE TABLE `issues`'))).toBe(true);
		expect(statements.every((s) => !s.startsWith('-- '))).toBe(true);
	});

	it('refuses invalid database names before querying', async () => {
		const { conn, statements } = fakeConnection();
		await expect(dumpDatabase(conn, 'bad;name')).rejects.toThrow('invalid database name');
		expect(statements).toHaveLength(0);
	});

	it('rolls back when a query fails', async () => {
		const statements: string[] = [];
		const conn: DumpConnection = {
			async query(sql) {
				statements.push(sql);
				if (sql.startsWith('SHOW FULL TABLES')) throw new Error('boom');
				return [];
			}
		};
		await expect(dumpDatabase(conn, 'beads_web')).rejects.toThrow('boom');
		expect(statements.at(-1)).toBe('ROLLBACK');
	});
});
