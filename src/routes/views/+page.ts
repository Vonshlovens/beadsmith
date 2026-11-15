/** Saved views (ADR-0025): the viewer's own and every published one. */
import { api, errorMessage } from '#lib/client/api.js';
import type { ViewSummary } from '#lib/views.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) => {
	let views: ViewSummary[] = [];
	let error: string | null = null;
	try {
		views = (await api.views({ fetch })).views;
	} catch (thrown) {
		error = errorMessage(thrown);
	}
	return { views, error };
};
