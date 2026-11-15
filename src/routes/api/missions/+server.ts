import type { RequestHandler } from './$types';
import { listMissions } from '#lib/server/dispatch/service.js';
import { viewerFromLocals } from '#lib/server/grown/grown-api.js';
import { missionProjectNames, missionSurfaceNames } from '#lib/server/mission-names.js';
import { errorFromException, jsonResponse } from '#lib/server/security.js';
import { missions_query_schema, parseQuery } from '#lib/server/validation.js';

export const GET: RequestHandler = async ({ url, locals }) => {
	const query = parseQuery(url.searchParams, missions_query_schema);
	if (!query.ok) {
		return query.response;
	}
	try {
		const [project_names, surface_names] = await Promise.all([
			missionProjectNames(),
			missionSurfaceNames(viewerFromLocals(locals))
		]);
		return jsonResponse({
			missions: await listMissions(query.data, { project_names, surface_names })
		});
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};
