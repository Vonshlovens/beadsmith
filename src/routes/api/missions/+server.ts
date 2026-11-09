import type { RequestHandler } from './$types';
import { listMissions } from '#lib/server/dispatch/service.js';
import { missionProjectNames } from '#lib/server/mission-names.js';
import { errorFromException, jsonResponse } from '#lib/server/security.js';
import { missions_query_schema, parseQuery } from '#lib/server/validation.js';

export const GET: RequestHandler = async ({ url }) => {
	const query = parseQuery(url.searchParams, missions_query_schema);
	if (!query.ok) {
		return query.response;
	}
	try {
		return jsonResponse({
			missions: await listMissions(query.data, { project_names: await missionProjectNames() })
		});
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};
