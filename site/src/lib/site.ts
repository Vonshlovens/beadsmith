/**
 * Where the site is served: origin only, no trailing slash and no BASE_PATH.
 * Canonical links, Open Graph URLs and the sitemap are built from it.
 */
export const SITE_URL = 'https://beadsmith.ericevans.dev';

/** Where the source lives. Links into the repository are built from this. */
export const REPO_URL = 'https://github.com/Vonshlovens/beadsmith';

/** A file or directory in the repository on GitHub (directories redirect to /tree). */
export function repoFile(path: string): string {
	return `${REPO_URL}/blob/main/${path}`;
}

export const BEADS_URL = 'https://github.com/gastownhall/beads';
