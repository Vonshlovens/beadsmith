/**
 * Backup object packaging: gzip, and optional passphrase encryption.
 *
 * Encrypted object layout (all binary):
 *   "BSMB" | version (1 byte, = 1) | salt (16) | iv (12) | AES-256-GCM ciphertext+tag
 * The key is PBKDF2-SHA256(passphrase, salt, 600000 iterations). The 5-byte
 * header is authenticated as additional data. Each object has its own salt.
 */

const MAGIC = new Uint8Array([0x42, 0x53, 0x4d, 0x42]); // "BSMB"
const VERSION = 1;
const SALT_BYTES = 16;
const IV_BYTES = 12;
export const PBKDF2_ITERATIONS = 600_000;

export class BackupDecryptError extends Error {
	constructor(
		message = 'Backup object could not be decrypted (wrong passphrase or damaged data).'
	) {
		super(message);
		this.name = 'BackupDecryptError';
	}
}

/** DOM typings declare a BufferSource writable side; we only write Uint8Array. */
type GzipStream = TransformStream<Uint8Array, Uint8Array>;

async function streamThrough(
	data: Uint8Array,
	transform: TransformStream<Uint8Array, Uint8Array>
): Promise<Uint8Array> {
	const stream = new Blob([data as BlobPart]).stream().pipeThrough(transform);
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function gzip(data: Uint8Array): Promise<Uint8Array> {
	return streamThrough(data, new CompressionStream('gzip') as unknown as GzipStream);
}

export function gunzip(data: Uint8Array): Promise<Uint8Array> {
	return streamThrough(data, new DecompressionStream('gzip') as unknown as GzipStream);
}

async function deriveKey(
	passphrase: string,
	salt: Uint8Array,
	iterations: number
): Promise<CryptoKey> {
	const material = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(passphrase),
		'PBKDF2',
		false,
		['deriveKey']
	);
	return crypto.subtle.deriveKey(
		{ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
		material,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt']
	);
}

function header(): Uint8Array {
	const out = new Uint8Array(MAGIC.length + 1);
	out.set(MAGIC);
	out[MAGIC.length] = VERSION;
	return out;
}

/** True when the bytes start with the encrypted-object header. */
export function isEncryptedObject(data: Uint8Array): boolean {
	return data.length > MAGIC.length && MAGIC.every((b, i) => data[i] === b);
}

/**
 * Encrypt with a passphrase.
 * @param iterations Override for tests only.
 */
export async function encryptObject(
	data: Uint8Array,
	passphrase: string,
	iterations = PBKDF2_ITERATIONS
): Promise<Uint8Array> {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const head = header();
	const key = await deriveKey(passphrase, salt, iterations);
	const sealed = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv: iv as BufferSource, additionalData: head as BufferSource },
			key,
			data as BufferSource
		)
	);
	const out = new Uint8Array(head.length + SALT_BYTES + IV_BYTES + sealed.length);
	out.set(head, 0);
	out.set(salt, head.length);
	out.set(iv, head.length + SALT_BYTES);
	out.set(sealed, head.length + SALT_BYTES + IV_BYTES);
	return out;
}

/**
 * Decrypt an object made by `encryptObject`.
 * @param iterations Override for tests only.
 */
export async function decryptObject(
	data: Uint8Array,
	passphrase: string,
	iterations = PBKDF2_ITERATIONS
): Promise<Uint8Array> {
	const head = header();
	if (!isEncryptedObject(data) || data[MAGIC.length] !== VERSION) {
		throw new BackupDecryptError('Not a supported encrypted backup object.');
	}
	const salt = data.slice(head.length, head.length + SALT_BYTES);
	const iv = data.slice(head.length + SALT_BYTES, head.length + SALT_BYTES + IV_BYTES);
	const sealed = data.slice(head.length + SALT_BYTES + IV_BYTES);
	const key = await deriveKey(passphrase, salt, iterations);
	try {
		return new Uint8Array(
			await crypto.subtle.decrypt(
				{ name: 'AES-GCM', iv: iv as BufferSource, additionalData: head as BufferSource },
				key,
				sealed as BufferSource
			)
		);
	} catch {
		throw new BackupDecryptError();
	}
}
