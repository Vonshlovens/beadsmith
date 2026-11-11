import type { RequestHandler } from './$types';
import type { LoopIterationsResponse } from '#lib/types.js';
import { resolveProject } from '#lib/server/discovery.js';
import { listLoopIterations } from '#lib/server/dispatch/service.js';
import { errorFromException, errorResponse, jsonResponse } from '#lib/server/security.js';
import {
	dispatch_request_id_schema,
	parseValue,
	project_id_schema
} from '#lib/server/validation.js';

/** A loop mission's finished iterations; empty for any other mission (ADR-0019 rule 5). */
export const GET: RequestHandler = async ({ params }) => {
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
		const iterations = await listLoopIterations(project.id, request_id.data);
		if (iterations === undefined) {
			return errorResponse('not_found', 'dispatch request not found');
		}
		return jsonResponse({ iterations } satisfies LoopIterationsResponse);
	} catch (error) {
		return errorFromException(error);
	}
};
