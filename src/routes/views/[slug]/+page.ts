/**
 * One grown thing at `/views/<slug>` (ADR-0025): a saved view, run as the
 * viewer, a catalog surface with its bindings resolved as the viewer, or a
 * sandboxed app (its document loads in the frame, not here). Slugs are
 * unique across kinds, so the page asks for a view first (the common case)
 * and, when no view has the slug, for a surface, then an app. A kind
 * that cannot read its data (a project left the catalogue, Dolt is down)
 * still shows its name and, for its owner, its history, so the owner can
 * revert or change it.
 */
import { api, ApiError, errorMessage } from '#lib/client/api.js';
import type { AppRevisionView, AppSummary } from '#lib/apps.js';
import type { SurfaceDataResponse, SurfaceRevisionView, SurfaceSummary } from '#lib/surfaces.js';
import type { ViewResult, ViewRevisionView, ViewSummary } from '#lib/views.js';
import type { PageLoad } from './$types';

const notFound = (error: unknown) => error instanceof ApiError && error.code === 'not_found';

export const load: PageLoad = async ({ fetch, params }) => {
	const slug = params.slug;
	let view: ViewSummary | null = null;
	let result: ViewResult | null = null;
	let surface: SurfaceSummary | null = null;
	let surface_data: SurfaceDataResponse | null = null;
	let app: AppSummary | null = null;
	let revisions: (ViewRevisionView | SurfaceRevisionView | AppRevisionView)[] = [];
	let error: string | null = null;
	let run_error: string | null = null;
	try {
		({ view, result } = await api.runView(slug, { fetch }));
	} catch (thrown) {
		// No such view, a surface under this slug, or a view that did not run
		// (its project left the catalogue, say): reading it alone tells which.
		try {
			view = (await api.view(slug, { fetch })).view;
			run_error = errorMessage(thrown);
		} catch (again) {
			if (!notFound(again)) {
				error = errorMessage(again);
			} else {
				try {
					surface = (await api.surface(slug, { fetch })).surface;
				} catch (again) {
					if (!notFound(again)) {
						error = errorMessage(again);
					} else {
						try {
							app = (await api.app(slug, { fetch })).app;
						} catch (last) {
							error = errorMessage(last);
						}
					}
				}
			}
		}
	}
	if (surface !== null) {
		try {
			surface_data = await api.surfaceData(slug, { fetch });
		} catch (thrown) {
			run_error = errorMessage(thrown);
		}
	}
	if (view?.mine || surface?.mine || app?.mine) {
		try {
			revisions = (
				view !== null
					? await api.viewHistory(slug, { fetch })
					: surface !== null
						? await api.surfaceHistory(slug, { fetch })
						: await api.appHistory(slug, { fetch })
			).revisions;
		} catch {
			/* the page still shows it; the history says it could not load */
		}
	}
	return { slug, view, result, surface, surface_data, app, revisions, error, run_error };
};
