import type { RequestHandler } from './$types';
import { resolveProject } from '$lib/server/discovery.js';
import { getDispatchPolicyStore } from '$lib/server/state/db.js';
import { errorFromException, errorResponse, jsonResponse } from '$lib/server/security.js';
import {
	dispatch_allow_schema,
	parseJsonBody,
	parseValue,
	project_id_schema
} from '$lib/server/validation.js';

export const PUT: RequestHandler = async ({ params, request }) => {
	const id = parseValue(project_id_schema, params.id);
	if (!id.ok) {
		return id.response;
	}
	const body = await parseJsonBody(request, dispatch_allow_schema);
	if (!body.ok) {
		return body.response;
	}

	try {
		const project = await resolveProject(id.data);
		if (project === undefined) {
			return errorResponse('not_found', 'project not found');
		}
		const store = await getDispatchPolicyStore();
		const allow = { file: body.data.file, tackle: body.data.tackle };
		await store.putAllow(id.data, allow);
		return jsonResponse({ project_id: id.data, allow });
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};
