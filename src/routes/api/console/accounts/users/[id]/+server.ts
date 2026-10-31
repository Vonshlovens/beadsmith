import type { RequestHandler } from './$types';
import {
	AccountAdminError,
	account_id_schema,
	removeAccount,
	updateAccount,
	update_account_schema
} from '$lib/server/auth/admin.js';
import { getAuthService } from '$lib/server/auth/service.js';
import { errorFromException, errorResponse, jsonResponse } from '$lib/server/security.js';
import { parseJsonBody, parseValue } from '$lib/server/validation.js';

/**
 * Map a refused change or an unexpected failure onto the error envelope.
 * @param error Thrown value.
 */
function failure(error: unknown): Response {
	if (error instanceof AccountAdminError) {
		return errorResponse(error.code, error.message);
	}
	return errorFromException(error, 'unavailable');
}

/** `{ role?, password? }` for one account (admin-only via `hooks.server.ts`). */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	if (locals.user === undefined) {
		return errorResponse('unauthorized', 'session required');
	}
	const id = parseValue(account_id_schema, params.id);
	if (!id.ok) {
		return id.response;
	}
	const body = await parseJsonBody(request, update_account_schema);
	if (!body.ok) {
		return body.response;
	}
	try {
		const service = await getAuthService();
		const user = await updateAccount(service, request.headers, locals.user.id, id.data, body.data);
		return jsonResponse({ user });
	} catch (error) {
		return failure(error);
	}
};

/** Remove one account and its sessions. */
export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	if (locals.user === undefined) {
		return errorResponse('unauthorized', 'session required');
	}
	const id = parseValue(account_id_schema, params.id);
	if (!id.ok) {
		return id.response;
	}
	try {
		await removeAccount(await getAuthService(), request.headers, locals.user.id, id.data);
		return new Response(null, { status: 204 });
	} catch (error) {
		return failure(error);
	}
};
