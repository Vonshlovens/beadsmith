import type { RequestHandler } from './$types';
import { discoverProjects } from '$lib/server/discovery.js';
import { errorFromException, jsonResponse } from '$lib/server/security.js';

export const GET: RequestHandler = async () => {
	try {
		return jsonResponse({ projects: await discoverProjects() });
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};
