/**
 * Run a saved view as the viewer (ADR-0025 rule 5): the store first decides
 * which revision this viewer may see, then its spec compiles onto the same
 * read path the project page uses. The author's role never carries over.
 */
import type { RequestHandler } from './$types';
import type { ViewSpecShape } from '#lib/views.js';
import { getGrownStore } from '#lib/server/state/db.js';
import { errorFromException, jsonResponse } from '#lib/server/security.js';
import { runView, view_spec_schema } from '#lib/server/grown/view-spec.js';
import { requireGrown, viewerFromLocals, grownSummary } from '#lib/server/grown/grown-api.js';

export const GET: RequestHandler = async ({ params, locals }) => {
	const viewer = viewerFromLocals(locals);
	try {
		const thing = await requireGrown(await getGrownStore(), viewer, 'view', params.slug);
		// The store validated the spec on write; parsing again types it and
		// refuses a stored spec today's schema no longer accepts.
		const result = await runView(view_spec_schema.parse(thing.revision.spec));
		return jsonResponse({ view: grownSummary<ViewSpecShape>(thing, viewer), result });
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};
