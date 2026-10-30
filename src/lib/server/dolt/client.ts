import { getEnv, type ServerEnv } from '../env.js';
import { DoltCredentialError, resolveDoltPassword } from '../dolt-password.js';
import type {
	ActivityEvent,
	DoltFailureKind,
	IssueDetail,
	IssueRef,
	IssueSummary,
	ProjectCounts
} from '$lib/types.js';

/** Re-export the shared public failure taxonomy for existing server callers. */
export type { DoltFailureKind } from '$lib/types.js';

/** Row shape returned by the query function. */
export type SqlRow = Record<string, unknown>;

/**
 * Single-statement, read-only query executor.
 * @param sql SELECT/SHOW statement with `?` placeholders.
 * @param params Bound parameters.
 */
export type QueryFn = (sql: string, params: unknown[]) => Promise<SqlRow[]>;

export { DB_NAME_PATTERN } from './names.js';
import { cachedSchema, type SchemaInfo } from './schema.js';
import { DB_NAME_PATTERN } from './names.js';

const SYSTEM_DATABASES = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);
const MAX_LIMIT = 1000;

/** Raised for any Dolt/SQL failure surfaced to the API layer. */
export class DoltError extends Error {
	/**
	 * @param message Scrubbed, user-facing message.
	 */
	constructor(message: string) {
		super(message);
		this.name = 'DoltError';
	}
}

const DOLT_CONNECTION_MESSAGES: Record<DoltFailureKind, string> = {
	credential_unavailable:
		'Protected Dolt authentication is unavailable. Check the service credential configuration.',
	authentication_rejected:
		'Dolt authentication was rejected. Check the configured service credentials.',
	unreachable: 'Dolt server is unreachable. Check the service connection configuration.',
	unknown: 'Dolt connection failed. Check the service connection configuration.'
};

/**
 * A driver-independent remote Dolt connection failure.
 *
 * This deliberately carries no driver cause or message: mysql errors can
 * contain hosts, user names, paths, and sometimes connection details. It
 * retains the `DoltError` name so existing route error envelopes stay safe
 * while callers migrate to the typed failure kind.
 */
export class DoltConnectionError extends DoltError {
	readonly kind: DoltFailureKind;

	constructor(kind: DoltFailureKind) {
		super(DOLT_CONNECTION_MESSAGES[kind]);
		this.kind = kind;
	}
}

/** True if a value is the typed, safe remote-Dolt connection error. */
export function isDoltConnectionError(error: unknown): error is DoltConnectionError {
	return error instanceof DoltConnectionError;
}

const TRANSPORT_ERROR_CODES = new Set([
	'EAI_AGAIN',
	'ECONNABORTED',
	'ECONNREFUSED',
	'ECONNRESET',
	'EHOSTDOWN',
	'EHOSTUNREACH',
	'ENETDOWN',
	'ENETRESET',
	'ENETUNREACH',
	'ENOTCONN',
	'ENOTFOUND',
	'EPIPE',
	'ETIMEDOUT',
	'PROTOCOL_CONNECTION_LOST',
	'PROTOCOL_SEQUENCE_TIMEOUT'
]);

/**
 * Read a string code from an untrusted driver error without invoking a
 * possibly-throwing getter. Driver messages are intentionally never read.
 */
