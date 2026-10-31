import type { RequestHandler } from './$types';
import { discoverProjects } from '$lib/server/discovery.js';
import { getMergedReadyIssues } from '$lib/server/read-model.js';
import { errorFromException, jsonResponse } from '$lib/server/security.js';
import { activity_query_schema, parseQuery } from '$lib/server/validation.js';

export const GET: RequestHandler = async ({ url }) => {
	const query = parseQuery(url.searchParams, activity_query_schema);
	if (!query.ok) {
		return query.response;
	}
	try {
		const projects = await discoverProjects();
		return jsonResponse(await getMergedReadyIssues(projects, query.data.limit));
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};
