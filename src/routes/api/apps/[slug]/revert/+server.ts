/**
 * Revert an app: a new revision copying an old one forward (ADR-0025
 * rule 8), so the history keeps what it replaced. Owner-only. The copied
 * spec is parsed again on the way in, so a revision today's schema no
 * longer accepts is refused rather than restored.
 */
import type { RequestHandler } from './$types';
import type { AppSpecShape } from '#lib/apps.js';
import { getGrownStore } from '#lib/server/state/db.js';
import { errorFromException, jsonResponse } from '#lib/server/security.js';
import { parseJsonBody } from '#lib/server/validation.js';
import {
	grown_revert_schema,
	grownSummary,
	personAuthor,
	requireGrown,
	viewerFromLocals
} from '#lib/server/grown/grown-api.js';

export const POST: RequestHandler = async ({ params, request, locals }) => {
	const body = await parseJsonBody(request, grown_revert_schema);
	if (!body.ok) return body.response;
	const viewer = viewerFromLocals(locals);
	try {
		const store = await getGrownStore();
		await requireGrown(store, viewer, 'app', params.slug);
		const thing = await store.revert(viewer, params.slug, body.data.number, personAuthor(locals));
		return jsonResponse({ app: grownSummary<AppSpecShape>(thing, viewer) });
	} catch (error) {
		return errorFromException(error);
	}
};
