import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile as readNodeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Optional override: a protected file holding the secret (a mounted secret). */
export const AUTH_SECRET_FILE_ENV = 'BETTER_AUTH_SECRET_FILE';
/** Generated on first start in the state directory when no file is given. */
export const AUTH_SECRET_FILENAME = 'auth-secret';
/** `openssl rand -base64 32` prints 44 characters. */
export const MIN_AUTH_SECRET_LENGTH = 32;

/** Safe error: never includes the path's contents or the secret. */
export class AuthSecretError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AuthSecretError';
	}
}

export interface AuthSecretDeps {
	env?: NodeJS.ProcessEnv;
	/** Where `auth-secret` lives when `BETTER_AUTH_SECRET_FILE` is unset. */
	state_dir: string;
	readFile?: (path: string) => Promise<string>;
}

/**
 * Read `<state_dir>/auth-secret`, creating it (mode 0600) on first start.
 * `wx` keeps a concurrent first start from overwriting the winner's secret.
 * @param state_dir Service-local state directory.
 */
function generatedSecret(state_dir: string): string {
	const path = join(state_dir, AUTH_SECRET_FILENAME);
	try {
		mkdirSync(state_dir, { recursive: true });
		writeFileSync(path, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600, flag: 'wx' });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
			throw new AuthSecretError('Could not create auth-secret in the state directory.');
		}
	}
	try {
		return readFileSync(path, 'utf8').trim();
	} catch {
		throw new AuthSecretError('Could not read auth-secret in the state directory.');
	}
}

/**
 * Resolve the Better Auth secret that signs session cookies:
 * `BETTER_AUTH_SECRET_FILE` when set, otherwise a secret generated once in the
 * state directory. Surrounding whitespace (a trailing newline) is dropped.
 * @param deps Environment, state directory, and an injectable reader for tests.
 */
export async function resolveAuthSecret(deps: AuthSecretDeps): Promise<string> {
	const env = deps.env ?? process.env;
	const file_path = env[AUTH_SECRET_FILE_ENV]?.trim();
	let value: string;
	if (file_path !== undefined && file_path.length > 0) {
		try {
			value = (await (deps.readFile ?? ((path) => readNodeFile(path, 'utf8')))(file_path)).trim();
		} catch {
			throw new AuthSecretError(`${AUTH_SECRET_FILE_ENV} could not be read.`);
		}
	} else {
		value = generatedSecret(deps.state_dir);
	}
	if (value.length < MIN_AUTH_SECRET_LENGTH) {
		throw new AuthSecretError(
			`The accounts secret must be at least ${MIN_AUTH_SECRET_LENGTH} characters (openssl rand -base64 32).`
		);
	}
	return value;
}
