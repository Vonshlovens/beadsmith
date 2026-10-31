import { describe, expect, it } from 'vitest';
import {
	BackupDecryptError,
	decryptObject,
	encryptObject,
	gunzip,
	gzip,
	isEncryptedObject
} from './crypto.js';

const FAST = 1_000;
const text = new TextEncoder().encode('INSERT INTO `issues` VALUES (1);\n'.repeat(50));

describe('gzip', () => {
	it('round-trips and compresses', async () => {
		const packed = await gzip(text);
		expect(packed.length).toBeLessThan(text.length);
		expect(await gunzip(packed)).toEqual(text);
	});
});

describe('encryptObject', () => {
	it('round-trips with the right passphrase', async () => {
		const sealed = await encryptObject(text, 'correct horse', FAST);
		expect(isEncryptedObject(sealed)).toBe(true);
		expect(new TextDecoder().decode(sealed)).not.toContain('INSERT');
		expect(await decryptObject(sealed, 'correct horse', FAST)).toEqual(text);
	});

	it('uses a fresh salt and iv per object', async () => {
		const a = await encryptObject(text, 'p', FAST);
		const b = await encryptObject(text, 'p', FAST);
		expect(a.slice(5, 33)).not.toEqual(b.slice(5, 33));
	});

	it('rejects a wrong passphrase', async () => {
		const sealed = await encryptObject(text, 'right', FAST);
		await expect(decryptObject(sealed, 'wrong', FAST)).rejects.toBeInstanceOf(BackupDecryptError);
	});

	it('rejects tampered ciphertext and header', async () => {
		const sealed = await encryptObject(text, 'p', FAST);
		const body = sealed.slice();
		body[body.length - 1] ^= 1;
		await expect(decryptObject(body, 'p', FAST)).rejects.toBeInstanceOf(BackupDecryptError);
		const version = sealed.slice();
		version[4] = 2;
		await expect(decryptObject(version, 'p', FAST)).rejects.toThrow(/supported/);
	});

	it('does not mistake gzip output for an encrypted object', async () => {
		expect(isEncryptedObject(await gzip(text))).toBe(false);
	});
});
