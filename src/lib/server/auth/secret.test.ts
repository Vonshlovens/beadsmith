import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTH_SECRET_FILENAME, AuthSecretError, resolveAuthSecret } from './secret.js';

const LONG = 'x'.repeat(44);

let state_dir: string;

beforeEach(() => {
	state_dir = mkdtempSync(join(tmpdir(), 'bdx-secret-'));
});

afterEach(() => {
	rmSync(state_dir, { recursive: true, force: true });
});

describe('resolveAuthSecret', () => {
	it('reads BETTER_AUTH_SECRET_FILE and trims its newline', async () => {
		const secret = await resolveAuthSecret({
			env: { BETTER_AUTH_SECRET_FILE: '/run/secrets/a' },
			state_dir,
			readFile: async () => `${LONG}\n`
		});
		expect(secret).toBe(LONG);
	});

	it('generates a 0600 secret in the state directory on first start and reuses it', async () => {
		const first = await resolveAuthSecret({ env: {}, state_dir });
		const path = join(state_dir, AUTH_SECRET_FILENAME);
		expect(first.length).toBeGreaterThanOrEqual(32);
		expect(readFileSync(path, 'utf8').trim()).toBe(first);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(await resolveAuthSecret({ env: {}, state_dir })).toBe(first);
	});

	it('creates a missing state directory', async () => {
		const nested = join(state_dir, 'nested');
		const secret = await resolveAuthSecret({ env: {}, state_dir: nested });
		expect(readFileSync(join(nested, AUTH_SECRET_FILENAME), 'utf8').trim()).toBe(secret);
	});

	it('refuses a secret shorter than 32 characters', async () => {
		writeFileSync(join(state_dir, AUTH_SECRET_FILENAME), 'short\n');
		await expect(resolveAuthSecret({ env: {}, state_dir })).rejects.toBeInstanceOf(AuthSecretError);
	});

	it('names the variable, never the path contents, when the file cannot be read', async () => {
		const error = await resolveAuthSecret({
			env: { BETTER_AUTH_SECRET_FILE: '/missing' },
			state_dir,
			readFile: async () => {
				throw new Error('ENOENT secret-bytes');
			}
		}).catch((thrown: unknown) => thrown);
		expect(error).toBeInstanceOf(AuthSecretError);
		expect((error as Error).message).toBe('BETTER_AUTH_SECRET_FILE could not be read.');
	});
});
