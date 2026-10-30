import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Resolve the directory holding the local state DB. It has a file of its own
 * so `node scripts/accounts.ts` (which runs without SvelteKit, and which the
 * image carries file by file) finds the same directory the server does.
 * @param source Environment to read.
 */
export function resolveStateDir(source: NodeJS.ProcessEnv): string {
	const override = source.BDX_STATE_DIR;
	if (override !== undefined && override.trim().length > 0) {
		return resolve(override.trim());
	}
	const xdg = source.XDG_STATE_HOME;
	if (xdg !== undefined && xdg.trim().length > 0) {
		return join(resolve(xdg.trim()), 'beads-web');
	}
	const home = source.HOME !== undefined && source.HOME.length > 0 ? source.HOME : homedir();
	return join(home, '.local', 'state', 'beads-web');
}
