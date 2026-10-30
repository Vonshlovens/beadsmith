/**
 * Beads schema compatibility. Upstream bd evolves the
 * project schema; Beadsmith reads it directly. Compatibility is structural:
 * every column the read plane selects must exist. The bd version that last
 * touched the database (`local_metadata.bd_version`) and the newest applied
 * migration are reported alongside, labelled tested or untested.
 */
import { DB_NAME_PATTERN } from './names.js';
import type { QueryFn } from './client.js';

/** Every table and column `client.ts` reads. Keep in sync with its queries. */
export const REQUIRED_COLUMNS: Record<string, readonly string[]> = {
	issues: [
		'id',
		'title',
		'description',
		'design',
		'acceptance_criteria',
		'notes',
		'status',
		'priority',
		'issue_type',
		'assignee',
		'owner',
		'created_by',
		'created_at',
		'updated_at',
		'defer_until',
		'due_at',
		'estimated_minutes',
		'external_ref',
		'metadata'
	],
	dependencies: ['issue_id', 'depends_on_issue_id', 'type', 'created_at'],
	comments: ['id', 'issue_id', 'author', 'text', 'created_at'],
	labels: ['issue_id', 'label'],
	events: ['issue_id', 'event_type', 'actor', 'created_at']
};

/** bd minor versions exercised by CI (scripts/ci/seed-beads-db.sh). */
export const TESTED_BD_MINORS = ['1.1', '1.2', '1.3'] as const;

export type SchemaStatus = 'supported' | 'untested' | 'unsupported';

export interface SchemaInfo {
	status: SchemaStatus;
	bd_version?: string;
	/** Highest applied bd schema migration. */
	migration?: number;
	/** `table.column` entries the read plane needs but the database lacks. */
	missing: string[];
}

/** Raised by project reads when the schema cannot be read safely. */
export class UnsupportedSchemaError extends Error {
	readonly info: SchemaInfo;

	constructor(database: string, info: SchemaInfo) {
		super(
			`Project ${database} uses a Beads schema this version of Beadsmith cannot read` +
				(info.bd_version === undefined ? '.' : ` (written by bd ${info.bd_version}).`)
		);
		this.name = 'UnsupportedSchemaError';
		this.info = info;
	}
}

function minorOf(version: string | undefined): string | undefined {
	const match = /^v?(\d+)\.(\d+)/.exec(version ?? '');
	return match === null ? undefined : `${match[1]}.${match[2]}`;
}

/** Classify from facts; pure for tests. */
export function classifySchema(
	present: ReadonlySet<string>,
	bd_version: string | undefined,
	migration: number | undefined
): SchemaInfo {
	const missing: string[] = [];
	for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
		for (const column of columns) {
			if (!present.has(`${table}.${column}`)) missing.push(`${table}.${column}`);
		}
	}
	const minor = minorOf(bd_version);
	const status: SchemaStatus =
		missing.length > 0
			? 'unsupported'
			: minor !== undefined && (TESTED_BD_MINORS as readonly string[]).includes(minor)
				? 'supported'
				: 'untested';
	return { status, bd_version, migration, missing };
}

/**
 * Inspect one database with read-only queries.
 * @param query Read-only executor.
 * @param database Validated database name.
 */
export async function inspectSchema(query: QueryFn, database: string): Promise<SchemaInfo> {
	if (!DB_NAME_PATTERN.test(database)) throw new Error('invalid database name');
	const tables = Object.keys(REQUIRED_COLUMNS);
	const rows = await query(
		`SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
		 WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${tables.map(() => '?').join(', ')})`,
		[database, ...tables]
	);
	const present = new Set(
		rows.map((row) => {
			const values = Object.values(row);
			return `${String(row.TABLE_NAME ?? values[0])}.${String(row.COLUMN_NAME ?? values[1])}`;
		})
	);
	let bd_version: string | undefined;
	try {
		const [row] = await query(
			`SELECT value FROM \`${database}\`.local_metadata WHERE \`key\` = 'bd_version'`,
			[]
		);
		bd_version = typeof row?.value === 'string' && row.value.length > 0 ? row.value : undefined;
	} catch {
		bd_version = undefined;
	}
	let migration: number | undefined;
	try {
		const [row] = await query(
			`SELECT MAX(version) AS m FROM \`${database}\`.schema_migrations`,
			[]
		);
		const value = Number(row?.m);
		migration = Number.isFinite(value) && row?.m !== null ? value : undefined;
	} catch {
		migration = undefined;
	}
	return classifySchema(present, bd_version, migration);
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; info: Promise<SchemaInfo> }>();

/**
 * Cached inspection; failures are not cached.
 * @param now Clock override for tests.
 */
export function cachedSchema(
	query: QueryFn,
	database: string,
	now = Date.now()
): Promise<SchemaInfo> {
	const hit = cache.get(database);
	if (hit !== undefined && now - hit.at < CACHE_TTL_MS) return hit.info;
	const info = inspectSchema(query, database);
	cache.set(database, { at: now, info });
	info.catch(() => cache.delete(database));
	return info;
}

/** Drop cached results (tests and project refresh). */
export function clearSchemaCache(): void {
	cache.clear();
}
