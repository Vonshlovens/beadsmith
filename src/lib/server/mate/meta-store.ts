/**
 * First Mate's meta folder (ADR-0024 rule 5): a per-owner tree of text files
 * the agent organizes as it sees fit (notes, drafts, docs for itself, its own
 * checklist). App-owned rows in `state.db`, keyed by owner account and path,
 * so the folder outlives chats, sandboxes and runners. There are no
 * directories as such: a folder is a path prefix. Writes over a limit are
 * refused with a message the model can act on, never truncated.
 */
import type { Client } from '@libsql/client';

/** Longest file, in characters. Fits one crew tool result whole. */
export const META_FILE_MAX = 20_000;
/** Files one owner may keep. */
export const META_FILES_PER_OWNER = 200;
/** Characters one owner may keep across every file. */
export const META_CHARS_PER_OWNER = 1_000_000;
/** Longest path, in characters. */
export const META_PATH_MAX = 200;
/** Most path segments (folders plus the file name). */
export const META_PATH_DEPTH = 8;

/** One path segment: letters, digits, dot, dash, underscore; not starting with a dot. */
const SEGMENT_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

export interface MetaFileInfo {
	path: string;
	chars: number;
	source_chat_id: string | null;
	created_at: string;
	updated_at: string;
}

export interface MetaFile extends MetaFileInfo {
	content: string;
}

export interface MetaUsage {
	files: number;
	chars: number;
}

export interface WriteMetaInput {
	path: string;
	content: string;
	/** Add to the end of the file (creating it if missing) instead of replacing it. */
	append?: boolean;
	source_chat_id: string | null;
}

export interface MetaStore {
	/** Files under `prefix` (a folder path, or all when omitted), by path. */
	list(owner_id: string, prefix?: string): Promise<MetaFileInfo[]>;
	read(owner_id: string, path: string): Promise<MetaFile | undefined>;
	/** Throws `MetaLimitError` when a limit or the path refuses it; nothing is written then. */
	write(owner_id: string, input: WriteMetaInput): Promise<{ file: MetaFileInfo; created: boolean }>;
	/** Undefined when `from` does not exist; throws `MetaLimitError` when `to` does or is invalid. */
	move(owner_id: string, from: string, to: string): Promise<MetaFileInfo | undefined>;
	/** False when there is no such file. */
	remove(owner_id: string, path: string): Promise<boolean>;
	usage(owner_id: string): Promise<MetaUsage>;
}

/** A write a limit or path rule refused. The message is written for the model. */
export class MetaLimitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'MetaLimitError';
	}
}

export const META_SCHEMA_SQL: string[] = [
	`CREATE TABLE IF NOT EXISTS mate_meta_files (
		owner_id TEXT NOT NULL,
		path TEXT NOT NULL,
		content TEXT NOT NULL,
		source_chat_id TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		PRIMARY KEY (owner_id, path)
	)`
];

/**
 * The reason `path` is not a valid meta file path, or undefined when it is:
 * relative, `/`-separated segments of letters, digits, `.`, `_` and `-`, none
 * starting with a dot (so no `..` and no hidden files), bounded in length and
 * depth.
 * @param path Candidate path.
 */
export function metaPathProblem(path: string): string | undefined {
	if (path.length === 0 || path.length > META_PATH_MAX) {
		return `A path is 1 to ${META_PATH_MAX} characters.`;
	}
	const segments = path.split('/');
	if (segments.length > META_PATH_DEPTH) {
		return `A path has at most ${META_PATH_DEPTH} parts.`;
	}
	if (!segments.every((segment) => SEGMENT_PATTERN.test(segment))) {
		return 'A path is relative, like "notes/deploys.md": parts of letters, digits, ".", "_" and "-", separated by "/", none starting with a dot.';
	}
	return undefined;
}

function checkPath(path: string): void {
	const problem = metaPathProblem(path);
	if (problem !== undefined) throw new MetaLimitError(problem);
}

/** A folder prefix as `LIKE` pattern, with wildcards escaped. */
function prefixPattern(prefix: string): string {
	const folder = prefix.replace(/\/+$/, '');
	return `${folder.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`;
}

const INFO_COLUMNS = 'path, length(content) AS chars, source_chat_id, created_at, updated_at';

function toInfo(value: unknown): MetaFileInfo {
	const r = value as Record<string, unknown>;
	return {
		path: String(r.path),
		chars: Number(r.chars ?? 0),
		source_chat_id: typeof r.source_chat_id === 'string' ? r.source_chat_id : null,
		created_at: String(r.created_at),
		updated_at: String(r.updated_at)
	};
}

