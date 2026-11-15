/**
 * Revert a view: a new revision copying an old one forward (ADR-0025
 * rule 8), so the history keeps what it replaced. Owner-only.
 */
import type { RequestHandler } from './$types';
import { getGrownStore } from '#lib/server/state/db.js';
import { errorFromException, jsonResponse } from '#lib/server/security.js';
import { parseJsonBody } from '#lib/server/validation.js';
import {
	personAuthor,
	requireView,
	view_revert_schema,
	viewerFromLocals,
	viewSummary
} from '#lib/server/grown/views-api.js';

export const POST: RequestHandler = async ({ params, request, locals }) => {
	const body = await parseJsonBody(request, view_revert_schema);
	if (!body.ok) return body.response;
	const viewer = viewerFromLocals(locals);
	try {
		const store = await getGrownStore();
		await requireView(store, viewer, params.slug);
		const thing = await store.revert(viewer, params.slug, body.data.number, personAuthor(locals));
		return jsonResponse({ view: viewSummary(thing, viewer) });
	} catch (error) {
		return errorFromException(error);
	}
};
