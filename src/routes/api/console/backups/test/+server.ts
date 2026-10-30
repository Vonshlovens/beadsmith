import type { RequestHandler } from './$types';
import { getBackupStore } from '$lib/server/state/db.js';
import { publicBackupError, testBackupDestination } from '$lib/server/backup/service.js';
import { errorResponse, jsonResponse } from '$lib/server/security.js';

/** Write and delete a probe object with the saved settings. */
export const POST: RequestHandler = async () => {
	try {
		await testBackupDestination({ store: await getBackupStore() });
		return jsonResponse({ ok: true });
	} catch (error) {
		return errorResponse('unavailable', publicBackupError(error));
	}
};
