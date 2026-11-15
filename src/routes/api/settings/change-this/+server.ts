import type { RequestHandler } from './$types';
import { changeThisProjectId, setChangeThisProjectId } from '#lib/server/change-this.js';
import { resolveProject } from '#lib/server/discovery.js';
import { getStateStore } from '#lib/server/state/db.js';
import { errorFromException, errorResponse, jsonResponse } from '#lib/server/security.js';
import { change_this_setting_schema, parseJsonBody } from '#lib/server/validation.js';

/**
 * The project "Change this" files into (ADR-0025 rule 10). Reading it is
 * harmless; writing it is admin-only through the request gate (an unlisted
 * mutation needs `console:manage`, `requiredPermission` in roles.ts). The
 * launch itself is an ordinary File, so arm and allow are checked there.
 */
export const GET: RequestHandler = async () => {
	try {
		return jsonResponse({ project_id: await changeThisProjectId(await getStateStore()) });
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};

export const PUT: RequestHandler = async ({ request }) => {
	const parsed = await parseJsonBody(request, change_this_setting_schema);
	if (!parsed.ok) {
		return parsed.response;
	}
	try {
		const { project_id } = parsed.data;
		if (project_id !== null && (await resolveProject(project_id)) === undefined) {
			return errorResponse('not_found', 'project not found');
		}
		await setChangeThisProjectId(await getStateStore(), project_id);
		return jsonResponse({ project_id });
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};
