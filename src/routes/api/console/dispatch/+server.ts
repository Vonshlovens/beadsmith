import type { RequestHandler } from './$types';
import { getDispatchPolicyStore } from '$lib/server/state/db.js';
import { errorFromException, jsonResponse } from '$lib/server/security.js';
import { dispatch_arm_schema, parseJsonBody } from '$lib/server/validation.js';

export const PUT: RequestHandler = async ({ request }) => {
	const body = await parseJsonBody(request, dispatch_arm_schema);
	if (!body.ok) {
		return body.response;
	}

	try {
		const store = await getDispatchPolicyStore();
		await store.setArmed(body.data.armed);
		return jsonResponse({ armed: body.data.armed });
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};
