/**
 * Saved views (ADR-0025): the viewer's own views and every published one,
 * and creating a view. Reads are open to any signed-in role (the store shows
 * a member only published revisions); creating is admin-only, both in the
 * request gate (unknown API writes default to `console:manage`,
 * auth/roles.ts) and in the store (rule 7).
 */
import type { RequestHandler } from './$types';
import type { ViewSpecShape } from '#lib/views.js';
import { getGrownStore } from '#lib/server/state/db.js';
import { errorFromException, jsonResponse } from '#lib/server/security.js';
import { parseJsonBody } from '#lib/server/validation.js';
import {
	personAuthor,
	grown_create_schema,
	viewerFromLocals,
	grownSummary
} from '#lib/server/grown/grown-api.js';

export const GET: RequestHandler = async ({ locals }) => {
	const viewer = viewerFromLocals(locals);
	try {
		const things = await (await getGrownStore()).list(viewer, 'view');
		return jsonResponse({
			views: things.map((thing) => grownSummary<ViewSpecShape>(thing, viewer))
		});
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};

/** A new view, private to its creator until they publish it. */
export const POST: RequestHandler = async ({ request, locals }) => {
	const body = await parseJsonBody(request, grown_create_schema);
	if (!body.ok) return body.response;
	const viewer = viewerFromLocals(locals);
	try {
		const thing = await (
			await getGrownStore()
		).create(viewer, { kind: 'view', ...body.data, author: personAuthor(locals) });
		return jsonResponse({ view: grownSummary<ViewSpecShape>(thing, viewer) }, 201);
	} catch (error) {
		return errorFromException(error);
	}
};
