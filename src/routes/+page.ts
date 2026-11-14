/**
 * `/` is not a page of its own: it opens First Mate (src/lib/client/home.ts).
 * A universal load, so the brand link redirects without a server round trip.
 */
import { redirect } from '@sveltejs/kit';
import { HOME_PATH } from '#lib/client/home.js';
import type { PageLoad } from './$types';

export const load: PageLoad = () => {
	redirect(307, HOME_PATH);
};
