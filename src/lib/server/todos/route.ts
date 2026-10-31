/**
 * Routing a todo to a Beads project. The File payload is
 * built here from the stored todo, so the client can only add an operator
 * note on top of the todo's own content. Launching goes through
 * `enqueueDispatch` (ADR-0006): the same arm, allow and checkout checks and the
 * same durable queue as `POST /api/projects/:id/dispatch`.
 */
import type { Project } from '$lib/types.js';
import { enqueueDispatch, getDispatch, type DispatchDeps } from '../dispatch/service.js';
import type { FilePayload } from '../dispatch/types.js';
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
	input: { todo_id: string; project: Project; actor: string; note?: string },
	deps: DispatchDeps = {}
): Promise<RouteTodoResult> {
	const todo = await store.get(input.todo_id);
	if (todo === undefined) {
		return { kind: 'missing' };
	}

	let previous: string | null = null;
	if (todo.routed_dispatch_id !== null && todo.routed_project_id !== null) {
		const existing = await getDispatch(todo.routed_project_id, todo.routed_dispatch_id, deps);
		const retryable =
			existing === undefined || existing.status === 'failed' || existing.status === 'cancelled';
		if (!retryable) {
			// Already routed and still alive (or finished): a retry routes nothing new.
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
			payload: buildTodoFilePayload(todo, comments, input.note)
		},
		deps
	);
	// A runner may report the bead before this stamp lands, and a concurrent
	// replay stamps the same dispatch: the stamp carries over any reported id.
	const saved = await store.stampRoute(todo.id, input.project.id, result.request.id);
	return { kind: 'routed', todo: saved ?? todo, request: result.request, created: result.created };
}
