/**
 * One catalog surface: read it as the viewer sees it, revise it (a new
 * revision), or delete it with its history. Revising and deleting are the
 * owner's, and the owner is an admin (ADR-0025 rule 7); the store enforces
 * both. A view under this slug is "not found" here (`requireGrown`).
 */
import type { RequestHandler } from './$types';
import type { SurfaceSpecShape } from '#lib/surfaces.js';
import { getGrownStore } from '#lib/server/state/db.js';
import { errorFromException, jsonResponse } from '#lib/server/security.js';
import { parseJsonBody } from '#lib/server/validation.js';
import {
	grown_revise_schema,
	grownSummary,
	personAuthor,
	requireGrown,
	viewerFromLocals
} from '#lib/server/grown/grown-api.js';

export const GET: RequestHandler = async ({ params, locals }) => {
	const viewer = viewerFromLocals(locals);
	try {
		const thing = await requireGrown(await getGrownStore(), viewer, 'surface', params.slug);
		return jsonResponse({ surface: grownSummary<SurfaceSpecShape>(thing, viewer) });
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};

/** Change any of name, description and spec; the rest carry over. */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	const body = await parseJsonBody(request, grown_revise_schema);
	if (!body.ok) return body.response;
	const viewer = viewerFromLocals(locals);
	try {
		const store = await getGrownStore();
		await requireGrown(store, viewer, 'surface', params.slug);
		const thing = await store.revise(viewer, params.slug, {
			...body.data,
			author: personAuthor(locals)
		});
		return jsonResponse({ surface: grownSummary<SurfaceSpecShape>(thing, viewer) });
	} catch (error) {
		return errorFromException(error);
	}
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	const viewer = viewerFromLocals(locals);
	try {
		const store = await getGrownStore();
		await requireGrown(store, viewer, 'surface', params.slug);
		await store.remove(viewer, params.slug);
		return new Response(null, { status: 204 });
	} catch (error) {
		return errorFromException(error);
	}
};
