import type { RequestHandler } from './$types';
import { getConsoleSnapshot } from '$lib/server/console.js';
import { errorFromException, jsonResponse } from '$lib/server/security.js';

export const GET: RequestHandler = async () => {
	try {
		return jsonResponse(await getConsoleSnapshot());
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};
