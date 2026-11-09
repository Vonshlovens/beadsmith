/**
 * Routing a todo to a Beads project. The File payload is
 * built here from the stored todo, so the client can only add an operator
 * note on top of the todo's own content. Launching goes through
 * `enqueueDispatch` (ADR-0006): the same arm, allow and checkout checks and the
 * same durable queue as `POST /api/projects/:id/dispatch`.
 */
import type { Project } from '#lib/types.js';
import { canRouteTodo, todoRouteState, type RouteIssue } from '#lib/todos/route-state.js';
import { resolveProject } from '../discovery.js';
import { enqueueDispatch, getDispatch, type DispatchDeps } from '../dispatch/service.js';
import type { FilePayload } from '../dispatch/types.js';
import { getProjectIssue, type ReadDeps } from '../read-model.js';
import { LABEL_PATTERN } from '../validation.js';
import type { Todo, TodoComment, TodoStore } from './store.js';

export const ROUTE_NOTES_MAX = 8000;
const ROUTE_LABELS_MAX = 8;
const ROUTE_TITLE_MAX = 200;

/** `+beadsmith` / `@home` → `beadsmith` / `home`, if a valid Beads label results. */
export function tagToLabel(tag: string): string | undefined {
	const name = tag.replace(/^[+@]/, '');
	return LABEL_PATTERN.test(name) ? name : undefined;
}

/**
 * The File payload for a todo: title and priority carry over 1:1, tags become
 * labels, and body plus comments (and the operator's note) become the notes.
 */
export function buildTodoFilePayload(
	todo: Pick<Todo, 'id' | 'title' | 'body' | 'priority' | 'tags' | 'due_at'>,
	comments: readonly Pick<TodoComment, 'author' | 'text' | 'created_at'>[],
	note?: string
): FilePayload {
	const parts: string[] = [];
	const operator = note?.trim();
	if (operator) {
		parts.push(operator);
	}
	const body = todo.body?.trim();
	if (body) {
		parts.push(body);
	}
	if (todo.due_at) {
		parts.push(`Due: ${todo.due_at}`);
	}
	if (comments.length > 0) {
		parts.push(
			'Comments:\n' +
				comments
					.map(
						(comment) => `- ${comment.author} (${comment.created_at.slice(0, 10)}): ${comment.text}`
					)
					.join('\n')
		);
	}
	const footer = `Routed from admin todo ${todo.id}.`;
	let notes = [todo.title, ...parts, footer].join('\n\n');
	if (notes.length > ROUTE_NOTES_MAX) {
		notes = `${notes.slice(0, ROUTE_NOTES_MAX - footer.length - 6).trimEnd()}…\n\n${footer}`;
	}
	const labels = [...new Set(todo.tags.map(tagToLabel).filter((l) => l !== undefined))].slice(
		0,
		ROUTE_LABELS_MAX
	);
	return {
		operation: 'file',
		notes,
		title: todo.title.slice(0, ROUTE_TITLE_MAX),
		priority: todo.priority,
		...(labels.length > 0 ? { labels } : {})
	};
}

/**
 * Deterministic key: first attempt keys on the todo alone; a retry after a
 * failed or cancelled dispatch keys on that dispatch, so each attempt is one
 * dispatch and a double click replays the same record.
 */
export function routeIdempotencyKey(todo_id: string, previous_dispatch_id: string | null): string {
	return `todo-route:${todo_id}:${previous_dispatch_id ?? 'first'}`;
}

export type RouteTodoResult =
	| {
			kind: 'routed';
			todo: Todo;
			request: Awaited<ReturnType<typeof getDispatch>>;
			created: boolean;
	  }
	| { kind: 'missing' };

/** Route (or replay the routing of) one todo. Throws `DispatchError` on policy refusal. */
export async function routeTodo(
	store: TodoStore,
	input: {
		todo_id: string;
		project: Project;
		actor: string;
		note?: string;
		/** First Mate chat routing it through a crew tool. */
		chat_id?: string;
	},
	deps: DispatchDeps = {}
): Promise<RouteTodoResult> {
	const todo = await store.get(input.todo_id);
	if (todo === undefined) {
		return { kind: 'missing' };
	}

	let previous: string | null = null;
	if (todo.routed_dispatch_id !== null && todo.routed_project_id !== null) {
		const existing = await getDispatch(todo.routed_project_id, todo.routed_dispatch_id, deps);
		if (!canRouteTodo(todoRouteState(todo, existing ?? null))) {
			// Still alive, finished or already filed: a retry routes nothing new.
			return { kind: 'routed', todo, request: existing, created: false };
		}
		previous = todo.routed_dispatch_id;
	}

	const comments = await store.listComments(todo.id);
	const result = await enqueueDispatch(
		{
			idempotency_key: routeIdempotencyKey(todo.id, previous),
			project: input.project,
			actor: input.actor,
			payload: buildTodoFilePayload(todo, comments, input.note),
			...(input.chat_id === undefined ? {} : { chat_id: input.chat_id })
		},
		deps
	);
	// A runner may report the bead before this stamp lands, and a concurrent
	// replay stamps the same dispatch: the stamp carries over any reported id.
	const saved = await store.stampRoute(todo.id, input.project.id, result.request.id);
	return { kind: 'routed', todo: saved ?? todo, request: result.request, created: result.created };
}

export interface TodoRouteReadDeps {
	dispatch?: DispatchDeps;
	read?: ReadDeps;
	/** Project lookup by id; defaults to discovery. */
	project?: (id: string) => Promise<Project | undefined>;
}

export interface TodoRouteRead {
	todo: Todo;
	/** The routing mission, refreshed; null when unrouted or the mission is gone. */
	request: Awaited<ReturnType<typeof getDispatch>> | null;
	/** The filed bead; null before one is reported or when Beads cannot be read. */
	issue: RouteIssue | null;
}

/**
 * A todo with its routing read live: the mission (refreshed, which also
 * records a bead id the runner reported) and, once filed, the bead's status,
 * so a closed bead can offer to complete the todo. Shared by
 * `GET /api/todos/:id/route` and the crew `list_todos` tool.
 */
export async function readTodoRoute(
	store: TodoStore,
	todo: Todo,
	deps: TodoRouteReadDeps = {}
): Promise<TodoRouteRead> {
	if (todo.routed_project_id === null || todo.routed_dispatch_id === null) {
		return { todo, request: null, issue: null };
	}
	const project_id = todo.routed_project_id;
	const request = (await getDispatch(project_id, todo.routed_dispatch_id, deps.dispatch)) ?? null;
	// getDispatch persists a newly reported issue id; read the todo again to pick it up.
	const current = (await store.get(todo.id)) ?? todo;
	if (current.routed_issue_id === null) {
		return { todo: current, request, issue: null };
	}
	let issue: RouteIssue | null = null;
	try {
		const project = await (deps.project ?? resolveProject)(project_id);
		const detail =
			project === undefined
				? undefined
				: await getProjectIssue(project, current.routed_issue_id, deps.read);
		if (detail !== undefined) {
			issue = { status: detail.issue.status, title: detail.issue.title };
		}
	} catch {
		// The bead is supplementary: an unreadable Beads leaves its status unknown.
	}
	return { todo: current, request, issue };
}
