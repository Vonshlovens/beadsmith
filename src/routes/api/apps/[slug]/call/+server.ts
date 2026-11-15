/**
 * One `tools/call` from a sandboxed app, forwarded by the host page's
 * postMessage bridge (ADR-0025 rule 6). The app itself has no network: the
 * host page, under the viewer's session, posts the call here, so it runs
 * **as the viewer** (rule 5), never as the app's author.
 *
 * Only reads are answered here: the bridge's read allowlist plus `run_view`,
 * each crew tool keeping its own `permission` (`list_todos` is refused to a
 * member). Actions go through their own route, `POST /api/apps/:slug/actions`,
 * behind the host confirmation.
 * The request gate lets any signed-in role make this POST
 * (`requiredPermission` in `roles.ts`), since it is a read with a body.
 *
 * The store decides whether the viewer may see the app at all (a member only
 * a published one). Every call is one bridge call against the per-viewer,
 * per-app limit the surfaces share; one over it is refused whole with
 * `Retry-After`. Bodies are bounded by the bridge frame limit.
 */
import { z } from 'zod';
import type { RequestHandler } from './$types';
import type { AppToolCallResponse } from '#lib/apps.js';
import { getGrownStore } from '#lib/server/state/db.js';
import { errorFromException, errorResponse, jsonResponse } from '#lib/server/security.js';
import { parseBridgeBody, requireGrown, viewerFromLocals } from '#lib/server/grown/grown-api.js';
import {
	getBridgeLimiter,
	isBridgeRead,
	runBridgeRead,
	takeBridgeCalls
} from '#lib/server/grown/bindings.js';

const call_schema = z.strictObject({
	name: z.string().min(1).max(64),
	arguments: z.record(z.string(), z.unknown()).default({})
});

export const POST: RequestHandler = async ({ params, request, locals }) => {
	const body = await parseBridgeBody(request, call_schema);
	if (!body.ok) return body.response;
	const viewer = { ...viewerFromLocals(locals), actor: locals.user?.email ?? '' };
	try {
		const store = await getGrownStore();
		const thing = await requireGrown(store, viewer, 'app', params.slug);
		const { name } = body.data;
		if (!isBridgeRead(name)) {
			return errorResponse(
				'bad_request',
				`${name} is not a read an app may call. Reads: the bridge allowlist and run_view.`
			);
		}
		const taken = takeBridgeCalls(getBridgeLimiter(), viewer, thing.slug, 1);
		if (!taken.ok) {
			const response = errorResponse(
				'rate_limited',
				'This app is calling too often. Wait a moment and try again.'
			);
			response.headers.set('retry-after', String(Math.ceil(taken.retry_after_ms / 1000)));
			return response;
		}
		const result = await runBridgeRead(
			store,
			viewer,
			{ slug: thing.slug, kind: 'app' },
			name,
			body.data.arguments
		);
		return jsonResponse({
			slug: thing.slug,
			revision: thing.revision.number,
			name,
			result
		} satisfies AppToolCallResponse);
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};
