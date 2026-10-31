/** Where the source lives. Links into the repository are built from this. */
export const REPO_URL = 'https://github.com/Vonshlovens/beadsmith';

/** A file or directory in the repository on GitHub (directories redirect to /tree). */
export function repoFile(path: string): string {
	return `${REPO_URL}/blob/main/${path}`;
}

export const BEADS_URL = 'https://github.com/gastownhall/beads';
