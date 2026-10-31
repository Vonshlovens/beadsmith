import type { RequestHandler } from './$types';
import { discoverProjects, invalidateDiscovery } from '$lib/server/discovery.js';
import { errorFromException, jsonResponse } from '$lib/server/security.js';

export const POST: RequestHandler = async () => {
	try {
		invalidateDiscovery();
		return jsonResponse({ projects: await discoverProjects({ force: true }) });
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};
