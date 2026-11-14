/**
 * First Mate's memories (ADR-0024 rules 1 and 3): short single facts per
 * owner account, each under a key unique to that owner and with exactly one
 * scope. They are app-owned rows in `state.db`, not chat state, so they
 * outlive chats, sandboxes and runners. Writing an existing key replaces the
 * memory. Limits come from the ADR's Limits table; a write over one is
 * refused with a message the model can act on, never truncated.
 *
 * Text recall uses an FTS5 index kept in step with the table by triggers.
 */
import type { Client } from '@libsql/client';

/** Longest memory body, in characters. */
export const MEMORY_BODY_MAX = 500;
/** Longest memory key, in characters. */
export const MEMORY_KEY_MAX = 64;
/** Longest topic slug in a `topic:<slug>` scope. */
export const MEMORY_TOPIC_MAX = 40;
/** Memories one owner may keep in all. */
export const MEMORIES_PER_OWNER = 500;
/** `owner`-scoped memories one owner may keep; they are recalled every turn. */
export const OWNER_SCOPED_MAX = 40;
/** Most memories one recall returns. */
export const RECALL_MAX = 25;

/** Lowercase words joined by single dashes: keys and topic slugs. */
export const MEMORY_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** Beadsmith project ids (`d_` plus a database name), as crew tools accept them. */
const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

/** `owner`, `project:<project id>` or `topic:<slug>`. */
export type MemoryScope = 'owner' | `project:${string}` | `topic:${string}`;

export interface Memory {
	key: string;
	scope: MemoryScope;
	body: string;
	/** The chat that last wrote it; null when written outside a chat. */
	source_chat_id: string | null;
	created_at: string;
	updated_at: string;
	last_recalled_at: string | null;
}

export interface RememberInput {
	key: string;
	scope: MemoryScope;
	body: string;
	source_chat_id: string | null;
}

export interface RecallFilter {
	/** Free text matched against key and body; omit to list newest first. */
	text?: string;
	scope?: MemoryScope;
	/** At most `RECALL_MAX`. */
	limit: number;
}

export interface MemoryCounts {
	total: number;
	owner_scoped: number;
}

export interface MemoryStore {
	/**
	 * Create or replace the memory under `key`. Throws `MemoryLimitError` when
	 * a limit refuses it; nothing is written then.
	 */
	remember(owner_id: string, input: RememberInput): Promise<{ memory: Memory; created: boolean }>;
	get(owner_id: string, key: string): Promise<Memory | undefined>;
	/** False when the owner has no memory under `key`. */
	forget(owner_id: string, key: string): Promise<boolean>;
	/** Matching memories, best match (or newest) first, and how many matched in all. */
	recall(owner_id: string, filter: RecallFilter): Promise<{ memories: Memory[]; total: number }>;
	/** Stamp `last_recalled_at` on these keys. */
	markRecalled(owner_id: string, keys: readonly string[]): Promise<void>;
	counts(owner_id: string): Promise<MemoryCounts>;
}

/** A write a limit refused. The message is written for the model and is safe to show. */
export class MemoryLimitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'MemoryLimitError';
	}
}

export const MEMORY_SCHEMA_SQL: string[] = [
	`CREATE TABLE IF NOT EXISTS mate_memories (
		id INTEGER PRIMARY KEY,
		owner_id TEXT NOT NULL,
		key TEXT NOT NULL,
		scope TEXT NOT NULL,
		body TEXT NOT NULL,
		source_chat_id TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		last_recalled_at TEXT,
		UNIQUE (owner_id, key)
	)`,
	'CREATE INDEX IF NOT EXISTS mate_memories_owner_scope ON mate_memories (owner_id, scope, updated_at)',
	`CREATE VIRTUAL TABLE IF NOT EXISTS mate_memories_fts USING fts5(
		key, body, content='mate_memories', content_rowid='id', tokenize='porter unicode61'
	)`,
	`CREATE TRIGGER IF NOT EXISTS mate_memories_fts_insert AFTER INSERT ON mate_memories BEGIN
		INSERT INTO mate_memories_fts (rowid, key, body) VALUES (new.id, new.key, new.body);
	END`,
	`CREATE TRIGGER IF NOT EXISTS mate_memories_fts_delete AFTER DELETE ON mate_memories BEGIN
		INSERT INTO mate_memories_fts (mate_memories_fts, rowid, key, body)
			VALUES ('delete', old.id, old.key, old.body);
	END`,
	`CREATE TRIGGER IF NOT EXISTS mate_memories_fts_update AFTER UPDATE OF key, body ON mate_memories BEGIN
		INSERT INTO mate_memories_fts (mate_memories_fts, rowid, key, body)
			VALUES ('delete', old.id, old.key, old.body);
		INSERT INTO mate_memories_fts (rowid, key, body) VALUES (new.id, new.key, new.body);
	END`
];

