/**
 * One saved view, run as the viewer, and for its owner the history. A view
 * that cannot run (its project left the catalogue, Dolt is down) still shows
 * its name and history, so the owner can revert or change it.
 */
import { api, errorMessage } from '#lib/client/api.js';
import type { ViewResult, ViewRevisionView, ViewSummary } from '#lib/views.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params }) => {
	let view: ViewSummary | null = null;
	let result: ViewResult | null = null;
	let revisions: ViewRevisionView[] = [];
	let error: string | null = null;
	let run_error: string | null = null;
	try {
		({ view, result } = await api.runView(params.slug, { fetch }));
	} catch (thrown) {
		// Either there is no such view, or it exists and did not run (its
		// project left the catalogue, say): reading it alone tells which.
		try {
			view = (await api.view(params.slug, { fetch })).view;
			run_error = errorMessage(thrown);
		} catch (again) {
			error = errorMessage(again);
		}
	}
	if (view?.mine) {
		try {
			revisions = (await api.viewHistory(params.slug, { fetch })).revisions;
		} catch {
			/* the page still shows the view; history says it could not load */
		}
	}
	return { slug: params.slug, view, result, revisions, error, run_error };
};
