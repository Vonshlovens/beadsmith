import type { RequestHandler } from './$types';
import { resolveProject } from '#lib/server/discovery.js';
import { getTodoStore } from '#lib/server/state/db.js';
import { readTodoRoute, routeTodo } from '#lib/server/todos/route.js';
import { errorFromException, errorResponse, jsonResponse } from '#lib/server/security.js';
import {
	parseJsonBody,
	parseValue,
	route_todo_schema,
	todo_id_schema
} from '#lib/server/validation.js';

function actorFromLocals(locals: App.Locals): string {
	const email = (locals.user?.email ?? locals.cloudflare_access?.email)?.trim();
	return email !== undefined && email.length > 0 ? email : 'web';
}

/**
 * `POST /api/todos/:id/route` `{ project_id, notes? }` → `{ todo, request }`.
 * Files the todo into a Beads project through the File dispatch queue
 * (ADR-0006). 201 when it launched, 200 on a replay. Admin-only with the rest
 * of `/api/todos`.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	const id = parseValue(todo_id_schema, params.id);
	if (!id.ok) {
		return id.response;
	}
	const body = await parseJsonBody(request, route_todo_schema);
	if (!body.ok) {
		return body.response;
	}
	try {
		const project = await resolveProject(body.data.project_id);
		if (project === undefined) {
			return errorResponse('not_found', 'project not found');
		}
		const result = await routeTodo(await getTodoStore(), {
			todo_id: id.data,
			project,
			actor: actorFromLocals(locals),
			note: body.data.notes
		});
		if (result.kind === 'missing') {
			return errorResponse('not_found', 'todo not found');
		}
		return jsonResponse({ todo: result.todo, request: result.request }, result.created ? 201 : 200);
	} catch (error) {
		return errorFromException(error);
	}
};

/**
 * `GET /api/todos/:id/route` → `{ todo, request, issue }`: the routed todo with
 * its dispatch refreshed and, once the runner has reported the bead, the bead's
 * status and title, so the card shows mission progress and can offer to
 * complete the todo when the bead closes. `request` and `issue` are null for
 * an unrouted todo; `issue` is also null when Beads cannot be read.
 */
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
		return jsonResponse(await readTodoRoute(store, todo));
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};