/**
 * Whether `value` is a well-formed scope: `owner`, `project:<id>` or
 * `topic:<slug>`.
 * @param value Candidate scope.
 */
export function isMemoryScope(value: string): value is MemoryScope {
	if (value === 'owner') return true;
	if (value.startsWith('project:')) return PROJECT_ID_PATTERN.test(value.slice('project:'.length));
	if (value.startsWith('topic:')) {
		const slug = value.slice('topic:'.length);
		return slug.length <= MEMORY_TOPIC_MAX && MEMORY_SLUG_PATTERN.test(slug);
	}
	return false;
}

/** At most this many words of free text reach the FTS query. */
const QUERY_WORDS_MAX = 32;

/**
 * An FTS5 query for free text: each word quoted, any of them may match. The
 * user's punctuation and FTS operators never reach the query syntax.
 * Undefined when the text has no words.
 * @param text Free text.
 */
export function ftsQuery(text: string): string | undefined {
	const words = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].slice(
		0,
		QUERY_WORDS_MAX
	);
	return words.length === 0 ? undefined : words.map((word) => `"${word}"`).join(' OR ');
}

const COLUMNS =
	'm.key, m.scope, m.body, m.source_chat_id, m.created_at, m.updated_at, m.last_recalled_at';

function toMemory(value: unknown): Memory {
	const r = value as Record<string, unknown>;
	const scope = String(r.scope);
	return {
		key: String(r.key),
		scope: isMemoryScope(scope) ? scope : 'owner',
		body: String(r.body),
		source_chat_id: typeof r.source_chat_id === 'string' ? r.source_chat_id : null,
		created_at: String(r.created_at),
		updated_at: String(r.updated_at),
		last_recalled_at: typeof r.last_recalled_at === 'string' ? r.last_recalled_at : null
	};
}

function checkInput(input: RememberInput): void {
	if (input.key.length > MEMORY_KEY_MAX || !MEMORY_SLUG_PATTERN.test(input.key)) {
		throw new MemoryLimitError(
			`A memory key is up to ${MEMORY_KEY_MAX} lowercase letters, digits and single dashes (like "backup-host").`
		);
	}
	if (!isMemoryScope(input.scope)) {
		throw new MemoryLimitError('A memory scope is "owner", "project:<id>" or "topic:<slug>".');
	}
	const body = input.body.trim();
	if (body.length === 0) throw new MemoryLimitError('A memory needs some text.');
	if (body.length > MEMORY_BODY_MAX) {
		throw new MemoryLimitError(
			`A memory is one fact of at most ${MEMORY_BODY_MAX} characters; this one has ${body.length}. Shorten it or split it into separate memories.`
		);
	}
}

