import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readEnv } from './env.js';
import { createSecretBox, loadMasterKey, parseMasterKey, SecretBoxError } from './secret-box.js';

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), 'beadsmith-secret-'));
}

describe('parseMasterKey', () => {
	it('accepts raw, hex, and base64 32-byte keys', () => {
		const raw = new Uint8Array(32).fill(7);
		expect(parseMasterKey(raw)).toEqual(raw);
		expect(parseMasterKey(new TextEncoder().encode('07'.repeat(32) + '\n'))).toEqual(raw);
		expect(parseMasterKey(new TextEncoder().encode(btoa(String.fromCharCode(...raw))))).toEqual(
			raw
		);
	});

	it('rejects keys of the wrong size', () => {
		expect(() => parseMasterKey(new TextEncoder().encode('short'))).toThrow(SecretBoxError);
	});
});

describe('loadMasterKey', () => {
	it('generates secret.key once with owner-only permissions', () => {
		const dir = tempDir();
		const env = readEnv({ HOME: '/home/tester', BDX_STATE_DIR: dir });
		const first = loadMasterKey(env);
		expect(first.source).toBe('generated');
		expect(statSync(join(dir, 'secret.key')).mode & 0o777).toBe(0o600);
		expect(loadMasterKey(env).key).toEqual(first.key);
	});

	it('prefers BDX_SECRET_KEY_FILE and never generates beside it', () => {
		const dir = tempDir();
		const file = join(dir, 'master');
		writeFileSync(file, 'ab'.repeat(32));
		const env = readEnv({ HOME: '/home/tester', BDX_STATE_DIR: dir, BDX_SECRET_KEY_FILE: file });
		expect(loadMasterKey(env).source).toBe('file');
		expect(() => readFileSync(join(dir, 'secret.key'))).toThrow();
	});

	it('fails closed on an unreadable key file', () => {
		const env = readEnv({ HOME: '/home/tester', BDX_SECRET_KEY_FILE: '/nonexistent/key' });
		expect(() => loadMasterKey(env)).toThrow('BDX_SECRET_KEY_FILE could not be read.');
	});
});

describe('createSecretBox', () => {
	it('round-trips and binds the purpose', async () => {
		const box = await createSecretBox(new Uint8Array(32).fill(1), 'file');
		const sealed = await box.seal('s3-secret', 'backup.secret_access_key');
		expect(sealed).toMatch(/^v1\.[\w-]+\.[\w-]+$/);
		expect(sealed).not.toContain('s3-secret');
		expect(await box.open(sealed, 'backup.secret_access_key')).toBe('s3-secret');
		await expect(box.open(sealed, 'backup.passphrase')).rejects.toBeInstanceOf(SecretBoxError);
	});

	it('cannot open values sealed under another key', async () => {
		const a = await createSecretBox(new Uint8Array(32).fill(1), 'file');
		const b = await createSecretBox(new Uint8Array(32).fill(2), 'file');
		const sealed = await a.seal('x', 'p');
		await expect(b.open(sealed, 'p')).rejects.toThrow(/master key may have changed/);
		await expect(b.open('garbage', 'p')).rejects.toThrow(/unknown format/);
	});
});
