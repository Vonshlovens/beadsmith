/** Every kept revision of an app, newest first. The owner's alone (ADR-0025 rule 9). */
import type { RequestHandler } from './$types';
import type { AppSpecShape } from '#lib/apps.js';
import { getGrownStore } from '#lib/server/state/db.js';
import { errorFromException, jsonResponse } from '#lib/server/security.js';
import { grownRevisionView, requireGrown, viewerFromLocals } from '#lib/server/grown/grown-api.js';

export const GET: RequestHandler = async ({ params, locals }) => {
	const viewer = viewerFromLocals(locals);
	try {
		const store = await getGrownStore();
		const thing = await requireGrown(store, viewer, 'app', params.slug);
		const revisions = await store.history(viewer, params.slug);
		return jsonResponse({
			revisions: revisions.map((revision) =>
				grownRevisionView<AppSpecShape>(revision, thing.published_revision_id)
			)
		});
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};
