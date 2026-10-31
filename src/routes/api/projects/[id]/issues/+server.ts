import type { RequestHandler } from './$types';
import { resolveProject } from '$lib/server/discovery.js';
import { listProjectIssues } from '$lib/server/read-model.js';
import { errorFromException, errorResponse, jsonResponse } from '$lib/server/security.js';
import {
	list_query_schema,
	parseQuery,
	parseValue,
	project_id_schema
} from '$lib/server/validation.js';

export const GET: RequestHandler = async ({ params, url }) => {
	const id = parseValue(project_id_schema, params.id);
	if (!id.ok) {
		return id.response;
	}
	const query = parseQuery(url.searchParams, list_query_schema);
	if (!query.ok) {
		return query.response;
	}
	try {
		const project = await resolveProject(id.data);
		if (project === undefined) {
			return errorResponse('not_found', 'project not found');
		}
		return jsonResponse(await listProjectIssues(project, query.data));
	} catch (error) {
		return errorFromException(error);
	}
};
