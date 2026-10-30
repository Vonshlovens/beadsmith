/**
 * Admin todo list in `state.db` (ADR-0004). Application-owned
 * rows, not Beads issues: a routed todo keeps only the project id, dispatch
 * request id and, once the agent reports it, the issue id. Urgency is derived
 * (`$lib/todos/urgency.ts`) and never stored.
 */
import type { Client } from '@libsql/client';
import { randomBytes } from 'node:crypto';

export const TODO_STATUSES = ['open', 'done', 'archived'] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface Todo {
	id: string;
	title: string;
	body: string | null;
	/** P0 (most urgent) to P4. */
	priority: number;
	/** ISO date (`2026-10-31`) or datetime. */
	due_at: string | null;
	/** `+project` / `@context` style strings. */
	tags: string[];
	status: TodoStatus;
	completed_at: string | null;
	/** Manual order within ties; lower first. */
	sort_key: number;
	routed_project_id: string | null;
	routed_dispatch_id: string | null;
	routed_issue_id: string | null;
	created_by: string;
	created_at: string;
	updated_at: string;
	/** Derived on read from `todo_comments`; not a column. */
	comment_count: number;
}

export interface TodoComment {
	id: string;
	todo_id: string;
	author: string;
	text: string;
	created_at: string;
}

export interface CreateTodoInput {
	title: string;
	body?: string | null;
	priority?: number;
	due_at?: string | null;
	tags?: string[];
	sort_key?: number;
	created_by: string;
}

/** Fields `update` may change. Setting `status` also maintains `completed_at`. */
export interface UpdateTodoInput {
	title?: string;
	body?: string | null;
	priority?: number;
	due_at?: string | null;
	tags?: string[];
	status?: TodoStatus;
	sort_key?: number;
	routed_project_id?: string | null;
	routed_dispatch_id?: string | null;
	routed_issue_id?: string | null;
}

export interface ListTodosFilter {
	/** Omit for every status. */
	status?: TodoStatus;
	tag?: string;
	/** Case-insensitive substring of title or body. */
	q?: string;
	limit: number;
}

export interface TodoStore {
	list(filter: ListTodosFilter): Promise<Todo[]>;
	get(id: string): Promise<Todo | undefined>;
	create(input: CreateTodoInput): Promise<Todo>;
	/** Undefined when the todo does not exist. */
	update(id: string, patch: UpdateTodoInput): Promise<Todo | undefined>;
	listComments(todo_id: string): Promise<TodoComment[]>;
	/**
	 * Record the bead a routed dispatch created, durably per dispatch, and set
	 * `routed_issue_id` where it is still empty; false when no todo is stamped
	 * with that dispatch yet (routing picks the id up when it stamps one).
	 */
	linkRoutedIssue(dispatch_id: string, issue_id: string): Promise<boolean>;
	/**
	 * Stamp a todo with the dispatch that routes it. One statement, so a bead id
	 * the runner already reported for that dispatch is carried over atomically.
	 * Undefined when the todo does not exist.
	 */
	stampRoute(todo_id: string, project_id: string, dispatch_id: string): Promise<Todo | undefined>;
	/** Undefined when the todo does not exist. */
	addComment(
		todo_id: string,
		input: { author: string; text: string }
	): Promise<TodoComment | undefined>;
	/** False when no such comment exists on that todo. */
	deleteComment(todo_id: string, comment_id: string): Promise<boolean>;
}

export const TODO_SCHEMA_SQL: string[] = [
	`CREATE TABLE IF NOT EXISTS todos (
		id TEXT PRIMARY KEY,
		title TEXT NOT NULL,
		body TEXT,
		priority INTEGER NOT NULL DEFAULT 2,
		due_at TEXT,
		tags TEXT NOT NULL DEFAULT '[]',
		status TEXT NOT NULL DEFAULT 'open',
		completed_at TEXT,
		sort_key REAL NOT NULL DEFAULT 0,
		routed_project_id TEXT,
		routed_dispatch_id TEXT,
		routed_issue_id TEXT,
		created_by TEXT NOT NULL,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`,
	'CREATE INDEX IF NOT EXISTS todos_status_due ON todos (status, due_at)',
	`CREATE TABLE IF NOT EXISTS todo_comments (
		id TEXT PRIMARY KEY,
		todo_id TEXT NOT NULL,
		author TEXT NOT NULL,
		text TEXT NOT NULL,
		created_at TEXT NOT NULL
	)`,
	'CREATE INDEX IF NOT EXISTS todo_comments_todo ON todo_comments (todo_id, created_at)',
	// Bead ids runners reported per routing dispatch, kept apart from `todos` so a
	// report that lands before the todo is stamped with its dispatch is not lost.
	`CREATE TABLE IF NOT EXISTS todo_route_issues (
		dispatch_id TEXT PRIMARY KEY,
		issue_id TEXT NOT NULL,
		reported_at TEXT NOT NULL
	)`
];

