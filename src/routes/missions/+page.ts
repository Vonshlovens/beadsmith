/**
 * Cross-project File/Tackle fleet.
 */
import { api, errorMessage } from '#lib/client/api.js';
import type { Mission } from '#lib/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) => {
	let missions: Mission[] = [];
	let error: string | null = null;

	try {
		missions = (await api.missions({ limit: 100 }, { fetch })).missions;
	} catch (thrown) {
		error = errorMessage(thrown);
	}

	return { missions, error };
};
