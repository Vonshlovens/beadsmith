/**
 * Logical SQL dump of one database over a read-only connection: schema from
 * `SHOW CREATE`, then batched INSERTs, inside one read-only transaction so
 * the tables are a consistent snapshot.
 *
 * Format (`beadsmith-sql/1`): every statement ends with `;\n`, and string
 * literals escape newlines, so a restore can split on `;\n` safely. Comment
 * lines start with `-- `.
 */
import type { SqlRow } from '../dolt/client.js';
import { DB_NAME_PATTERN } from '../dolt/names.js';

export const DUMP_FORMAT = 'beadsmith-sql/1';
const INSERT_BATCH = 100;

/** One dedicated connection; must return dates/JSON/decimals as strings. */
export interface DumpConnection {
	query(sql: string, params?: unknown[]): Promise<SqlRow[]>;
}

export interface DatabaseDump {
	database: string;
	sql: string;
	/** Row count per base table. */
	tables: Record<string, number>;
	/** Latest Dolt commit hash when the server exposes `dolt_log`. */
	head?: string;
}

/** Backtick-quote an identifier. */
export function quoteIdent(name: string): string {
	return `\`${name.replace(/`/g, '``')}\``;
}

function pad(n: number, width = 2): string {
	return String(n).padStart(width, '0');
}

/** Encode a driver value as a MySQL literal. */
export function sqlLiteral(value: unknown): string {
	if (value === null || value === undefined) return 'NULL';
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new Error('non-finite number in row');
		return String(value);
	}
	if (typeof value === 'bigint') return value.toString();
	if (typeof value === 'boolean') return value ? '1' : '0';
	if (value instanceof Uint8Array) {
		return value.length === 0
			? "''"
			: `X'${Array.from(value, (b) => b.toString(16).padStart(2, '0')).join('')}'`;
	}
	if (value instanceof Date) {
		// Dolt DATETIME is naive UTC (the read pool also uses timezone Z).
		const d = value;
		return `'${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(
			d.getUTCHours()
		)}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}'`;
	}
	const text = typeof value === 'string' ? value : JSON.stringify(value);
	return `'${text.replace(/[\\'\n\r\0\x1a]/g, (ch) => {
		switch (ch) {
			case '\\':
				return '\\\\';
			case "'":
				return "\\'";
			case '\n':
				return '\\n';
			case '\r':
				return '\\r';
			case '\0':
				return '\\0';
			default:
				return '\\Z';
		}
	})}'`;
}

function column(row: SqlRow, ...names: string[]): unknown {
	for (const name of names) {
		if (name in row) return row[name];
		const lower = Object.keys(row).find((key) => key.toLowerCase() === name.toLowerCase());
		if (lower !== undefined) return row[lower];
	}
	return undefined;
}

/**
 * Dump one database. Throws on an invalid name or any query failure.
 * @param conn Dedicated read-only connection.
 * @param database Database name from discovery.
 */
export async function dumpDatabase(conn: DumpConnection, database: string): Promise<DatabaseDump> {
	if (!DB_NAME_PATTERN.test(database)) throw new Error('invalid database name');
	const db = quoteIdent(database);
	const out: string[] = [
		`-- Beadsmith backup of database ${database}`,
		`-- format: ${DUMP_FORMAT}`,
		'SET FOREIGN_KEY_CHECKS=0;'
	];
	const tables: Record<string, number> = {};
	let head: string | undefined;

	await conn.query('START TRANSACTION READ ONLY');
	try {
		const listed = await conn.query(`SHOW FULL TABLES FROM ${db}`);
		const base: string[] = [];
		const views: string[] = [];
		for (const row of listed) {
			const values = Object.values(row);
			const name = typeof values[0] === 'string' ? values[0] : '';
			const type = String(column(row, 'Table_type') ?? values[1] ?? '');
			if (name === '') continue;
			(type.toUpperCase() === 'VIEW' ? views : base).push(name);
		}
		base.sort();
		views.sort();

		for (const table of base) {
			const qualified = `${db}.${quoteIdent(table)}`;
			const [create] = await conn.query(`SHOW CREATE TABLE ${qualified}`);
			const ddl = String(column(create ?? {}, 'Create Table') ?? '');
			if (ddl === '') throw new Error(`no CREATE TABLE for ${table}`);
			out.push('', `-- table ${table}`, `DROP TABLE IF EXISTS ${quoteIdent(table)};`, `${ddl};`);

			const columns = await conn.query(
				'SELECT COLUMN_NAME, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
				[database, table]
			);
			// Skip computed columns only. A column with a default expression
			// (DEFAULT CURRENT_TIMESTAMP) reports `DEFAULT_GENERATED` and holds data.
			const insertable = columns
				.filter((c) => !/\b(VIRTUAL|STORED) GENERATED\b/i.test(String(column(c, 'EXTRA') ?? '')))
				.map((c) => String(column(c, 'COLUMN_NAME')));
			if (insertable.length === 0) {
				tables[table] = 0;
				continue;
			}
			const column_list = insertable.map(quoteIdent).join(', ');
			const rows = await conn.query(`SELECT ${column_list} FROM ${qualified}`);
			tables[table] = rows.length;
			for (let i = 0; i < rows.length; i += INSERT_BATCH) {
				const values = rows
					.slice(i, i + INSERT_BATCH)
					.map((row) => `(${insertable.map((name) => sqlLiteral(row[name])).join(', ')})`)
					.join(',\n  ');
				out.push(`INSERT INTO ${quoteIdent(table)} (${column_list}) VALUES\n  ${values};`);
			}
		}

		for (const view of views) {
			const [create] = await conn.query(`SHOW CREATE VIEW ${db}.${quoteIdent(view)}`);
			const ddl = String(column(create ?? {}, 'Create View') ?? '');
			if (ddl === '') continue;
			out.push('', `-- view ${view}`, `DROP VIEW IF EXISTS ${quoteIdent(view)};`, `${ddl};`);
		}

		try {
			const [latest] = await conn.query(`SELECT commit_hash FROM ${db}.dolt_log LIMIT 1`);
			const hash = column(latest ?? {}, 'commit_hash');
			if (typeof hash === 'string' && hash.length > 0) head = hash;
		} catch {
			// Not a Dolt server, or dolt_log is hidden; the dump is still valid.
		}
	} finally {
		await conn.query('ROLLBACK').catch(() => undefined);
	}

	out.push('', 'SET FOREIGN_KEY_CHECKS=1;', '');
	return { database, sql: out.join('\n'), tables, head };
}

/**
 * Split a `beadsmith-sql/1` dump into executable statements.
 * @param sql Dump text.
 */
export function splitStatements(sql: string): string[] {
	return sql
		.split(';\n')
		.map((chunk) =>
			chunk
				.split('\n')
				.filter((line) => !line.startsWith('-- '))
				.join('\n')
				.trim()
		)
		.filter((statement) => statement.length > 0);
}
