/**
 * Better Auth's HTTP surface (ADR-0011), reached only after every gate in
 * `hooks.server.ts` (Host, Origin, fetch metadata, Access, CSRF header, rate
 * limits). Only the endpoints the sign-in and account pages use are exposed;
 * account management goes through `/api/console/accounts`, which the hooks
 * restrict to admins.
 */
import type { RequestHandler } from './$types';
import { AUTH_BASE_PATH, getAuthService } from '$lib/server/auth/service.js';
import { errorFromException, errorResponse } from '$lib/server/security.js';

const EXPOSED_AUTH_ENDPOINTS = new Set([
	'GET /get-session',
	'POST /sign-in/email',
	'POST /sign-up/email',
	'POST /sign-out',
	'POST /change-password'
]);

const handle: RequestHandler = async ({ request, url }) => {
	const endpoint = `${request.method.toUpperCase()} ${url.pathname.slice(AUTH_BASE_PATH.length)}`;
	if (!EXPOSED_AUTH_ENDPOINTS.has(endpoint)) {
		return errorResponse('not_found', 'not found');
	}
	try {
		return await (await getAuthService()).auth.handler(request);
	} catch (error) {
		return errorFromException(error, 'unavailable');
	}
};

export const GET = handle;
export const POST = handle;
