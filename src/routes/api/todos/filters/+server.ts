import type { RequestHandler } from './$types';
import { getStateStore } from '$lib/server/state/db.js';
import { errorFromException, jsonResponse } from '$lib/server/security.js';
import { parseJsonBody, todo_filters_schema } from '$lib/server/validation.js';
import { parseSavedFilters } from '$lib/todos/query.js';

/** Settings key holding the saved searches (JSON name → query). */
const TODO_FILTERS_KEY = 'todos.filters';

/** `GET /api/todos/filters` → `{ filters }`: the list view's saved searches. */
export const GET: RequestHandler = async () => {
	try {
		const store = await getStateStore();
		return jsonResponse({ filters: parseSavedFilters(await store.getSetting(TODO_FILTERS_KEY)) });
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};

/** `PUT /api/todos/filters` with `{ filters }` replaces the saved searches. */
export const PUT: RequestHandler = async ({ request }) => {
	const body = await parseJsonBody(request, todo_filters_schema);
	if (!body.ok) {
		return body.response;
	}
	try {
		const store = await getStateStore();
		await store.setSetting(TODO_FILTERS_KEY, JSON.stringify(body.data.filters));
		return jsonResponse({ filters: body.data.filters });
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};
