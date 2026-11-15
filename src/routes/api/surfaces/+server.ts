/**
 * Catalog surfaces (ADR-0025 rule 2): the viewer's own surfaces and every
 * published one, and creating a surface. Reads are open to any signed-in
 * role (the store shows a member only published revisions); creating is
 * admin-only, both in the request gate (unknown API writes default to
 * `console:manage`, auth/roles.ts) and in the store (rule 7). The store
 * parses the spec against the catalog and the bridge allowlist on every
 * write, so nothing unknown is saved.
 */
import type { RequestHandler } from './$types';
import type { SurfaceSpecShape } from '#lib/surfaces.js';
import { getGrownStore } from '#lib/server/state/db.js';
import { errorFromException, jsonResponse } from '#lib/server/security.js';
import { parseJsonBody } from '#lib/server/validation.js';
import {
	grown_create_schema,
	grownSummary,
	personAuthor,
	viewerFromLocals
} from '#lib/server/grown/grown-api.js';

export const GET: RequestHandler = async ({ locals }) => {
	const viewer = viewerFromLocals(locals);
	try {
		const things = await (await getGrownStore()).list(viewer, 'surface');
		return jsonResponse({
			surfaces: things.map((thing) => grownSummary<SurfaceSpecShape>(thing, viewer))
		});
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};

/** A new surface, private to its creator until they publish it. */
export const POST: RequestHandler = async ({ request, locals }) => {
	const body = await parseJsonBody(request, grown_create_schema);
	if (!body.ok) return body.response;
	const viewer = viewerFromLocals(locals);
	try {
		const thing = await (
			await getGrownStore()
		).create(viewer, { kind: 'surface', ...body.data, author: personAuthor(locals) });
		return jsonResponse({ surface: grownSummary<SurfaceSpecShape>(thing, viewer) }, 201);
	} catch (error) {
		return errorFromException(error);
	}
};
