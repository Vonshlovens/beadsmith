/**
 * `/` is not a page of its own: it opens your own work (src/lib/client/home.ts).
 * A universal load, so the brand link redirects without a server round trip.
 */
import { redirect } from '@sveltejs/kit';
import { homePath } from '#lib/client/home.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ parent }) => {
	const { viewer } = await parent();
	redirect(307, homePath(viewer?.role));
};
