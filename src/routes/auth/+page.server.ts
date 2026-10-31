import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { safeRedirectPath } from '$lib/client/auth.js';
import { getAuthService, MIN_PASSWORD_LENGTH } from '$lib/server/auth/service.js';

/**
 * Sign-in page (ADR-0011). A signed-in visitor goes straight back. While no account exists the page
 * becomes the first-admin form, which needs the setup token.
 */
export const load: PageServerLoad = async ({ locals, url }) => {
	const redirect_to = safeRedirectPath(url.searchParams.get('redirect'));
	if (locals.user !== undefined) {
		redirect(303, redirect_to);
	}
	const service = await getAuthService();
	const bootstrap = await service.needsBootstrap();
	return {
		bootstrap,
		signup_open: !bootstrap && (await service.store.getSignupOpen()),
		redirect_to,
		min_password_length: MIN_PASSWORD_LENGTH
	};
};
