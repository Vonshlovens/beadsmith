import type { RequestHandler } from './$types';
import { backupDeps } from '$lib/server/backup/runtime.js';
import { isBackupRunning, runBackup } from '$lib/server/backup/service.js';
import { errorFromException, errorResponse, jsonResponse } from '$lib/server/security.js';

/** Start a manual run in the background; poll GET /api/console/backups. */
export const POST: RequestHandler = async () => {
	if (isBackupRunning()) {
		return errorResponse('conflict', 'A backup is already running.');
	}
	try {
		const deps = await backupDeps();
		const view = await deps.store.getView();
		if (!view.configured) {
			return errorResponse('bad_request', 'Configure the endpoint, bucket, and both keys first.');
		}
		void runBackup('manual', deps).catch(() => undefined);
		return jsonResponse({ started: true }, 202);
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};
