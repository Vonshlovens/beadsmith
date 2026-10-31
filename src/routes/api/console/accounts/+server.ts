import type { RequestHandler } from './$types';
import { AccountAdminError, listAccounts, signup_setting_schema } from '$lib/server/auth/admin.js';
import { getAuthService } from '$lib/server/auth/service.js';
import { errorFromException, errorResponse, jsonResponse } from '$lib/server/security.js';
import { parseJsonBody } from '$lib/server/validation.js';

/** Accounts and the sign-up switch (admin-only via `hooks.server.ts`). */
export const GET: RequestHandler = async ({ request }) => {
	try {
		return jsonResponse(await listAccounts(await getAuthService(), request.headers));
	} catch (error) {
		if (error instanceof AccountAdminError) {
			return errorResponse(error.code, error.message);
		}
		return errorFromException(error, 'unavailable');
	}
};

/** `{ signup_open }`: whether anyone with the URL may create a member account. */
export const PUT: RequestHandler = async ({ request }) => {
	const body = await parseJsonBody(request, signup_setting_schema);
	if (!body.ok) {
		return body.response;
	}
	try {
		const service = await getAuthService();
		await service.store.setSignupOpen(body.data.signup_open);
		return jsonResponse({ signup_open: await service.store.getSignupOpen() });
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};
