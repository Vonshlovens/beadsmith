import type { RequestHandler } from './$types';
import { resolveProject } from '#lib/server/discovery.js';
import { steerDispatch } from '#lib/server/dispatch/service.js';
import { errorFromException, errorResponse, jsonResponse } from '#lib/server/security.js';
import {
	dispatch_request_id_schema,
	steer_schema,
	parseJsonBody,
	parseValue,
	project_id_schema
} from '#lib/server/validation.js';

export const POST: RequestHandler = async ({ params, request }) => {
	const id = parseValue(project_id_schema, params.id);
	if (!id.ok) {
		return id.response;
	}
	const request_id = parseValue(dispatch_request_id_schema, params.requestId);
	if (!request_id.ok) {
		return request_id.response;
	}
	const body = await parseJsonBody(request, steer_schema);
	if (!body.ok) {
		return body.response;
	}

	try {
		const project = await resolveProject(id.data);
		if (project === undefined) {
			return errorResponse('not_found', 'project not found');
		}
		const record = await steerDispatch(project.id, request_id.data, body.data.text);
		if (record === undefined) {
			return errorResponse('not_found', 'dispatch request not found');
		}
		return jsonResponse({ request: record });
	} catch (error) {
		return errorFromException(error);
	}
};
