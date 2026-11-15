/**
 * Publishing (ADR-0025 rule 7): members see one published revision of a
 * view, and only that. The owner publishes a revision (`PUT`, default the
 * latest); any admin may unpublish (`DELETE`). These are browser actions by
 * a signed-in admin; no crew tool reaches them.
 */
import type { RequestHandler } from './$types';
import { getGrownStore } from '#lib/server/state/db.js';
import { errorFromException, jsonResponse } from '#lib/server/security.js';
import { parseJsonBody } from '#lib/server/validation.js';
import {
	requireView,
	view_publish_schema,
	viewerFromLocals,
	viewSummary
} from '#lib/server/grown/views-api.js';

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	const body = await parseJsonBody(request, view_publish_schema);
	if (!body.ok) return body.response;
	const viewer = viewerFromLocals(locals);
	try {
		const store = await getGrownStore();
		await requireView(store, viewer, params.slug);
		const thing = await store.publish(viewer, params.slug, body.data.number);
		return jsonResponse({ view: viewSummary(thing, viewer) });
	} catch (error) {
		return errorFromException(error);
	}
};

/**
 * Hide it from members. Returns the view as the viewer now sees it, or
 * `null` when it was another admin's and so is no longer visible to them.
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	const viewer = viewerFromLocals(locals);
	try {
		const store = await getGrownStore();
		await requireView(store, viewer, params.slug);
		const thing = await store.unpublish(viewer, params.slug);
		return jsonResponse({ view: thing === undefined ? null : viewSummary(thing, viewer) });
	} catch (error) {
		return errorFromException(error);
	}
};
