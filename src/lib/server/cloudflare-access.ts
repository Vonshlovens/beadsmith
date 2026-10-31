/**
 * Cloudflare Access application-token validation.
 *
 * The origin receives `Cf-Access-Jwt-Assertion` only after Cloudflare Access
 * has authenticated a request. It still verifies it itself so a routing or
 * tunnel mistake cannot turn an untrusted header into an identity.
 */
export interface CloudflareAccessConfig {
	issuer: string;
	audience: string;
}

export interface CloudflareAccessPrincipal {
	kind: 'human' | 'service_token';
	subject: string;
	email?: string;
}

interface JwtHeader {
	alg?: unknown;
	kid?: unknown;
	typ?: unknown;
}

interface JwtPayload {
	aud?: unknown;
	common_name?: unknown;
	email?: unknown;
	exp?: unknown;
	iat?: unknown;
	iss?: unknown;
	nbf?: unknown;
	sub?: unknown;
	type?: unknown;
}

interface JwkSet {
	keys?: unknown;
}

const CLOCK_TOLERANCE_SECONDS = 60;
const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Machine-readable cause for a verification failure. This never reaches the
 * client (the response message stays generic); it exists so the server log
 * can distinguish "Cloudflare never sent a header" from "clock skew" from
 * "wrong audience" without exposing token contents.
 */
export type CloudflareAccessFailureReason =
	| 'token_malformed'
	| 'jwt_alg_invalid'
	| 'jwt_typ_invalid'
	| 'jwt_kid_invalid'
	| 'jwks_fetch_failed'
	| 'jwks_malformed'
	| 'signing_key_not_found'
	| 'signature_error'
	| 'signature_invalid'
	| 'issuer_mismatch'
	| 'audience_mismatch'
	| 'token_type_invalid'
	| 'subject_invalid'
	| 'token_expired'
	| 'time_window_invalid';

/** Opaque failure used to avoid sending JWT parsing or key details to clients. */
export class CloudflareAccessVerificationError extends Error {
	readonly reason: CloudflareAccessFailureReason;

	constructor(reason: CloudflareAccessFailureReason) {
		super('Cloudflare Access authentication could not be verified.');
		this.name = 'CloudflareAccessVerificationError';
		this.reason = reason;
	}
}

/**
 * Normalize the Cloudflare One issuer and reject arbitrary JWKS hosts. The
 * fixed Cloudflare host is an important guard against configuration-based SSRF.
 */
export function normalizeCloudflareAccessIssuer(raw: string): string | undefined {
	try {
		const url = new URL(raw);
		if (
			url.protocol !== 'https:' ||
			url.port.length > 0 ||
			!url.hostname.endsWith('.cloudflareaccess.com') ||
			url.pathname !== '/' ||
			url.search.length > 0 ||
			url.hash.length > 0
		) {
			return undefined;
		}
		return url.origin;
	} catch {
		return undefined;
	}
}

function decodeBase64Url(value: string): Uint8Array {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) {
		throw new CloudflareAccessVerificationError('token_malformed');
	}
	const padded = value
		.replace(/-/g, '+')
		.replace(/_/g, '/')
		.padEnd(Math.ceil(value.length / 4) * 4, '=');
	return Uint8Array.from(Buffer.from(padded, 'base64'));
}

/** Copy into a plain ArrayBuffer for WebCrypto's stricter TypeScript surface. */
function asArrayBuffer(value: Uint8Array): ArrayBuffer {
	return Uint8Array.from(value).buffer as ArrayBuffer;
}

