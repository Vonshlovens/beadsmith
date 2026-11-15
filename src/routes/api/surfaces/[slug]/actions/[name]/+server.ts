/**
 * Run one of a surface's button actions as the signed-in viewer (ADR-0025
 * rules 5 and 6), after the host confirmation the page draws. The store first
 * decides which revision this viewer sees; the request names the revision
 * the person confirmed, and a surface revised since is refused with a
 * conflict. The action's crew tool then runs with the viewer's role, so its
 * own permission, and for a launch dispatch's arm, allow list and repository
 * map, decide.
 *
 * The request gate holds every action to an admin (unknown writes default to
 * `console:manage` in `roles.ts`); the role check behind it is the tool's own.
 * Each action takes one bridge call from the per-viewer, per-surface limit.
 */
import type { RequestHandler } from './$types';
import { getGrownStore } from '#lib/server/state/db.js';
import { errorFromException, errorResponse, jsonResponse } from '#lib/server/security.js';
import { parseJsonBody } from '#lib/server/validation.js';
import { requireGrown, viewerFromLocals } from '#lib/server/grown/grown-api.js';
import { getBridgeLimiter, takeBridgeCalls } from '#lib/server/grown/bindings.js';
import { runSurfaceAction, surface_action_request_schema } from '#lib/server/grown/actions.js';

export const POST: RequestHandler = async ({ params, request, locals }) => {
	const body = await parseJsonBody(request, surface_action_request_schema);
	if (!body.ok) return body.response;
	const viewer = { ...viewerFromLocals(locals), actor: locals.user?.email ?? '' };
	try {
		const store = await getGrownStore();
		const thing = await requireGrown(store, viewer, 'surface', params.slug);
		const taken = takeBridgeCalls(getBridgeLimiter(), viewer, thing.slug, 1);
		if (!taken.ok) {
			const response = errorResponse(
				'rate_limited',
				'This surface is calling Beadsmith too often. Wait a moment and try again.'
			);
			response.headers.set('retry-after', String(Math.ceil(taken.retry_after_ms / 1000)));
			return response;
		}
		const result = await runSurfaceAction(store, viewer, thing, params.name, body.data);
		return jsonResponse({ slug: thing.slug, action: params.name, result });
	} catch (error) {
		return errorFromException(error);
	}
};
