/**
 * First-run bootstrap (ADR-0011). While no account exists, a one-time setup
 * token is written to `<state_dir>/setup-token` (mode 0600). Creating the
 * first account requires it and makes that account an admin; the file is then
 * deleted. Only someone who can read the state directory can claim a fresh
 * install, so exposing an empty server to the network does not hand the admin
 * role to whoever finds it first.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeEqual } from '../security.js';

export const SETUP_TOKEN_FILENAME = 'setup-token';
/** Request header the first-admin form sends the token in. */
export const SETUP_TOKEN_HEADER = 'x-bdx-setup-token';

export interface SetupTokenFile {
	/** Return the current token, creating the file when missing. */
	ensure(): string;
	/** True when `candidate` matches the current token (constant time). */
	matches(candidate: string | null | undefined): boolean;
	/** Delete the token after the first account exists. */
	clear(): void;
	readonly path: string;
}

/**
 * Manage the setup token for one state directory.
 * @param state_dir Service-local state directory.
 * @param log Where to announce a freshly written token file (never the token).
 */
export function createSetupTokenFile(
	state_dir: string,
	log: (message: string) => void = (message) => console.warn(message)
): SetupTokenFile {
	const path = join(state_dir, SETUP_TOKEN_FILENAME);
	let current: string | undefined;

	/** Read an existing token, or undefined when absent or empty. */
	function readExisting(): string | undefined {
		try {
			const value = readFileSync(path, 'utf8').trim();
			return value.length > 0 ? value : undefined;
		} catch {
			return undefined;
		}
	}

	return {
		path,
		ensure(): string {
			current ??= readExisting();
			if (current === undefined) {
				const fresh = randomBytes(24).toString('base64url');
				writeFileSync(path, `${fresh}\n`, { mode: 0o600 });
				current = fresh;
				log(
					`beads-web accounts: no account exists yet. The first-admin setup token is in ${path}; open /auth to create the admin account.`
				);
			}
			return current;
		},
		matches(candidate: string | null | undefined): boolean {
			if (typeof candidate !== 'string' || candidate.length === 0) {
				return false;
			}
			const token = current ?? readExisting();
			return token !== undefined && safeEqual(candidate.trim(), token);
		},
		clear(): void {
			current = undefined;
			rmSync(path, { force: true });
		}
	};
}
