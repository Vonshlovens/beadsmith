/**
 * The full cross-project activity log.
 */
import { api, errorMessage } from '#lib/client/api.js';
import type { ActivityEvent } from '#lib/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) => {
	let events: ActivityEvent[] = [];
	let error: string | null = null;

	try {
		events = (await api.activity(100, { fetch })).events;
	} catch (thrown) {
		error = errorMessage(thrown);
	}

	return { events, error };
};
