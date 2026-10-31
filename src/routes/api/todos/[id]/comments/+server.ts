import type { RequestHandler } from './$types';
import { getTodoStore } from '$lib/server/state/db.js';
import { errorFromException, errorResponse, jsonResponse } from '$lib/server/security.js';
import {
	create_todo_comment_schema,
	parseJsonBody,
	parseValue,
	todo_id_schema
} from '$lib/server/validation.js';

/** `GET /api/todos/:id/comments` → `{ comments }`, oldest first. */
export const GET: RequestHandler = async ({ params }) => {
	const id = parseValue(todo_id_schema, params.id);
	if (!id.ok) {
		return id.response;
	}
	try {
		const store = await getTodoStore();
		if ((await store.get(id.data)) === undefined) {
			return errorResponse('not_found', 'todo not found');
		}
		return jsonResponse({ comments: await store.listComments(id.data) });
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};

/** `POST /api/todos/:id/comments` `{ text }` → 201 `{ comment }`; author is the caller's email. */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (locals.user === undefined) {
		return errorResponse('unauthorized', 'session required');
	}
	const id = parseValue(todo_id_schema, params.id);
	if (!id.ok) {
		return id.response;
	}
	const body = await parseJsonBody(request, create_todo_comment_schema);
	if (!body.ok) {
		return body.response;
	}
	try {
		const store = await getTodoStore();
		const comment = await store.addComment(id.data, {
			author: locals.user.email,
			text: body.data.text
		});
		return comment === undefined
			? errorResponse('not_found', 'todo not found')
			: jsonResponse({ comment }, 201);
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};
