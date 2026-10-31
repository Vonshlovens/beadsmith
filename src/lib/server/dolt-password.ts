import { readFile as readNodeFile } from 'node:fs/promises';

/** Development-only environment variable for a scoped local launch. */
export const DOLT_PASSWORD_ENV = 'BEADS_DOLT_PASSWORD';

/**
 * Path to a protected Dolt credential file.
 *
 * Production systemd units point this at a per-unit `LoadCredential` file;
 * other secret managers can use the same small file interface.
 */
export const DOLT_PASSWORD_FILE_ENV = 'BEADS_DOLT_PASSWORD_FILE';

/** Safe error raised when protected Dolt authentication cannot be loaded. */
export class DoltCredentialError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'DoltCredentialError';
	}
}

/** Injectable reader so credential behavior can be tested without disk I/O. */
export type PasswordFileReader = (path: string) => Promise<string>;

const readPasswordFile: PasswordFileReader = async (path) => {
	return readNodeFile(path, 'utf8');
};

export interface PasswordDeps {
	env?: NodeJS.ProcessEnv;
	readFile?: PasswordFileReader;
}

/**
 * Remove exactly one conventional terminal line ending from a credential file.
 * Password bytes otherwise remain untouched, including intentional whitespace.
 * @param value Raw credential-file contents.
 */
function withoutTerminalLineEnding(value: string): string {
	if (value.endsWith('\r\n')) {
		return value.slice(0, -2);
	}
	if (value.endsWith('\n')) {
		return value.slice(0, -1);
	}
	return value;
}

/**
 * Resolve the service-provided Dolt password.
 *
 * A protected file takes precedence over a raw environment value so a systemd
 * credential cannot accidentally be shadowed by a login-shell export. The
 * value is handed only to the mysql2 configuration object. It is never logged,
 * serialised, written to the state database, or delegated to a desktop helper.
 * @param deps Injectable environment for tests.
 * @returns The non-empty Dolt password.
 */
export async function resolveDoltPassword(deps: PasswordDeps = {}): Promise<string> {
	const env = deps.env ?? process.env;
	const file_path = env[DOLT_PASSWORD_FILE_ENV];

	if (file_path !== undefined) {
		if (file_path.length === 0) {
			throw new DoltCredentialError(
				'Protected Dolt authentication is unavailable. Check the service credential configuration.'
			);
		}
		let contents: string;
		try {
			contents = await (deps.readFile ?? readPasswordFile)(file_path);
		} catch {
			throw new DoltCredentialError(
				'Protected Dolt authentication is unavailable. Check the service credential configuration.'
			);
		}
		const value = withoutTerminalLineEnding(contents);
		if (value.length > 0) {
			return value;
		}
		throw new DoltCredentialError(
			'Protected Dolt authentication is unavailable. Check the service credential configuration.'
		);
	}

	const value = env[DOLT_PASSWORD_ENV];
	if (value !== undefined && value.length > 0) {
		return value;
	}
	throw new DoltCredentialError(
		'Protected Dolt authentication is unavailable. Check the service credential configuration.'
	);
}
