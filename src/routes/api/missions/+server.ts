import type { RequestHandler } from './$types';
import { discoverProjects } from '$lib/server/discovery.js';
import { listMissions } from '$lib/server/dispatch/service.js';
import { errorFromException, jsonResponse } from '$lib/server/security.js';
import { missions_query_schema, parseQuery } from '$lib/server/validation.js';

async function projectNames(): Promise<Map<string, string>> {
	try {
		const projects = await discoverProjects();
		return new Map(projects.map((project) => [project.id, project.name]));
	} catch {
		/* Missions live in SQLite; a Dolt outage must not hide the fleet. */
		return new Map();
	}
}

export const GET: RequestHandler = async ({ url }) => {
	const query = parseQuery(url.searchParams, missions_query_schema);
	if (!query.ok) {
		return query.response;
	}
	try {
		return jsonResponse({
			missions: await listMissions(query.data, { project_names: await projectNames() })
		});
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};
