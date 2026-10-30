import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { MIN_PASSWORD_LENGTH } from '$lib/server/auth/service.js';

/** Own-account page (ADR-0011); a service-token reader has no account to show. */
export const load: PageServerLoad = ({ locals }) => {
	if (locals.user === undefined) {
		redirect(303, '/');
	}
	return { account: locals.user, min_password_length: MIN_PASSWORD_LENGTH };
};
