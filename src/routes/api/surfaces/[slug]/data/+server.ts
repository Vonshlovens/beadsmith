/**
 * A surface's data bindings, resolved as the signed-in viewer (ADR-0025
 * rules 5 and 6). The store first decides which revision this viewer sees
 * (a member, the published one), then each binding runs as the viewer: a
 * view through the viewer's visibility and `runView`, a bridge read through
 * its crew tool with the viewer's role. `?binding=<name>` (repeatable)
 * resolves only those; with none, every binding.
 *
 * Each binding resolved is one bridge call against the per-viewer, per-surface
 * limit; a request that would cross it is refused whole with `Retry-After`.
 */
import type { RequestHandler } from './$types';
import type { SurfaceDataResponse } from '#lib/surfaces.js';
import { getGrownStore } from '#lib/server/state/db.js';
import { errorFromException, errorResponse, jsonResponse } from '#lib/server/security.js';
import { requireGrown, viewerFromLocals } from '#lib/server/grown/grown-api.js';
import {
	getBridgeLimiter,
	resolveSurfaceBindings,
	surfaceBindingNames,
	takeBridgeCalls
} from '#lib/server/grown/bindings.js';

export const GET: RequestHandler = async ({ params, locals, url }) => {
	const viewer = { ...viewerFromLocals(locals), actor: locals.user?.email ?? '' };
	try {
		const store = await getGrownStore();
		const thing = await requireGrown(store, viewer, 'surface', params.slug);
		const names = surfaceBindingNames(thing, url.searchParams.getAll('binding'));
		const taken = takeBridgeCalls(getBridgeLimiter(), viewer, thing.slug, names.length);
		if (!taken.ok) {
			const response = errorResponse(
				'rate_limited',
				'This surface is reading too often. Wait a moment and reload it.'
			);
			response.headers.set('retry-after', String(Math.ceil(taken.retry_after_ms / 1000)));
			return response;
		}
		const bindings = await resolveSurfaceBindings(store, viewer, thing, names);
		return jsonResponse({
			slug: thing.slug,
			revision: thing.revision.number,
			bindings
		} satisfies SurfaceDataResponse);
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};
