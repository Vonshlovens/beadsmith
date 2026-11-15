/**
 * Sandboxed apps (ADR-0025 rule 3): the viewer's own apps and every
 * published one, and creating an app. Reads are open to any signed-in role
 * (the store shows a member only published revisions); creating is
 * admin-only, both in the request gate (unknown API writes default to
 * `console:manage`, auth/roles.ts) and in the store (rule 7). The store
 * checks the spec's shape and size; the document itself is opaque text that
 * only the sandboxed frame (`[slug]/frame`) ever runs.
 */
import type { RequestHandler } from './$types';
import type { AppSpecShape } from '#lib/apps.js';
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
		const things = await (await getGrownStore()).list(viewer, 'app');
		return jsonResponse({ apps: things.map((thing) => grownSummary<AppSpecShape>(thing, viewer)) });
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};

/** A new app, private to its creator until they publish it. */
export const POST: RequestHandler = async ({ request, locals }) => {
	const body = await parseJsonBody(request, grown_create_schema);
	if (!body.ok) return body.response;
	const viewer = viewerFromLocals(locals);
	try {
		const thing = await (
			await getGrownStore()
		).create(viewer, { kind: 'app', ...body.data, author: personAuthor(locals) });
		return jsonResponse({ app: grownSummary<AppSpecShape>(thing, viewer) }, 201);
	} catch (error) {
		return errorFromException(error);
	}
};