const TODO_COLUMNS = `id, title, body, priority, due_at, tags, status, completed_at, sort_key,
	routed_project_id, routed_dispatch_id, routed_issue_id, created_by, created_at, updated_at,
	(SELECT COUNT(*) FROM todo_comments WHERE todo_comments.todo_id = todos.id) AS comment_count`;

function row(value: unknown): Record<string, unknown> {
	return value as Record<string, unknown>;
}

function optText(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseTags(raw: unknown): string[] {
	if (typeof raw !== 'string') {
		return [];
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
	} catch {
		return [];
	}
}

function toTodo(value: unknown): Todo {
	const r = row(value);
	const status = TODO_STATUSES.find((s) => s === r.status) ?? 'open';
	return {
		id: String(r.id),
		title: String(r.title),
		body: optText(r.body),
		priority: Number(r.priority),
		due_at: optText(r.due_at),
		tags: parseTags(r.tags),
		status,
		completed_at: optText(r.completed_at),
		sort_key: Number(r.sort_key),
		routed_project_id: optText(r.routed_project_id),
		routed_dispatch_id: optText(r.routed_dispatch_id),
		routed_issue_id: optText(r.routed_issue_id),
		created_by: String(r.created_by),
		created_at: String(r.created_at),
		updated_at: String(r.updated_at),
		comment_count: Number(r.comment_count ?? 0)
	};
}

function toComment(value: unknown): TodoComment {
	const r = row(value);
	return {
		id: String(r.id),
		todo_id: String(r.todo_id),
		author: String(r.author),
		text: String(r.text),
		created_at: String(r.created_at)
	};
}

/** Escape LIKE wildcards so `q` is a literal substring. */
function likePattern(q: string): string {
	return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function createTodoStore(client: Client, now: () => Date = () => new Date()): TodoStore {
	async function get(id: string): Promise<Todo | undefined> {
		const result = await client.execute({
			sql: `SELECT ${TODO_COLUMNS} FROM todos WHERE id = ?`,
			args: [id]
		});
		return result.rows[0] === undefined ? undefined : toTodo(result.rows[0]);
	}

	return {
		get,

		async list(filter) {
			const where: string[] = [];
			const args: (string | number)[] = [];
			if (filter.status !== undefined) {
				where.push('status = ?');
				args.push(filter.status);
			}
			if (filter.tag !== undefined) {
				where.push('EXISTS (SELECT 1 FROM json_each(todos.tags) WHERE value = ?)');
				args.push(filter.tag);
			}
			if (filter.q !== undefined && filter.q !== '') {
				where.push(
					"(title LIKE ? ESCAPE '\\' COLLATE NOCASE OR body LIKE ? ESCAPE '\\' COLLATE NOCASE)"
				);
				const pattern = likePattern(filter.q);
				args.push(pattern, pattern);
			}
			args.push(filter.limit);
			const result = await client.execute({
				sql: `SELECT ${TODO_COLUMNS} FROM todos
					${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
					ORDER BY sort_key, created_at, id LIMIT ?`,
				args
			});
			return result.rows.map(toTodo);
		},

		async create(input) {
			const stamp = now().toISOString();
			let sort_key = input.sort_key;
			if (sort_key === undefined) {
				const max = await client.execute('SELECT COALESCE(MAX(sort_key), 0) AS max FROM todos');
				sort_key = Number(row(max.rows[0]).max ?? 0) + 1;
			}
			const id = `td_${randomBytes(12).toString('hex')}`;
			await client.execute({
				sql: `INSERT INTO todos (id, title, body, priority, due_at, tags, status, sort_key,
					created_by, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
				args: [
					id,
					input.title,
					input.body ?? null,
					input.priority ?? 2,
					input.due_at ?? null,
					JSON.stringify(input.tags ?? []),
					sort_key,
					input.created_by,
					stamp,
					stamp
				]
			});
			const created = await get(id);
			if (created === undefined) {
				throw new Error('todo vanished after insert');
			}
			return created;
		},

		async update(id, patch) {
			const sets: string[] = [];
			const args: (string | number | null)[] = [];
			const set = (column: string, value: string | number | null) => {
				sets.push(`${column} = ?`);
				args.push(value);
			};
			if (patch.title !== undefined) set('title', patch.title);
			if (patch.body !== undefined) set('body', patch.body);
			if (patch.priority !== undefined) set('priority', patch.priority);
			if (patch.due_at !== undefined) set('due_at', patch.due_at);
			if (patch.tags !== undefined) set('tags', JSON.stringify(patch.tags));
			if (patch.sort_key !== undefined) set('sort_key', patch.sort_key);
			if (patch.routed_project_id !== undefined) set('routed_project_id', patch.routed_project_id);
			if (patch.routed_dispatch_id !== undefined) {
				set('routed_dispatch_id', patch.routed_dispatch_id);
			}
			if (patch.routed_issue_id !== undefined) set('routed_issue_id', patch.routed_issue_id);
			const stamp = now().toISOString();
			if (patch.status !== undefined) {
				set('status', patch.status);
				// Archiving keeps whatever completion time the row already had.
				if (patch.status === 'done') {
					sets.push('completed_at = COALESCE(completed_at, ?)');
					args.push(stamp);
				} else if (patch.status === 'open') {
					set('completed_at', null);
				}
			}
			set('updated_at', stamp);
			args.push(id);
			const result = await client.execute({
				sql: `UPDATE todos SET ${sets.join(', ')} WHERE id = ?`,
				args
			});
			return result.rowsAffected === 0 ? undefined : get(id);
		},

		async stampRoute(todo_id, project_id, dispatch_id) {
			const result = await client.execute({
				sql: `UPDATE todos SET routed_project_id = ?, routed_dispatch_id = ?,
					routed_issue_id = (SELECT issue_id FROM todo_route_issues WHERE dispatch_id = ?),
					updated_at = ?
					WHERE id = ?`,
				args: [project_id, dispatch_id, dispatch_id, now().toISOString(), todo_id]
			});
			return result.rowsAffected === 0 ? undefined : get(todo_id);
		},

		async linkRoutedIssue(dispatch_id, issue_id) {
			const stamp = now().toISOString();
			// The first report wins, as on the todo row.
			await client.execute({
				sql: `INSERT INTO todo_route_issues (dispatch_id, issue_id, reported_at) VALUES (?, ?, ?)
					ON CONFLICT (dispatch_id) DO NOTHING`,
				args: [dispatch_id, issue_id, stamp]
			});
			const result = await client.execute({
				sql: `UPDATE todos SET routed_issue_id = ?, updated_at = ?
					WHERE routed_dispatch_id = ? AND routed_issue_id IS NULL`,
				args: [issue_id, stamp, dispatch_id]
			});
			return result.rowsAffected > 0;
		},

		async listComments(todo_id) {
			const result = await client.execute({
				sql: `SELECT id, todo_id, author, text, created_at FROM todo_comments
					WHERE todo_id = ? ORDER BY created_at, id`,
				args: [todo_id]
			});
			return result.rows.map(toComment);
		},

		async addComment(todo_id, input) {
			if ((await get(todo_id)) === undefined) {
				return undefined;
			}
			const id = `tc_${randomBytes(12).toString('hex')}`;
			const created_at = now().toISOString();
			await client.execute({
				sql: 'INSERT INTO todo_comments (id, todo_id, author, text, created_at) VALUES (?, ?, ?, ?, ?)',
				args: [id, todo_id, input.author, input.text, created_at]
			});
			return { id, todo_id, author: input.author, text: input.text, created_at };
		},

		async deleteComment(todo_id, comment_id) {
			const result = await client.execute({
				sql: 'DELETE FROM todo_comments WHERE id = ? AND todo_id = ?',
				args: [comment_id, todo_id]
			});
			return result.rowsAffected > 0;
		}
	};
}
