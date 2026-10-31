import type { RequestHandler } from './$types';
import { resolveProject } from '$lib/server/discovery.js';
import { getProjectEvents } from '$lib/server/read-model.js';
import { errorFromException, errorResponse, jsonResponse } from '$lib/server/security.js';
import {
	activity_query_schema,
	parseQuery,
	parseValue,
	project_id_schema
} from '$lib/server/validation.js';

export const GET: RequestHandler = async ({ params, url }) => {
	const id = parseValue(project_id_schema, params.id);
	if (!id.ok) {
		return id.response;
	}
	const query = parseQuery(url.searchParams, activity_query_schema);
	if (!query.ok) {
		return query.response;
	}
	try {
		const project = await resolveProject(id.data);
		if (project === undefined) {
			return errorResponse('not_found', 'project not found');
		}
		return jsonResponse({ events: await getProjectEvents(project, query.data.limit) });
	} catch (error) {
		return errorFromException(error);
	}
};
