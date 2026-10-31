import { error } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

/**
 * The console (and every `/api/console` route behind it) is admin-only
 * (ADR-0011): it edits dispatch policy, checkout maps, accounts, and backup
 * credentials. `hooks.server.ts` refuses the API calls; this renders the page.
 */
export const load: LayoutServerLoad = ({ locals }) => {
	if (locals.role !== 'admin') {
		error(403, 'The console is for admins.');
	}
};
