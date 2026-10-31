import type { RequestHandler } from './$types';
import { resolveProject } from '$lib/server/discovery.js';
import { getDispatch } from '$lib/server/dispatch/service.js';
import { getTodoStore } from '$lib/server/state/db.js';
import { routeTodo } from '$lib/server/todos/route.js';
import { errorFromException, errorResponse, jsonResponse } from '$lib/server/security.js';
import {
	parseJsonBody,
	parseValue,
	route_todo_schema,
	todo_id_schema
} from '$lib/server/validation.js';

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
 * `GET /api/todos/:id/route` → `{ todo, request }`: the routed todo with its
 * dispatch refreshed, so the card shows mission status and, once the runner
 * has reported the bead, its id. `request` is null for an unrouted todo.
 */
export const GET: RequestHandler = async ({ params }) => {
	const id = parseValue(todo_id_schema, params.id);
	if (!id.ok) {
		return id.response;
	}
	try {
		const store = await getTodoStore();
		const first = await store.get(id.data);
		if (first === undefined) {
			return errorResponse('not_found', 'todo not found');
		}
		if (first.routed_project_id === null || first.routed_dispatch_id === null) {
			return jsonResponse({ todo: first, request: null });
		}
		const request = (await getDispatch(first.routed_project_id, first.routed_dispatch_id)) ?? null;
		// getDispatch persists a newly reported issue id; read the todo again to pick it up.
		const todo = (await store.get(id.data)) ?? first;
		return jsonResponse({ todo, request });
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};
