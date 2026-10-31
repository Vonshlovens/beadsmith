import type { RequestHandler } from './$types';
import { getStateStore } from '$lib/server/state/db.js';
import { errorFromException, jsonResponse } from '$lib/server/security.js';
import { parseJsonBody, theme_schema } from '$lib/server/validation.js';

/** Settings key holding the UI theme preference. Read back by `hooks.server.ts`. */
const THEME_SETTING_KEY = 'ui.theme';

/** Persist the UI theme preference. The value is echoed so clients can confirm. */
export const POST: RequestHandler = async ({ request }) => {
	const parsed = await parseJsonBody(request, theme_schema);
	if (!parsed.ok) {
		return parsed.response;
	}
	try {
		const store = await getStateStore();
		await store.setSetting(THEME_SETTING_KEY, parsed.data.theme);
		return jsonResponse({ theme: parsed.data.theme });
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};
