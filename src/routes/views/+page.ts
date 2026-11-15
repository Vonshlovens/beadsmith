/**
 * The grown-things catalogue (ADR-0025 rule 9): saved views, catalog
 * surfaces and sandboxed apps, the viewer's own and every published one.
 * Each list loads on its own, so one failing does not hide the others.
 */
import { api, errorMessage } from '#lib/client/api.js';
import type { AppSummary } from '#lib/apps.js';
import type { SurfaceSummary } from '#lib/surfaces.js';
import type { ViewSummary } from '#lib/views.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) => {
	const [views, surfaces, apps] = await Promise.allSettled([
		api.views({ fetch }),
		api.surfaces({ fetch }),
		api.apps({ fetch })
	]);
	return {
		views: views.status === 'fulfilled' ? views.value.views : ([] as ViewSummary[]),
		surfaces: surfaces.status === 'fulfilled' ? surfaces.value.surfaces : ([] as SurfaceSummary[]),
		apps: apps.status === 'fulfilled' ? apps.value.apps : ([] as AppSummary[]),
		error: views.status === 'rejected' ? errorMessage(views.reason) : null,
		surfaces_error: surfaces.status === 'rejected' ? errorMessage(surfaces.reason) : null,
		apps_error: apps.status === 'rejected' ? errorMessage(apps.reason) : null
	};
};
