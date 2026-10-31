import type { RequestHandler } from './$types';
import { getTodoStore } from '$lib/server/state/db.js';
import { errorFromException, errorResponse, jsonResponse } from '$lib/server/security.js';
import {
	parseJsonBody,
	parseValue,
	todo_id_schema,
	update_todo_schema
} from '$lib/server/validation.js';

/** `GET /api/todos/:id` → `{ todo, comments }`. */
export const GET: RequestHandler = async ({ params }) => {
	const id = parseValue(todo_id_schema, params.id);
	if (!id.ok) {
		return id.response;
	}
	try {
		const store = await getTodoStore();
		const todo = await store.get(id.data);
		if (todo === undefined) {
			return errorResponse('not_found', 'todo not found');
		}
		return jsonResponse({ todo, comments: await store.listComments(todo.id) });
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};

/**
 * `PATCH /api/todos/:id` with any of `title, body, priority, due_at, tags,
 * status (open|done|archived), sort_key` → `{ todo }`. `status: "done"` stamps
 * `completed_at`; `"open"` clears it. `null` clears `body` and `due_at`.
 */
export const PATCH: RequestHandler = async ({ params, request }) => {
	const id = parseValue(todo_id_schema, params.id);
	if (!id.ok) {
		return id.response;
	}
	const body = await parseJsonBody(request, update_todo_schema);
	if (!body.ok) {
		return body.response;
	}
	try {
		const store = await getTodoStore();
		const todo = await store.update(id.data, body.data);
		return todo === undefined
			? errorResponse('not_found', 'todo not found')
			: jsonResponse({ todo });
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};

/** `DELETE /api/todos/:id` archives the todo (no hard delete) → `{ todo }`. */
export const DELETE: RequestHandler = async ({ params }) => {
	const id = parseValue(todo_id_schema, params.id);
	if (!id.ok) {
		return id.response;
	}
	try {
		const store = await getTodoStore();
		const todo = await store.update(id.data, { status: 'archived' });
		return todo === undefined
			? errorResponse('not_found', 'todo not found')
			: jsonResponse({ todo });
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};
