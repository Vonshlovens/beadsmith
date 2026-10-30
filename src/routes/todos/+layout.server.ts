import { error } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

/**
 * The todo list is admin-only: `hooks.server.ts` refuses the
 * `/api/todos` calls; this keeps members off the page itself.
 */
export const load: LayoutServerLoad = ({ locals }) => {
	if (locals.role !== 'admin') {
		error(403, 'The todo list is for admins.');
	}
};
