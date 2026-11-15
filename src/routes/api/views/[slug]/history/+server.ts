/** Every kept revision of a view, newest first. The owner's alone (ADR-0025 rule 9). */
import type { RequestHandler } from './$types';
import type { ViewSpecShape } from '#lib/views.js';
import { getGrownStore } from '#lib/server/state/db.js';
import { errorFromException, jsonResponse } from '#lib/server/security.js';
import { requireGrown, grownRevisionView, viewerFromLocals } from '#lib/server/grown/grown-api.js';

export const GET: RequestHandler = async ({ params, locals }) => {
	const viewer = viewerFromLocals(locals);
	try {
		const store = await getGrownStore();
		const thing = await requireGrown(store, viewer, 'view', params.slug);
		const revisions = await store.history(viewer, params.slug);
		return jsonResponse({
			revisions: revisions.map((revision) =>
				grownRevisionView<ViewSpecShape>(revision, thing.published_revision_id)
			)
		});
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};
