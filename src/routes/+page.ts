/**
 * Home needs the cross-project activity feed; projects arrive from the layout.
 */
import { api, errorMessage } from '$lib/client/api';
import type { ActivityEvent } from '$lib/types';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) => {
	let events: ActivityEvent[] = [];
	let activity_error: string | null = null;

	try {
		events = (await api.activity(12, { fetch })).events;
	} catch (error) {
		activity_error = errorMessage(error);
	}

	return { events, activity_error };
};
