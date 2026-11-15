/**
 * Run an action a sandboxed app asked for over the bridge (ADR-0025 rule 6),
 * after the host page's confirmation. The app has no network: it sends
 * `tools/call` to the host page, which draws `confirm-dialog` from the
 * action's name and arguments (never from anything the app draws), and only a
 * confirmed call reaches this route, under the viewer's session. The body is
 * what the dialog showed: the action, its arguments, the revision on screen
 * and a key made for that one confirmation.
 *
 * It runs **as the viewer** (rule 5): the store decides whether the viewer may
 * see the app at which revision, a revision other than the confirmed one is a
 * conflict, and the action's crew tool runs with the viewer's role, so its own
 * permission, and for a launch dispatch's arm, allow list and repository map,
 * decide. A launch records the app's slug on the mission.
 *
 * The request gate holds this route to an admin (unknown writes default to
 * `console:manage` in `roles.ts`; only the read route `/call` is open to every
 * role). Each action takes one call from the per-viewer, per-app bridge limit,
 * and the body is bounded by the bridge frame limit.
 */
import type { RequestHandler } from './$types';
import type { AppActionResponse } from '#lib/apps.js';
import { getGrownStore } from '#lib/server/state/db.js';
import { errorFromException, errorResponse, jsonResponse } from '#lib/server/security.js';
import { parseBridgeBody, requireGrown, viewerFromLocals } from '#lib/server/grown/grown-api.js';
import { getBridgeLimiter, takeBridgeCalls } from '#lib/server/grown/bindings.js';
import { app_action_request_schema, runAppAction } from '#lib/server/grown/actions.js';

export const POST: RequestHandler = async ({ params, request, locals }) => {
	const body = await parseBridgeBody(request, app_action_request_schema);
	if (!body.ok) return body.response;
	const viewer = { ...viewerFromLocals(locals), actor: locals.user?.email ?? '' };
	try {
		const store = await getGrownStore();
		const thing = await requireGrown(store, viewer, 'app', params.slug);
		const taken = takeBridgeCalls(getBridgeLimiter(), viewer, thing.slug, 1);
		if (!taken.ok) {
			const response = errorResponse(
				'rate_limited',
				'This app is calling too often. Wait a moment and try again.'
			);
			response.headers.set('retry-after', String(Math.ceil(taken.retry_after_ms / 1000)));
			return response;
		}
		const result = await runAppAction(store, viewer, thing, body.data);
		return jsonResponse({
			slug: thing.slug,
			revision: thing.revision.number,
			name: body.data.name,
			result
		} satisfies AppActionResponse);
	} catch (error) {
		return errorFromException(error);
	}
};
