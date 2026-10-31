import type { RequestHandler } from './$types';
import { AccountAdminError, createAccount, create_account_schema } from '$lib/server/auth/admin.js';
import { getAuthService } from '$lib/server/auth/service.js';
import { errorFromException, errorResponse, jsonResponse } from '$lib/server/security.js';
import { parseJsonBody } from '$lib/server/validation.js';

/** Create an account with an initial password (admin-only via `hooks.server.ts`). */
export const POST: RequestHandler = async ({ request }) => {
	const body = await parseJsonBody(request, create_account_schema);
	if (!body.ok) {
		return body.response;
	}
	try {
		const user = await createAccount(await getAuthService(), request.headers, body.data);
		return jsonResponse({ user }, 201);
	} catch (error) {
		if (error instanceof AccountAdminError) {
			return errorResponse(error.code, error.message);
		}
		return errorFromException(error, 'unavailable');
	}
};