export function createMemoryStore(client: Client, now: () => Date = () => new Date()): MemoryStore {
	async function get(owner_id: string, key: string): Promise<Memory | undefined> {
		const result = await client.execute({
			sql: `SELECT ${COLUMNS} FROM mate_memories m WHERE m.owner_id = ? AND m.key = ?`,
			args: [owner_id, key]
		});
		return result.rows[0] === undefined ? undefined : toMemory(result.rows[0]);
	}

	async function counts(owner_id: string): Promise<MemoryCounts> {
		const result = await client.execute({
			sql: `SELECT COUNT(*) AS total, COALESCE(SUM(scope = 'owner'), 0) AS owner_scoped
				FROM mate_memories WHERE owner_id = ?`,
			args: [owner_id]
		});
		const r = result.rows[0] as Record<string, unknown> | undefined;
		return { total: Number(r?.total ?? 0), owner_scoped: Number(r?.owner_scoped ?? 0) };
	}

	return {
		get,
		counts,

		async remember(owner_id, input) {
			checkInput(input);
			const body = input.body.trim();
			const before = await get(owner_id, input.key);
			const stamp = now().toISOString();
			// One statement, so the limits hold against concurrent writes: it
			// inserts or updates only while the owner is under them.
			const result = await client.execute({
				sql: `INSERT INTO mate_memories
					(owner_id, key, scope, body, source_chat_id, created_at, updated_at)
					SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?6
					WHERE (
						EXISTS (SELECT 1 FROM mate_memories WHERE owner_id = ?1 AND key = ?2)
						OR (SELECT COUNT(*) FROM mate_memories WHERE owner_id = ?1) < ?7
					) AND (
						?3 <> 'owner'
						OR COALESCE(
							(SELECT scope FROM mate_memories WHERE owner_id = ?1 AND key = ?2), ''
						) = 'owner'
						OR (SELECT COUNT(*) FROM mate_memories WHERE owner_id = ?1 AND scope = 'owner') < ?8
					)
					ON CONFLICT (owner_id, key) DO UPDATE SET
						scope = excluded.scope,
						body = excluded.body,
						source_chat_id = excluded.source_chat_id,
						updated_at = excluded.updated_at`,
				args: [
					owner_id,
					input.key,
					input.scope,
					body,
					input.source_chat_id,
					stamp,
					MEMORIES_PER_OWNER,
					OWNER_SCOPED_MAX
				]
			});
			if (result.rowsAffected === 0) {
				const { total } = await counts(owner_id);
				throw new MemoryLimitError(
					before === undefined && total >= MEMORIES_PER_OWNER
						? `Memory is full (${MEMORIES_PER_OWNER} memories). Forget one or update an existing key first.`
						: `There are already ${OWNER_SCOPED_MAX} owner memories, which are recalled every turn. Forget or merge one, or give this one a project or topic scope.`
				);
			}
			const memory = await get(owner_id, input.key);
			if (memory === undefined) throw new Error('memory vanished after write');
			return { memory, created: before === undefined };
		},

		async forget(owner_id, key) {
			const result = await client.execute({
				sql: 'DELETE FROM mate_memories WHERE owner_id = ? AND key = ?',
				args: [owner_id, key]
			});
			return result.rowsAffected > 0;
		},

		async recall(owner_id, filter) {
			const limit = Math.max(1, Math.min(filter.limit, RECALL_MAX));
			const query = filter.text === undefined ? undefined : ftsQuery(filter.text);
			if (filter.text !== undefined && query === undefined) return { memories: [], total: 0 };
			const where: string[] = [];
			const args: (string | number)[] = [];
			if (query !== undefined) {
				where.push('mate_memories_fts MATCH ?');
				args.push(query);
			}
			where.push('m.owner_id = ?');
			args.push(owner_id);
			if (filter.scope !== undefined) {
				where.push('m.scope = ?');
				args.push(filter.scope);
			}
			const from =
				query === undefined
					? 'FROM mate_memories m'
					: 'FROM mate_memories_fts f JOIN mate_memories m ON m.id = f.rowid';
			const clause = `WHERE ${where.join(' AND ')}`;
			const order =
				query === undefined ? 'm.updated_at DESC, m.key' : 'bm25(mate_memories_fts), m.key';
			const [rows, total] = await Promise.all([
				client.execute({
					sql: `SELECT ${COLUMNS} ${from} ${clause} ORDER BY ${order} LIMIT ?`,
					args: [...args, limit]
				}),
				client.execute({ sql: `SELECT COUNT(*) AS n ${from} ${clause}`, args })
			]);
			return {
				memories: rows.rows.map(toMemory),
				total: Number((total.rows[0] as Record<string, unknown>).n ?? 0)
			};
		},

		async markRecalled(owner_id, keys) {
			if (keys.length === 0) return;
			await client.execute({
				sql: `UPDATE mate_memories SET last_recalled_at = ?
					WHERE owner_id = ? AND key IN (${keys.map(() => '?').join(', ')})`,
				args: [now().toISOString(), owner_id, ...keys]
			});
		}
	};
}
