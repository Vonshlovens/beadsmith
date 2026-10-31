import type { RequestHandler } from './$types';
import { resolveProject } from '$lib/server/discovery.js';
import { enqueueDispatch } from '$lib/server/dispatch/service.js';
import { getProjectIssue } from '$lib/server/read-model.js';
import { errorFromException, errorResponse, jsonResponse } from '$lib/server/security.js';
import {
	dispatch_schema,
	parseJsonBody,
	parseValue,
	project_id_schema
} from '$lib/server/validation.js';

function actorFromLocals(locals: App.Locals): string {
	const email = (locals.user?.email ?? locals.cloudflare_access?.email)?.trim();
	return email !== undefined && email.length > 0 ? email : 'web';
}

export const POST: RequestHandler = async ({ params, request, locals }) => {
	const id = parseValue(project_id_schema, params.id);
	if (!id.ok) {
		return id.response;
	}
	const body = await parseJsonBody(request, dispatch_schema);
	if (!body.ok) {
		return body.response;
	}

	try {
		const project = await resolveProject(id.data);
		if (project === undefined) {
			return errorResponse('not_found', 'project not found');
		}

		if (body.data.operation === 'file') {
			const result = await enqueueDispatch({
				idempotency_key: body.data.idempotency_key,
				project,
				actor: actorFromLocals(locals),
				payload: {
					operation: 'file',
					notes: body.data.notes,
					title: body.data.title,
					issue_type: body.data.issue_type,
					priority: body.data.priority,
					labels: body.data.labels,
					...(body.data.status !== undefined && body.data.status !== 'open'
						? { status: body.data.status }
						: {})
				}
			});
			return jsonResponse({ request: result.request }, result.created ? 201 : 200);
		}

		const issue_result = await getProjectIssue(project, body.data.issue_id);
		if (issue_result === undefined) {
			return errorResponse('not_found', 'issue not found');
		}

		if (body.data.operation === 'discuss') {
			const result = await enqueueDispatch({
				idempotency_key: body.data.idempotency_key,
				project,
				actor: actorFromLocals(locals),
				payload: {
					operation: 'discuss',
					issue_id: body.data.issue_id,
					intent: body.data.intent,
					...(body.data.message === undefined ? {} : { message: body.data.message })
				},
				issue: issue_result.issue
			});
			return jsonResponse({ request: result.request }, result.created ? 201 : 200);
		}

		if (body.data.operation === 'comment') {
			const actor = actorFromLocals(locals);
			const result = await enqueueDispatch({
				idempotency_key: body.data.idempotency_key,
				project,
				actor,
				payload: {
					operation: 'comment',
					issue_id: body.data.issue_id,
					text: body.data.text,
					author: actor
				},
				issue: issue_result.issue
			});
			return jsonResponse({ request: result.request }, result.created ? 201 : 200);
		}

		const result = await enqueueDispatch({
			idempotency_key: body.data.idempotency_key,
			project,
			actor: actorFromLocals(locals),
			payload: {
				operation: 'tackle',
				issue_id: body.data.issue_id,
				destination_status: body.data.destination_status
			},
			issue: issue_result.issue
		});
		return jsonResponse({ request: result.request }, result.created ? 201 : 200);
	} catch (error) {
		return errorFromException(error);
	}
};