function decodeJson<T>(value: string): T {
	try {
		return JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as T;
	} catch {
		throw new CloudflareAccessVerificationError('token_malformed');
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function hasAudience(value: unknown, expected: string): boolean {
	return value === expected || (Array.isArray(value) && value.some((entry) => entry === expected));
}

function isValidNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function validateClaims(
	payload: JwtPayload,
	config: CloudflareAccessConfig,
	now: number
): CloudflareAccessPrincipal {
	// Each claim gets its own check (rather than one combined condition) so the
	// reason attached to the thrown error names the actual misconfiguration.
	if (payload.iss !== config.issuer) {
		throw new CloudflareAccessVerificationError('issuer_mismatch');
	}
	if (!hasAudience(payload.aud, config.audience)) {
		throw new CloudflareAccessVerificationError('audience_mismatch');
	}
	if (payload.type !== 'app') {
		throw new CloudflareAccessVerificationError('token_type_invalid');
	}
	const subject = typeof payload.sub === 'string' ? payload.sub : '';
	const common_name = typeof payload.common_name === 'string' ? payload.common_name.trim() : '';
	if (subject.length === 0 && common_name.length === 0) {
		throw new CloudflareAccessVerificationError('subject_invalid');
	}
	if (!isValidNumber(payload.exp) || payload.exp < now - CLOCK_TOLERANCE_SECONDS) {
		throw new CloudflareAccessVerificationError('token_expired');
	}
	if (
		(payload.nbf !== undefined &&
			(!isValidNumber(payload.nbf) || payload.nbf > now + CLOCK_TOLERANCE_SECONDS)) ||
		(payload.iat !== undefined &&
			(!isValidNumber(payload.iat) || payload.iat > now + CLOCK_TOLERANCE_SECONDS))
	) {
		throw new CloudflareAccessVerificationError('time_window_invalid');
	}
	if (subject.length === 0) {
		return { kind: 'service_token', subject: common_name };
	}
	return {
		kind: 'human',
		subject,
		...(typeof payload.email === 'string' && payload.email.length > 0
			? { email: payload.email }
			: {})
	};
}

function isRsaJwk(value: unknown, kid: string): value is JsonWebKey {
	return (
		isRecord(value) &&
		value.kty === 'RSA' &&
		value.alg === 'RS256' &&
		value.use === 'sig' &&
		value.kid === kid &&
		typeof value.n === 'string' &&
		typeof value.e === 'string'
	);
}

export interface CloudflareAccessVerifier {
	verify(token: string, config: CloudflareAccessConfig): Promise<CloudflareAccessPrincipal>;
}

/**
 * Build a verifier with a bounded per-process JWKS cache. Cache misses for a
 * new `kid` refresh once, which handles Cloudflare's normal signing-key
 * rotation without pinning a stale key in the service configuration.
 */
export function createCloudflareAccessVerifier(
	fetcher: typeof fetch = fetch,
	now: () => number = Date.now
): CloudflareAccessVerifier {
	const cache = new Map<string, { expires_at: number; keys: JsonWebKey[] }>();

	async function getKeys(issuer: string, force_refresh = false): Promise<JsonWebKey[]> {
		const cached = cache.get(issuer);
		if (!force_refresh && cached !== undefined && cached.expires_at > now()) {
			return cached.keys;
		}
		let response: Response;
		try {
			response = await fetcher(`${issuer}/cdn-cgi/access/certs`, {
				headers: { accept: 'application/json' },
				redirect: 'error'
			});
		} catch {
			throw new CloudflareAccessVerificationError('jwks_fetch_failed');
		}
		if (!response.ok) {
			throw new CloudflareAccessVerificationError('jwks_fetch_failed');
		}
		let body: JwkSet;
		try {
			body = (await response.json()) as JwkSet;
		} catch {
			throw new CloudflareAccessVerificationError('jwks_malformed');
		}
		if (!Array.isArray(body.keys)) {
			throw new CloudflareAccessVerificationError('jwks_malformed');
		}
		const keys = body.keys.filter((key): key is JsonWebKey => isRecord(key));
		if (keys.length === 0) {
			throw new CloudflareAccessVerificationError('jwks_malformed');
		}
		cache.set(issuer, { keys, expires_at: now() + JWKS_CACHE_TTL_MS });
		return keys;
	}

	return {
		async verify(
			token: string,
			config: CloudflareAccessConfig
		): Promise<CloudflareAccessPrincipal> {
			const parts = token.split('.');
			if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
				throw new CloudflareAccessVerificationError('token_malformed');
			}
			const header = decodeJson<JwtHeader>(parts[0]);
			const payload = decodeJson<JwtPayload>(parts[1]);
			// `alg` and `kid` are the real controls here: pinning RS256 blocks
			// algorithm confusion, and `kid` selects the verifying key. `typ` is
			// OPTIONAL per RFC 7519 §5.1 and Cloudflare Access app tokens omit
			// it, so requiring it rejected every genuine login. Validate it only
			// when present. Each condition reports separately so a future header
			// rejection names itself instead of collapsing into one code.
			if (header.alg !== 'RS256') {
				throw new CloudflareAccessVerificationError('jwt_alg_invalid');
			}
			if (typeof header.typ === 'string' && header.typ.toUpperCase() !== 'JWT') {
				throw new CloudflareAccessVerificationError('jwt_typ_invalid');
			}
			if (typeof header.kid !== 'string' || header.kid.length === 0) {
				throw new CloudflareAccessVerificationError('jwt_kid_invalid');
			}
			let keys = await getKeys(config.issuer);
			let key = keys.find((candidate) => isRsaJwk(candidate, header.kid as string));
			if (key === undefined) {
				keys = await getKeys(config.issuer, true);
				key = keys.find((candidate) => isRsaJwk(candidate, header.kid as string));
			}
			if (key === undefined) {
				throw new CloudflareAccessVerificationError('signing_key_not_found');
			}
			let crypto_key: CryptoKey;
			let verified: boolean;
			try {
				crypto_key = await crypto.subtle.importKey(
					'jwk',
					key,
					{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
					false,
					['verify']
				);
				verified = await crypto.subtle.verify(
					'RSASSA-PKCS1-v1_5',
					crypto_key,
					asArrayBuffer(decodeBase64Url(parts[2])),
					asArrayBuffer(new TextEncoder().encode(`${parts[0]}.${parts[1]}`))
				);
			} catch {
				throw new CloudflareAccessVerificationError('signature_error');
			}
			if (!verified) {
				throw new CloudflareAccessVerificationError('signature_invalid');
			}
			return validateClaims(payload, config, Math.floor(now() / 1000));
		}
	};
}

let verifier: CloudflareAccessVerifier | undefined;

/** Process-wide verifier and JWKS cache. */
export function getCloudflareAccessVerifier(): CloudflareAccessVerifier {
	if (verifier === undefined) {
		verifier = createCloudflareAccessVerifier();
	}
	return verifier;
}

/** Drop the verifier cache for tests. */
export function resetCloudflareAccessVerifier(): void {
	verifier = undefined;
}

/** Replace the process verifier in hook tests without performing network I/O. */
export function setCloudflareAccessVerifierForTest(
	candidate: CloudflareAccessVerifier | undefined
): void {
	verifier = candidate;
}
