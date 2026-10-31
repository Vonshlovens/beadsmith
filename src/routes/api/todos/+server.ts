import type { RequestHandler } from './$types';
import { getTodoStore } from '$lib/server/state/db.js';
import { errorFromException, errorResponse, jsonResponse } from '$lib/server/security.js';
import {
	create_todo_schema,
	parseJsonBody,
	parseQuery,
	todos_query_schema
} from '$lib/server/validation.js';

/**
 * `GET /api/todos?status=open|done|archived|all&tag=&q=&limit=` →
 * `{ todos: Todo[] }`, in manual order (`sort_key`). Urgency is not stored:
 * clients derive it with `$lib/todos/urgency.ts`. Admin-only via the request
 * gate (`requiredPermission`), reads included.
 */
export const GET: RequestHandler = async ({ url }) => {
	const query = parseQuery(url.searchParams, todos_query_schema);
	if (!query.ok) {
		return query.response;
	}
	try {
		const store = await getTodoStore();
		const { status, tag, q, limit } = query.data;
		const todos = await store.list({
			status: status === 'all' ? undefined : status,
			tag,
			q,
			limit
		});
		return jsonResponse({ todos });
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};

/** `POST /api/todos` `{ title, body?, priority?, due_at?, tags?, sort_key? }` → 201 `{ todo }`. */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (locals.user === undefined) {
		return errorResponse('unauthorized', 'session required');
	}
	const body = await parseJsonBody(request, create_todo_schema);
	if (!body.ok) {
		return body.response;
	}
	try {
		const store = await getTodoStore();
		const todo = await store.create({ ...body.data, created_by: locals.user.id });
		return jsonResponse({ todo }, 201);
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};
