import type { RequestHandler } from './$types';
import { resolveProject } from '#lib/server/discovery.js';
import { launchPayload, payloadIssueId } from '#lib/server/dispatch/payload.js';
import { enqueueDispatch } from '#lib/server/dispatch/service.js';
import { getProjectIssue } from '#lib/server/read-model.js';
import { errorFromException, errorResponse, jsonResponse } from '#lib/server/security.js';
import {
	dispatch_schema,
	parseJsonBody,
	parseValue,
	project_id_schema
} from '#lib/server/validation.js';

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

		const { idempotency_key, provider, ...fields } = body.data;
		const actor = actorFromLocals(locals);
		const payload = launchPayload(fields, actor);
		// A launch on a bead must name a real one; File and a plan loop name none.
		const issue_id = payloadIssueId(payload);
		const issue =
			issue_id === undefined ? undefined : (await getProjectIssue(project, issue_id))?.issue;
		if (issue_id !== undefined && issue === undefined) {
			return errorResponse('not_found', 'issue not found');
		}

		const result = await enqueueDispatch({
			idempotency_key,
			project,
			provider,
			actor,
			payload,
			...(issue === undefined ? {} : { issue })
		});
		return jsonResponse({ request: result.request }, result.created ? 201 : 200);
	} catch (error) {
		return errorFromException(error);
	}
};
