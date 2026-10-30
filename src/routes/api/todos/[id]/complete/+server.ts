import type { RequestHandler } from './$types';
import { getTodoStore } from '$lib/server/state/db.js';
import { errorFromException, errorResponse, jsonResponse } from '$lib/server/security.js';
import { parseValue, todo_id_schema } from '$lib/server/validation.js';

/** `POST /api/todos/:id/complete` sets status `done` → `{ todo }`. Same as PATCH `status`. */
export const POST: RequestHandler = async ({ params }) => {
	const id = parseValue(todo_id_schema, params.id);
	if (!id.ok) {
		return id.response;
	}
	try {
		const store = await getTodoStore();
		const todo = await store.update(id.data, { status: 'done' });
		return todo === undefined
			? errorResponse('not_found', 'todo not found')
			: jsonResponse({ todo });
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};
