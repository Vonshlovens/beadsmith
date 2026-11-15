/**
 * The grown-things catalogue (ADR-0025 rule 9): saved views and catalog
 * surfaces, the viewer's own and every published one. Each list loads on
 * its own, so one failing does not hide the other.
 */
import { api, errorMessage } from '#lib/client/api.js';
import type { SurfaceSummary } from '#lib/surfaces.js';
import type { ViewSummary } from '#lib/views.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) => {
	const [views, surfaces] = await Promise.allSettled([
		api.views({ fetch }),
		api.surfaces({ fetch })
	]);
	return {
		views: views.status === 'fulfilled' ? views.value.views : ([] as ViewSummary[]),
		surfaces: surfaces.status === 'fulfilled' ? surfaces.value.surfaces : ([] as SurfaceSummary[]),
		error: views.status === 'rejected' ? errorMessage(views.reason) : null,
		surfaces_error: surfaces.status === 'rejected' ? errorMessage(surfaces.reason) : null
	};
};
