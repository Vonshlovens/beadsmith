import type { RequestHandler } from './$types';
import { resolveProject } from '$lib/server/discovery.js';
import { cancelDispatch } from '$lib/server/dispatch/service.js';
import { errorFromException, errorResponse, jsonResponse } from '$lib/server/security.js';
import {
	dispatch_request_id_schema,
	parseValue,
	project_id_schema
} from '$lib/server/validation.js';

export const POST: RequestHandler = async ({ params }) => {
	const id = parseValue(project_id_schema, params.id);
	if (!id.ok) {
		return id.response;
	}
	const request_id = parseValue(dispatch_request_id_schema, params.requestId);
	if (!request_id.ok) {
		return request_id.response;
	}

	try {
		const project = await resolveProject(id.data);
		if (project === undefined) {
			return errorResponse('not_found', 'project not found');
		}
		const record = await cancelDispatch(project.id, request_id.data);
		if (record === undefined) {
			return errorResponse('not_found', 'dispatch request not found');
		}
		return jsonResponse({ request: record });
	} catch (error) {
		return errorFromException(error);
	}
};
