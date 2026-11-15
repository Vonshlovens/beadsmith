/**
 * Run a saved view as the viewer (ADR-0025 rule 5): the store first decides
 * which revision this viewer may see, then its spec compiles onto the same
 * read path the project page uses. The author's role never carries over.
 */
import type { RequestHandler } from './$types';
import { getGrownStore } from '#lib/server/state/db.js';
import { errorFromException, jsonResponse } from '#lib/server/security.js';
import { runView, view_spec_schema } from '#lib/server/grown/view-spec.js';
import { requireView, viewerFromLocals, viewSummary } from '#lib/server/grown/views-api.js';

export const GET: RequestHandler = async ({ params, locals }) => {
	const viewer = viewerFromLocals(locals);
	try {
		const thing = await requireView(await getGrownStore(), viewer, params.slug);
		// The store validated the spec on write; parsing again types it and
		// refuses a stored spec today's schema no longer accepts.
		const result = await runView(view_spec_schema.parse(thing.revision.spec));
		return jsonResponse({ view: viewSummary(thing, viewer), result });
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};
