import type { RequestHandler } from './$types';
import { getStatus, statusForViewer } from '$lib/server/status.js';
import { errorFromException, jsonResponse } from '$lib/server/security.js';

export const GET: RequestHandler = async ({ locals }) => {
	try {
		return jsonResponse(statusForViewer(await getStatus(), locals.role));
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};
