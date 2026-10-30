import type { RequestHandler } from './$types';
import { getBackupStore } from '$lib/server/state/db.js';
import { isBackupRunning } from '$lib/server/backup/service.js';
import { getSecretBox } from '$lib/server/secret-box.js';
import { errorFromException, errorResponse, jsonResponse } from '$lib/server/security.js';
import { backup_settings_schema, parseJsonBody } from '$lib/server/validation.js';

/** Settings view (never secrets), recent runs, and the master key source. */
export const GET: RequestHandler = async () => {
	try {
		const store = await getBackupStore();
		return jsonResponse({
			config: await store.getView(),
			runs: await store.listRuns(10),
			running: isBackupRunning(),
			master_key: (await getSecretBox()).source
		});
	} catch (error) {
		if (error instanceof Error && error.name === 'SecretBoxError') {
			return errorResponse('unavailable', error.message);
		}
		return errorFromException(error, 'unavailable');
	}
};

export const PUT: RequestHandler = async ({ request }) => {
	const body = await parseJsonBody(request, backup_settings_schema);
	if (!body.ok) {
		return body.response;
	}
	try {
		const store = await getBackupStore();
		return jsonResponse({ config: await store.update(body.data) });
	} catch (error) {
		if (error instanceof Error && error.name === 'SecretBoxError') {
			return errorResponse('unavailable', error.message);
		}
		return errorFromException(error, 'unavailable');
	}
};
