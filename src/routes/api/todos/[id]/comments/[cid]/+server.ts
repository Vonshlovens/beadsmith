import type { RequestHandler } from './$types';
import { getTodoStore } from '$lib/server/state/db.js';
import { errorFromException, errorResponse, jsonResponse } from '$lib/server/security.js';
import { parseValue, todo_comment_id_schema, todo_id_schema } from '$lib/server/validation.js';

/** `DELETE /api/todos/:id/comments/:cid` → `{ deleted: true }`; 404 when the comment is not on that todo. */
export const DELETE: RequestHandler = async ({ params }) => {
	const id = parseValue(todo_id_schema, params.id);
	if (!id.ok) {
		return id.response;
	}
	const cid = parseValue(todo_comment_id_schema, params.cid);
	if (!cid.ok) {
		return cid.response;
	}
	try {
		const store = await getTodoStore();
		return (await store.deleteComment(id.data, cid.data))
			? jsonResponse({ deleted: true })
			: errorResponse('not_found', 'comment not found');
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};