function errorCode(error: unknown, key: 'code' | 'sqlState'): string | undefined {
	if (typeof error !== 'object' || error === null) {
		return undefined;
	}
	try {
		const value = Reflect.get(error, key);
		return typeof value === 'string' ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Convert an arbitrary SQL/client failure into a fixed-message error.
 *
 * Classification is deliberately restricted to the credential error type and
 * documented driver codes. In particular, it never infers a kind from a
 * message string, which could be untrusted or contain sensitive data.
 */
export function toDoltConnectionError(error: unknown): DoltConnectionError {
	if (isDoltConnectionError(error)) {
		return error;
	}
	if (error instanceof DoltCredentialError) {
		return new DoltConnectionError('credential_unavailable');
	}

	const code = errorCode(error, 'code');
	const sql_state = errorCode(error, 'sqlState');
	if (code === 'ER_ACCESS_DENIED_ERROR' || code === '28000' || sql_state === '28000') {
		return new DoltConnectionError('authentication_rejected');
	}
	if (code !== undefined && TRANSPORT_ERROR_CODES.has(code)) {
		return new DoltConnectionError('unreachable');
	}
	return new DoltConnectionError('unknown');
}

/**
 * Validate and backtick-quote a database identifier.
 * @param name Database name.
 */
export function quoteDatabase(name: string): string {
	if (!DB_NAME_PATTERN.test(name)) {
		throw new DoltError('invalid database name');
	}
	return `\`${name}\``;
}

/**
 * Clamp a caller-supplied limit to a safe integer literal.
 * @param limit Requested limit.
 * @param fallback Value used when the input is unusable.
 */
export function clampLimit(limit: number | undefined, fallback = 100): number {
	if (limit === undefined || !Number.isFinite(limit)) {
		return fallback;
	}
	const truncated = Math.trunc(limit);
	if (truncated < 1) {
		return 1;
	}
	return Math.min(truncated, MAX_LIMIT);
}

/**
 * True when a database is a Beads project rather than server plumbing.
 * @param name Database name from `SHOW DATABASES`.
 */
export function isUserDatabase(name: string): boolean {
	const lower = name.toLowerCase();
	if (SYSTEM_DATABASES.has(lower)) {
		return false;
	}
	return !lower.startsWith('dolt_');
}

/**
 * Convert a MySQL datetime value to an ISO 8601 string.
 * @param value Raw column value.
 */
export function toIso(value: unknown): string | undefined {
	if (value === null || value === undefined) {
		return undefined;
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	if (typeof value === 'string') {
		if (value.length === 0) {
			return undefined;
		}
		const parsed = new Date(value.replace(' ', 'T') + (value.includes('Z') ? '' : 'Z'));
		return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
	}
	return undefined;
}

/**
 * Read a column as a string, tolerating null.
 * @param value Raw column value.
 */
function text(value: unknown): string | undefined {
	if (typeof value === 'string' && value.length > 0) {
		return value;
	}
	return undefined;
}

/**
 * Read a column as a number, tolerating null and string digits.
 * @param value Raw column value.
 */
function num(value: unknown): number | undefined {
	if (typeof value === 'number') {
		return value;
	}
	if (typeof value === 'string') {
		const parsed = Number(value);
		return Number.isNaN(parsed) ? undefined : parsed;
	}
	return undefined;
}

export interface BrowseFilters {
	limit?: number;
	include_closed?: boolean;
	status?: string;
	type?: string;
	priority?: string;
	q?: string;
	label?: string;
}

export interface SqlWhere {
	clause: string;
	params: unknown[];
}

/**
 * Build the parameterised WHERE clause for an issue browse.
 *
 * Every user value becomes a bound parameter; nothing is interpolated.
 * @param filters Browse filters.
 * @param alias Table alias used in the statement.
 * @param database Database containing the labels table.
 */
export function buildIssueWhere(filters: BrowseFilters, alias = 'i', database?: string): SqlWhere {
	const clauses: string[] = [];
	const params: unknown[] = [];
	const labels_table = database === undefined ? 'labels' : `${quoteDatabase(database)}.labels`;

	if (filters.status !== undefined && filters.status.length > 0) {
		const statuses = filters.status
			.split(',')
			.map((entry) => {
				return entry.trim();
			})
			.filter((entry) => {
				return entry.length > 0;
			});
		if (statuses.length > 0) {
			clauses.push(
				`${alias}.status IN (${statuses
					.map(() => {
						return '?';
					})
					.join(', ')})`
			);
			params.push(...statuses);
		}
	} else if (filters.include_closed !== true) {
		clauses.push(`${alias}.status <> ?`);
		params.push('closed');
	}

	if (filters.type !== undefined && filters.type.length > 0) {
		const types = filters.type
			.split(',')
			.map((entry) => {
				return entry.trim();
			})
			.filter((entry) => {
				return entry.length > 0;
			});
		if (types.length > 0) {
			clauses.push(`${alias}.issue_type IN (${placeholders(types.length)})`);
			params.push(...types);
		}
	}
	if (filters.priority !== undefined && filters.priority.length > 0) {
		const priorities = filters.priority
			.split(',')
			.map((entry) => {
				return entry.trim();
			})
			.filter((entry) => {
				return entry.length > 0;
			})
			.map((entry) => {
				return Number(entry);
			});
		if (priorities.length > 0) {
			clauses.push(`${alias}.priority IN (${placeholders(priorities.length)})`);
			params.push(...priorities);
		}
	}
	if (filters.q !== undefined && filters.q.length > 0) {
		const pattern = `%${filters.q.replace(/[\\%_]/g, '\\$&')}%`;
		clauses.push(
			`(${alias}.id LIKE ? OR ${alias}.title LIKE ? OR EXISTS (` +
				`SELECT 1 FROM ${labels_table} q_label ` +
				`WHERE q_label.issue_id = ${alias}.id AND q_label.label LIKE ?))`
		);
		params.push(pattern, pattern, pattern);
	}
	if (filters.label !== undefined && filters.label.length > 0) {
		clauses.push(
			`EXISTS (SELECT 1 FROM ${labels_table} exact_label ` +
				`WHERE exact_label.issue_id = ${alias}.id AND exact_label.label = ?)`
		);
		params.push(filters.label);
	}

	return {
		clause: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
		params
	};
}

/**
 * Build a `?, ?, …` placeholder list.
 * @param count Number of placeholders.
 */
function placeholders(count: number): string {
	return new Array(count).fill('?').join(', ');
}

export interface DoltClient {
	listDatabases(): Promise<string[]>;
	issueCounts(database: string): Promise<ProjectCounts>;
	lastActivity(database: string): Promise<string | undefined>;
	browseIssues(database: string, filters: BrowseFilters): Promise<IssueSummary[]>;
	listReadyIssues(database: string, limit: number): Promise<IssueSummary[]>;
	issueDetail(database: string, id: string): Promise<IssueDetail | undefined>;
	dependents(database: string, id: string): Promise<IssueRef[]>;
	recentEvents(
		database: string,
		limit: number
	): Promise<Omit<ActivityEvent, 'project_id' | 'project_name'>[]>;
	issueEvents(
		database: string,
		id: string,
		limit: number
	): Promise<Omit<ActivityEvent, 'project_id' | 'project_name'>[]>;
	ping(): Promise<number>;
	/** Cached Beads schema compatibility (optional so test fakes may omit it). */
	schema?(database: string): Promise<SchemaInfo>;
}

/**
 * Read-only Dolt SQL client. All statements are single SELECT/SHOW queries.
 * @param query Injectable query executor (a fake in tests).
 */
export function createDoltClient(query: QueryFn): DoltClient {
	/**
	 * Fetch labels for a set of issue ids.
	 * @param database Validated database name.
	 * @param ids Issue ids.
	 */
	async function labelsFor(database: string, ids: string[]): Promise<Map<string, string[]>> {
		const map = new Map<string, string[]>();
		if (ids.length === 0) {
			return map;
		}
		const db = quoteDatabase(database);
		const rows = await query(
			`SELECT issue_id, label FROM ${db}.labels WHERE issue_id IN (${placeholders(ids.length)})`,
			ids
		);
		for (const row of rows) {
			const issue_id = text(row.issue_id);
			const label = text(row.label);
			if (issue_id === undefined || label === undefined) {
				continue;
			}
			const list = map.get(issue_id) ?? [];
			list.push(label);
			map.set(issue_id, list);
		}
		return map;
	}

	/**
	 * Map an issues row plus its labels onto `IssueSummary`.
	 * @param row Result row.
	 * @param labels Labels for the issue.
	 */
	function rowToSummary(row: SqlRow, labels: string[]): IssueSummary {
		return {
			id: text(row.id) ?? '',
			title: text(row.title) ?? '',
			status: text(row.status) ?? 'open',
			priority: num(row.priority) ?? 2,
			issue_type: text(row.issue_type) ?? 'task',
			assignee: text(row.assignee),
			owner: text(row.owner),
			labels,
			created_at: toIso(row.created_at) ?? '',
			updated_at: toIso(row.updated_at) ?? '',
			dependency_count: num(row.dependency_count) ?? 0,
			dependent_count: num(row.dependent_count) ?? 0,
			comment_count: num(row.comment_count) ?? 0
		};
	}

	/**
	 * Map a dependency join row onto `IssueRef`.
	 * @param row Result row.
	 */
	function rowToRef(row: SqlRow): IssueRef {
		return {
			id: text(row.id) ?? '',
			title: text(row.title),
			status: text(row.status),
			priority: num(row.priority),
			issue_type: text(row.issue_type),
			dep_type: text(row.dep_type)
		};
	}

	/**
	 * Map an events join row onto the project-agnostic part of `ActivityEvent`.
	 * @param row Result row.
	 */
	function rowToEvent(row: SqlRow): Omit<ActivityEvent, 'project_id' | 'project_name'> {
		return {
			issue_id: text(row.issue_id) ?? '',
			issue_title: text(row.issue_title),
			event_type: text(row.event_type) ?? 'updated',
			actor: text(row.actor) ?? 'unknown',
			created_at: toIso(row.created_at) ?? ''
		};
	}

	return {
		async listDatabases(): Promise<string[]> {
			const rows = await query('SHOW DATABASES', []);
			return rows
				.map((row) => {
					const value = Object.values(row)[0];
					return typeof value === 'string' ? value : '';
				})
				.filter((name) => {
					return name.length > 0 && isUserDatabase(name);
				});
		},

		async issueCounts(database: string): Promise<ProjectCounts> {
			const db = quoteDatabase(database);
			const rows = await query(
				`SELECT status, COUNT(*) AS n FROM ${db}.issues GROUP BY status`,
				[]
			);
			const counts: ProjectCounts = { open: 0, in_progress: 0, blocked: 0, closed: 0, total: 0 };
			for (const row of rows) {
				const status = text(row.status) ?? '';
				const n = num(row.n) ?? 0;
				counts.total += n;
				if (
					status === 'open' ||
					status === 'in_progress' ||
					status === 'blocked' ||
					status === 'closed'
				) {
					counts[status] += n;
				}
			}
			return counts;
		},

		async lastActivity(database: string): Promise<string | undefined> {
			const db = quoteDatabase(database);
			const rows = await query(`SELECT MAX(updated_at) AS last FROM ${db}.issues`, []);
			if (rows.length === 0) {
				return undefined;
			}
			return toIso(rows[0].last);
		},

		async browseIssues(database: string, filters: BrowseFilters): Promise<IssueSummary[]> {
			const db = quoteDatabase(database);
			const where = buildIssueWhere(filters, 'i', database);
			const limit = clampLimit(filters.limit);
			const rows = await query(
				`SELECT i.id, i.title, i.status, i.priority, i.issue_type, i.assignee, i.owner,
				        i.created_at, i.updated_at,
				        (SELECT COUNT(*) FROM ${db}.dependencies d WHERE d.issue_id = i.id) AS dependency_count,
				        (SELECT COUNT(*) FROM ${db}.dependencies d WHERE d.depends_on_issue_id = i.id) AS dependent_count,
				        (SELECT COUNT(*) FROM ${db}.comments c WHERE c.issue_id = i.id) AS comment_count
				 FROM ${db}.issues i ${where.clause}
				 ORDER BY i.updated_at DESC
				 LIMIT ${limit}`,
				where.params
			);
			const ids = rows
				.map((row) => {
					return text(row.id) ?? '';
				})
				.filter((id) => {
					return id.length > 0;
				});
			const labels = await labelsFor(database, ids);
			return rows.map((row) => {
				return rowToSummary(row, labels.get(text(row.id) ?? '') ?? []);
			});
		},

		async listReadyIssues(database: string, limit: number): Promise<IssueSummary[]> {
			const db = quoteDatabase(database);
			const clamped = clampLimit(limit);
			const rows = await query(
				`SELECT i.id, i.title, i.status, i.priority, i.issue_type, i.assignee, i.owner,
				        i.created_at, i.updated_at,
				        (SELECT COUNT(*) FROM ${db}.dependencies d WHERE d.issue_id = i.id) AS dependency_count,
				        (SELECT COUNT(*) FROM ${db}.dependencies d WHERE d.depends_on_issue_id = i.id) AS dependent_count,
				        (SELECT COUNT(*) FROM ${db}.comments c WHERE c.issue_id = i.id) AS comment_count
				 FROM ${db}.issues i
				 WHERE i.status = ?
				   AND NOT EXISTS (
				     SELECT 1 FROM ${db}.dependencies d
				     LEFT JOIN ${db}.issues blocker ON blocker.id = d.depends_on_issue_id
				     WHERE d.issue_id = i.id
				       AND d.type = ?
				       AND (blocker.id IS NULL OR blocker.status <> ?)
				   )
				 ORDER BY i.priority ASC, i.updated_at DESC
				 LIMIT ${clamped}`,
				['open', 'blocks', 'closed']
			);
			const ids = rows
				.map((row) => {
					return text(row.id) ?? '';
				})
				.filter((id) => {
					return id.length > 0;
				});
			const labels = await labelsFor(database, ids);
			return rows.map((row) => {
				return rowToSummary(row, labels.get(text(row.id) ?? '') ?? []);
			});
		},

		async dependents(database: string, id: string): Promise<IssueRef[]> {
			const db = quoteDatabase(database);
			const rows = await query(
				`SELECT d.issue_id AS id, d.type AS dep_type, i.title, i.status, i.priority, i.issue_type
				 FROM ${db}.dependencies d
				 LEFT JOIN ${db}.issues i ON i.id = d.issue_id
				 WHERE d.depends_on_issue_id = ?
				 ORDER BY d.created_at DESC
				 LIMIT ${MAX_LIMIT}`,
				[id]
			);
			return rows.map(rowToRef);
		},

		async issueDetail(database: string, id: string): Promise<IssueDetail | undefined> {
			const db = quoteDatabase(database);
			const rows = await query(
				`SELECT i.id, i.title, i.description, i.design, i.acceptance_criteria, i.notes,
				        i.status, i.priority, i.issue_type, i.assignee, i.owner, i.created_at,
				        i.created_by, i.updated_at, i.due_at, i.defer_until, i.estimated_minutes,
				        i.external_ref, i.metadata,
				        (SELECT COUNT(*) FROM ${db}.dependencies d WHERE d.issue_id = i.id) AS dependency_count,
				        (SELECT COUNT(*) FROM ${db}.dependencies d WHERE d.depends_on_issue_id = i.id) AS dependent_count,
				        (SELECT COUNT(*) FROM ${db}.comments c WHERE c.issue_id = i.id) AS comment_count
				 FROM ${db}.issues i WHERE i.id = ? LIMIT 1`,
				[id]
			);
			const row = rows[0];
			if (row === undefined) {
				return undefined;
			}
			const [labels, deps, dependents, comments] = await Promise.all([
				labelsFor(database, [id]),
				query(
					`SELECT d.depends_on_issue_id AS id, d.type AS dep_type, i.title, i.status, i.priority, i.issue_type
					 FROM ${db}.dependencies d
					 LEFT JOIN ${db}.issues i ON i.id = d.depends_on_issue_id
					 WHERE d.issue_id = ?
					 ORDER BY d.created_at DESC
					 LIMIT ${MAX_LIMIT}`,
					[id]
				),
				query(
					`SELECT d.issue_id AS id, d.type AS dep_type, i.title, i.status, i.priority, i.issue_type
					 FROM ${db}.dependencies d
					 LEFT JOIN ${db}.issues i ON i.id = d.issue_id
					 WHERE d.depends_on_issue_id = ?
					 ORDER BY d.created_at DESC
					 LIMIT ${MAX_LIMIT}`,
					[id]
				),
				query(
					`SELECT id, author, text, created_at FROM ${db}.comments
					 WHERE issue_id = ? ORDER BY created_at ASC LIMIT ${MAX_LIMIT}`,
					[id]
				)
			]);

			let metadata: Record<string, unknown> | undefined;
			const raw_metadata = row.metadata;
			if (typeof raw_metadata === 'string' && raw_metadata.length > 0 && raw_metadata !== '{}') {
				try {
					metadata = JSON.parse(raw_metadata) as Record<string, unknown>;
				} catch {
					metadata = undefined;
				}
			} else if (raw_metadata !== null && typeof raw_metadata === 'object') {
				const record = raw_metadata as Record<string, unknown>;
				metadata = Object.keys(record).length > 0 ? record : undefined;
			}

			return {
				...rowToSummary(row, labels.get(id) ?? []),
				description: text(row.description),
				acceptance_criteria: text(row.acceptance_criteria),
				notes: text(row.notes),
				design: text(row.design),
				created_by: text(row.created_by),
				due_at: toIso(row.due_at),
				defer_until: toIso(row.defer_until),
				estimate: num(row.estimated_minutes),
				external_ref: text(row.external_ref),
				dependencies: deps.map(rowToRef),
				dependents: dependents.map(rowToRef),
				comments: comments.map((comment, index) => {
					return {
						id: text(comment.id) ?? `${id}-c${index}`,
						author: text(comment.author) ?? 'unknown',
						text: text(comment.text) ?? '',
						created_at: toIso(comment.created_at)
					};
				}),
				metadata
			};
		},

		async recentEvents(
			database: string,
			limit: number
		): Promise<Omit<ActivityEvent, 'project_id' | 'project_name'>[]> {
			const db = quoteDatabase(database);
			const rows = await query(
				`SELECT e.issue_id, e.event_type, e.actor, e.created_at, i.title AS issue_title
				 FROM ${db}.events e
				 LEFT JOIN ${db}.issues i ON i.id = e.issue_id
				 ORDER BY e.created_at DESC
				 LIMIT ${clampLimit(limit, 50)}`,
				[]
			);
			return rows.map(rowToEvent);
		},

		async issueEvents(
			database: string,
			id: string,
			limit: number
		): Promise<Omit<ActivityEvent, 'project_id' | 'project_name'>[]> {
			const db = quoteDatabase(database);
			const rows = await query(
				`SELECT e.issue_id, e.event_type, e.actor, e.created_at, i.title AS issue_title
				 FROM ${db}.events e
				 LEFT JOIN ${db}.issues i ON i.id = e.issue_id
				 WHERE e.issue_id = ?
				 ORDER BY e.created_at DESC
				 LIMIT ${clampLimit(limit, 50)}`,
				[id]
			);
			return rows.map(rowToEvent);
		},

		schema(database: string): Promise<SchemaInfo> {
			return cachedSchema(query, database);
		},

		async ping(): Promise<number> {
			const started = Date.now();
			await query('SELECT 1 AS ok', []);
			return Date.now() - started;
		}
	};
}

interface PoolLike {
	query(sql: string, params: unknown[]): Promise<[unknown, unknown]>;
	end(): Promise<void>;
}

let pool_promise: Promise<PoolLike> | undefined;

/**
 * Create (once) the mysql2 pool. The password is placed only in the config
 * object — never in a URL, argv, or log line.
 * @param env Server environment.
 */
async function createPool(env: ServerEnv): Promise<PoolLike> {
	if (env.dolt_host === undefined) {
		throw new DoltError('Dolt server is not configured');
	}
	const mysql = await import('mysql2/promise');
	const password = await resolveDoltPassword();
	const pool = mysql.createPool({
		host: env.dolt_host,
		port: env.dolt_port,
		user: env.dolt_user,
		password,
		connectTimeout: 5000,
		multipleStatements: false,
		waitForConnections: true,
		connectionLimit: 4,
		maxIdle: 2,
		enableKeepAlive: true,
		// Dolt stores DATETIME values as naive UTC; without this mysql2 parses
		// them in the server's local zone and every timestamp shifts.
		timezone: 'Z'
	});
	// The promise pool re-emits the *core* connection, whose `query` is
	// callback-style; a callback is required so a failure cannot surface as an
	// unhandled 'error' event.
	pool.on('connection', (connection) => {
		const raw = connection as unknown as {
			query(sql: string, callback: (error: unknown) => void): unknown;
		};
		raw.query('SET SESSION TRANSACTION READ ONLY', () => {
			/* older servers may not support it; reads still work */
		});
	});
	return pool as unknown as PoolLike;
}

/**
 * Query executor backed by the shared mysql2 pool.
 * @param sql Single SELECT/SHOW statement.
 * @param params Bound parameters.
 */
export const poolQuery: QueryFn = async (sql, params) => {
	const env = getEnv();
	if (pool_promise === undefined) {
		pool_promise = createPool(env);
	}
	try {
		const pool = await pool_promise;
		const [rows] = await pool.query(sql, params);
		return Array.isArray(rows) ? (rows as SqlRow[]) : [];
	} catch (error) {
		throw toDoltConnectionError(error);
	}
};

let cached_client: DoltClient | undefined;

/** Cached client bound to the shared pool. */
export function getDoltClient(): DoltClient {
	if (cached_client === undefined) {
		cached_client = createDoltClient(poolQuery);
	}
	return cached_client;
}

/**
 * Replace the cached client and drop the pool (tests only).
 * @param client Client to install, or undefined to rebuild.
 */
export function setDoltClient(client: DoltClient | undefined): void {
	cached_client = client;
	if (client === undefined) {
		pool_promise = undefined;
	}
}
