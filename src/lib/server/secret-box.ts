/**
 * Encryption at rest for the few secrets `state.db` may hold (backup
 * credentials, ADR-0010). AES-256-GCM under a 32-byte master key read from
 * `BDX_SECRET_KEY_FILE`, or generated once as `<state_dir>/secret.key`
 * (mode 0600). Sealed values look like `v1.<iv>.<ciphertext>` (base64url) and
 * are bound to a purpose string so one sealed value cannot be swapped for
 * another.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getEnv, type ServerEnv } from './env.js';

export type MasterKeySource = 'file' | 'generated';

export class SecretBoxError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SecretBoxError';
	}
}

export interface SecretBox {
	readonly source: MasterKeySource;
	seal(plaintext: string, purpose: string): Promise<string>;
	open(sealed: string, purpose: string): Promise<string>;
}

function b64url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(text: string): Uint8Array {
	const normal = text.replace(/-/g, '+').replace(/_/g, '/');
	const binary = atob(normal + '='.repeat((4 - (normal.length % 4)) % 4));
	return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

/** Parse key material: 32 raw bytes, or 32 bytes as hex or base64 text. */
export function parseMasterKey(raw: Uint8Array): Uint8Array {
	if (raw.length === 32) return raw;
	const text = new TextDecoder().decode(raw).trim();
	if (/^[0-9a-fA-F]{64}$/.test(text)) {
		return Uint8Array.from(text.match(/../g) ?? [], (h) => parseInt(h, 16));
	}
	try {
		const decoded = fromB64url(text);
		if (decoded.length === 32) return decoded;
	} catch {
		// Fall through to the error below.
	}
	throw new SecretBoxError('The master key must be 32 bytes (raw, hex, or base64).');
}

/**
 * Load the master key, generating `<state_dir>/secret.key` when no file is
 * configured. Never logs key material.
 */
export function loadMasterKey(env: ServerEnv): { key: Uint8Array; source: MasterKeySource } {
	if (env.secret_key_file !== undefined) {
		let raw: Uint8Array;
		try {
			raw = readFileSync(env.secret_key_file);
		} catch {
			throw new SecretBoxError('BDX_SECRET_KEY_FILE could not be read.');
		}
		return { key: parseMasterKey(raw), source: 'file' };
	}
	const path = join(env.state_dir, 'secret.key');
	if (!existsSync(path)) {
		const fresh = crypto.getRandomValues(new Uint8Array(32));
		try {
			// `wx` fails if another process created it first; then read theirs.
			writeFileSync(path, `${b64url(fresh)}\n`, { mode: 0o600, flag: 'wx' });
		} catch (error) {
			if ((error as { code?: string }).code !== 'EEXIST') {
				throw new SecretBoxError('Could not create secret.key in the state directory.');
			}
		}
	}
	return { key: parseMasterKey(readFileSync(path)), source: 'generated' };
}

/** Build a secret box over raw key bytes. */
export async function createSecretBox(
	key: Uint8Array,
	source: MasterKeySource
): Promise<SecretBox> {
	const aes = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, [
		'encrypt',
		'decrypt'
	]);
	const encoder = new TextEncoder();
	return {
		source,
		async seal(plaintext, purpose) {
			const iv = crypto.getRandomValues(new Uint8Array(12));
			const sealed = await crypto.subtle.encrypt(
				{ name: 'AES-GCM', iv, additionalData: encoder.encode(purpose) },
				aes,
				encoder.encode(plaintext)
			);
			return `v1.${b64url(iv)}.${b64url(new Uint8Array(sealed))}`;
		},
		async open(sealed, purpose) {
			const parts = sealed.split('.');
			if (parts.length !== 3 || parts[0] !== 'v1') {
				throw new SecretBoxError('Stored secret has an unknown format.');
			}
			try {
				const plain = await crypto.subtle.decrypt(
					{
						name: 'AES-GCM',
						iv: fromB64url(parts[1]) as BufferSource,
						additionalData: encoder.encode(purpose)
					},
					aes,
					fromB64url(parts[2]) as BufferSource
				);
				return new TextDecoder().decode(plain);
			} catch {
				throw new SecretBoxError(
					'Stored secret could not be decrypted; the master key may have changed.'
				);
			}
		}
	};
}

let box_promise: Promise<SecretBox> | undefined;

/** Process-wide secret box from the configured master key. */
export function getSecretBox(): Promise<SecretBox> {
	if (box_promise === undefined) {
		box_promise = (async () => {
			const { key, source } = loadMasterKey(getEnv());
			return createSecretBox(key, source);
		})().catch((error: unknown) => {
			box_promise = undefined;
			throw error;
		});
	}
	return box_promise;
}

/** Replace the process secret box (tests only). */
export function setSecretBox(box: SecretBox | undefined): void {
	box_promise = box === undefined ? undefined : Promise.resolve(box);
}