export function createMetaStore(client: Client, now: () => Date = () => new Date()): MetaStore {
	async function info(owner_id: string, path: string): Promise<MetaFileInfo | undefined> {
		const result = await client.execute({
			sql: `SELECT ${INFO_COLUMNS} FROM mate_meta_files WHERE owner_id = ? AND path = ?`,
			args: [owner_id, path]
		});
		return result.rows[0] === undefined ? undefined : toInfo(result.rows[0]);
	}

	async function usage(owner_id: string): Promise<MetaUsage> {
		const result = await client.execute({
			sql: `SELECT COUNT(*) AS files, COALESCE(SUM(length(content)), 0) AS chars
				FROM mate_meta_files WHERE owner_id = ?`,
			args: [owner_id]
		});
		const r = result.rows[0] as Record<string, unknown> | undefined;
		return { files: Number(r?.files ?? 0), chars: Number(r?.chars ?? 0) };
	}

	return {
		usage,

		async list(owner_id, prefix) {
			const where = ['owner_id = ?'];
			const args: string[] = [owner_id];
			if (prefix !== undefined && prefix.replace(/\/+$/, '') !== '') {
				where.push("path LIKE ? ESCAPE '\\'");
				args.push(prefixPattern(prefix));
			}
			const result = await client.execute({
				sql: `SELECT ${INFO_COLUMNS} FROM mate_meta_files WHERE ${where.join(' AND ')} ORDER BY path`,
				args
			});
			return result.rows.map(toInfo);
		},

		async read(owner_id, path) {
			const result = await client.execute({
				sql: `SELECT ${INFO_COLUMNS}, content FROM mate_meta_files WHERE owner_id = ? AND path = ?`,
				args: [owner_id, path]
			});
			const row = result.rows[0];
			if (row === undefined) return undefined;
			return { ...toInfo(row), content: String((row as Record<string, unknown>).content) };
		},

		async write(owner_id, input) {
			checkPath(input.path);
			const append = input.append === true;
			if (!append && input.content.length > META_FILE_MAX) {
				throw new MetaLimitError(
					`A file is at most ${META_FILE_MAX} characters; this is ${input.content.length}. Split it into several files.`
				);
			}
			const before = await info(owner_id, input.path);
			const stamp = now().toISOString();
			// One statement, so the limits hold against concurrent writes. The
			// new length is checked on insert and, through the upsert's WHERE,
			// on update; the owner's totals in the SELECT's WHERE.
			const result = await client.execute({
				sql: `INSERT INTO mate_meta_files
					(owner_id, path, content, source_chat_id, created_at, updated_at)
					SELECT ?1, ?2, ?3, ?4, ?5, ?5
					WHERE length(?3) <= ?7
					AND (
						EXISTS (SELECT 1 FROM mate_meta_files WHERE owner_id = ?1 AND path = ?2)
						OR (SELECT COUNT(*) FROM mate_meta_files WHERE owner_id = ?1) < ?8
					)
					AND (
						SELECT COALESCE(SUM(length(content)), 0) FROM mate_meta_files WHERE owner_id = ?1
					) + length(?3) - CASE WHEN ?6 THEN 0 ELSE COALESCE(
						(SELECT length(content) FROM mate_meta_files WHERE owner_id = ?1 AND path = ?2), 0
					) END <= ?9
					ON CONFLICT (owner_id, path) DO UPDATE SET
						content = CASE WHEN ?6 THEN content || excluded.content ELSE excluded.content END,
						source_chat_id = excluded.source_chat_id,
						updated_at = excluded.updated_at
					WHERE length(CASE WHEN ?6 THEN content || excluded.content ELSE excluded.content END) <= ?7`,
				args: [
					owner_id,
					input.path,
					input.content,
					input.source_chat_id,
					stamp,
					append ? 1 : 0,
					META_FILE_MAX,
					META_FILES_PER_OWNER,
					META_CHARS_PER_OWNER
				]
			});
			if (result.rowsAffected === 0) {
				const totals = await usage(owner_id);
				const grown = (before?.chars ?? 0) + input.content.length;
				let message: string;
				if (before === undefined && totals.files >= META_FILES_PER_OWNER) {
					message = `The meta folder is full (${META_FILES_PER_OWNER} files). Delete or merge files first.`;
				} else if ((append ? grown : input.content.length) > META_FILE_MAX) {
					message = `A file is at most ${META_FILE_MAX} characters; this write would make it ${
						append ? grown : input.content.length
					}. Start a new file or trim this one.`;
				} else {
					message = `The meta folder is full (${META_CHARS_PER_OWNER} characters in all, ${totals.chars} used). Delete or trim files first.`;
				}
				throw new MetaLimitError(message);
			}
			const file = await info(owner_id, input.path);
			if (file === undefined) throw new Error('meta file vanished after write');
			return { file, created: before === undefined };
		},

		async move(owner_id, from, to) {
			checkPath(to);
			if (from === to) return info(owner_id, from);
			if ((await info(owner_id, to)) !== undefined) {
				throw new MetaLimitError(`"${to}" already exists. Delete it first or pick another path.`);
			}
			try {
				const result = await client.execute({
					sql: `UPDATE mate_meta_files SET path = ?, updated_at = ? WHERE owner_id = ? AND path = ?`,
					args: [to, now().toISOString(), owner_id, from]
				});
				if (result.rowsAffected === 0) return undefined;
			} catch (error) {
				// A concurrent write took `to` between the check and the update.
				if (String(error).includes('UNIQUE')) {
					throw new MetaLimitError(`"${to}" already exists. Delete it first or pick another path.`);
				}
				throw error;
			}
			return info(owner_id, to);
		},

		async remove(owner_id, path) {
			const result = await client.execute({
				sql: 'DELETE FROM mate_meta_files WHERE owner_id = ? AND path = ?',
				args: [owner_id, path]
			});
			return result.rowsAffected > 0;
		}
	};
}
