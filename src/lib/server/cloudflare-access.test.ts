import { createSign, generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	CloudflareAccessVerificationError,
	createCloudflareAccessVerifier,
	normalizeCloudflareAccessIssuer
} from './cloudflare-access.js';

const ISSUER = 'https://beads.cloudflareaccess.com';
const AUDIENCE = 'beads-web-audience';
const NOW_MS = 1_700_000_000_000;
const NOW_SECONDS = NOW_MS / 1000;
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
	modulusLength: 2048
});
const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;
const KID = 'test-current-key';

function encode(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signedToken(
	payload: Record<string, unknown> = {},
	header_claims: Record<string, unknown> = { alg: 'RS256', typ: 'JWT', kid: KID }
): string {
	const header = encode(header_claims);
	const claims = encode({
		iss: ISSUER,
		aud: [AUDIENCE],
		type: 'app',
		sub: 'cloudflare-user-subject',
		email: 'person@example.test',
		exp: NOW_SECONDS + 60,
		nbf: NOW_SECONDS - 1,
		iat: NOW_SECONDS - 1,
		...payload
	});
	const signing_input = `${header}.${claims}`;
	const signer = createSign('RSA-SHA256');
	signer.update(signing_input);
	signer.end();
	return `${signing_input}.${signer.sign(privateKey).toString('base64url')}`;
}

function verifier() {
	return createCloudflareAccessVerifier(
		async (input) => {
			expect(input.toString()).toBe(`${ISSUER}/cdn-cgi/access/certs`);
			return new Response(
				JSON.stringify({
					keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }]
				})
			);
		},
		() => NOW_MS
	);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('normalizeCloudflareAccessIssuer', () => {
	it('only accepts an HTTPS Cloudflare Access team origin', () => {
		expect(normalizeCloudflareAccessIssuer(`${ISSUER}/`)).toBe(ISSUER);
		expect(normalizeCloudflareAccessIssuer('http://beads.cloudflareaccess.com')).toBeUndefined();
		expect(normalizeCloudflareAccessIssuer('https://evil.example.com')).toBeUndefined();
		expect(normalizeCloudflareAccessIssuer(`${ISSUER}/cdn-cgi/access/certs`)).toBeUndefined();
	});
});

describe('Cloudflare Access JWT validation', () => {
	it('verifies an RS256 application token against the team JWKS', async () => {
		await expect(
			verifier().verify(signedToken(), { issuer: ISSUER, audience: AUDIENCE })
		).resolves.toEqual({
			kind: 'human',
			subject: 'cloudflare-user-subject',
			email: 'person@example.test'
		});
	});

	it.each([
		['wrong issuer', { iss: 'https://other.cloudflareaccess.com' }, 'issuer_mismatch'],
		['wrong audience', { aud: ['other-audience'] }, 'audience_mismatch'],
		['non-application token', { type: 'org' }, 'token_type_invalid'],
		['missing subject', { sub: '' }, 'subject_invalid'],
		['expired token', { exp: NOW_SECONDS - 61 }, 'token_expired'],
		['not-yet-valid token', { nbf: NOW_SECONDS + 61 }, 'time_window_invalid'],
		['future-issued token', { iat: NOW_SECONDS + 61 }, 'time_window_invalid']
	])('rejects a %s with reason %s', async (_name, claims, reason) => {
		const rejection = verifier().verify(signedToken(claims), {
			issuer: ISSUER,
			audience: AUDIENCE
		});
		await expect(rejection).rejects.toBeInstanceOf(CloudflareAccessVerificationError);
		await expect(rejection).rejects.toMatchObject({ reason });
	});

	it('accepts an empty subject when common_name identifies a service token', async () => {
		await expect(
			verifier().verify(signedToken({ sub: '', common_name: '0123456789abcdef0123456789abcdef' }), {
				issuer: ISSUER,
				audience: AUDIENCE
			})
		).resolves.toEqual({
			kind: 'service_token',
			subject: '0123456789abcdef0123456789abcdef'
		});
	});

	it('still rejects an empty subject without common_name', async () => {
		const rejection = verifier().verify(signedToken({ sub: '', common_name: '' }), {
			issuer: ISSUER,
			audience: AUDIENCE
		});
		await expect(rejection).rejects.toMatchObject({ reason: 'subject_invalid' });
	});

	it('rejects a tampered signature with reason signature_invalid', async () => {
		const [header, claims, signature] = signedToken().split('.');
		// Change the first base64url sextet, which always changes decoded signature
		// bits. Altering only the final character can leave unused padding bits
		// unchanged and accidentally produce the original bytes.
		const tampered_signature = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
		const tampered = `${header}.${claims}.${tampered_signature}`;

		const rejection = verifier().verify(tampered, { issuer: ISSUER, audience: AUDIENCE });
		await expect(rejection).rejects.toBeInstanceOf(CloudflareAccessVerificationError);
		await expect(rejection).rejects.toMatchObject({ reason: 'signature_invalid' });
	});

	it('rejects a structurally malformed token with reason token_malformed', async () => {
		const rejection = verifier().verify('not-a-jwt', { issuer: ISSUER, audience: AUDIENCE });
		await expect(rejection).rejects.toMatchObject({ reason: 'token_malformed' });
	});

	it('rejects a token whose header is not valid base64url JSON with reason token_malformed', async () => {
		const [, claims, signature] = signedToken().split('.');
		const rejection = verifier().verify(`not!base64.${claims}.${signature}`, {
			issuer: ISSUER,
			audience: AUDIENCE
		});
		await expect(rejection).rejects.toMatchObject({ reason: 'token_malformed' });
	});

	it('rejects a non-RS256 algorithm with reason jwt_alg_invalid', async () => {
		const header = encode({ alg: 'HS256', typ: 'JWT', kid: KID });
		const [, claims, signature] = signedToken().split('.');
		const rejection = verifier().verify(`${header}.${claims}.${signature}`, {
			issuer: ISSUER,
			audience: AUDIENCE
		});
		await expect(rejection).rejects.toMatchObject({ reason: 'jwt_alg_invalid' });
	});

	it('rejects a wrong typ with reason jwt_typ_invalid', async () => {
		const header = encode({ alg: 'RS256', typ: 'NOTJWT', kid: KID });
		const [, claims, signature] = signedToken().split('.');
		const rejection = verifier().verify(`${header}.${claims}.${signature}`, {
			issuer: ISSUER,
			audience: AUDIENCE
		});
		await expect(rejection).rejects.toMatchObject({ reason: 'jwt_typ_invalid' });
	});

	it('rejects a missing kid with reason jwt_kid_invalid', async () => {
		const header = encode({ alg: 'RS256', typ: 'JWT' });
		const [, claims, signature] = signedToken().split('.');
		const rejection = verifier().verify(`${header}.${claims}.${signature}`, {
			issuer: ISSUER,
			audience: AUDIENCE
		});
		await expect(rejection).rejects.toMatchObject({ reason: 'jwt_kid_invalid' });
	});

	it('accepts a header omitting the optional typ, as Cloudflare Access sends', async () => {
		// RFC 7519 §5.1 makes `typ` optional and Cloudflare Access app tokens
		// omit it; requiring it rejected every genuine login. Signed over the
		// typ-less header so this exercises real verification, not a shortcut.
		const token = signedToken({}, { alg: 'RS256', kid: KID });
		const principal = await verifier().verify(token, {
			issuer: ISSUER,
			audience: AUDIENCE
		});
		expect(principal.email).toBe('person@example.test');
	});

	it('rejects an unknown signing key with reason signing_key_not_found', async () => {
		const unknown_kid_verifier = createCloudflareAccessVerifier(
			async () =>
				new Response(
					JSON.stringify({ keys: [{ ...jwk, kid: 'other-key', alg: 'RS256', use: 'sig' }] })
				),
			() => NOW_MS
		);

		const rejection = unknown_kid_verifier.verify(signedToken(), {
			issuer: ISSUER,
			audience: AUDIENCE
		});
		await expect(rejection).rejects.toMatchObject({ reason: 'signing_key_not_found' });
	});

	it('rejects when key import or WebCrypto verification throws, with reason signature_error', async () => {
		// WebCrypto's own base64url decoding tolerates a malformed JWK, so the
		// realistic trigger for this branch is the underlying primitive
		// throwing (e.g. an engine/key-handling fault) rather than bad input
		// shape, which `isRsaJwk` already screens out.
		vi.spyOn(crypto.subtle, 'importKey').mockRejectedValueOnce(new Error('key import failed'));

		const rejection = verifier().verify(signedToken(), { issuer: ISSUER, audience: AUDIENCE });
		await expect(rejection).rejects.toMatchObject({ reason: 'signature_error' });
	});

	it('rejects when the JWKS endpoint cannot be reached with reason jwks_fetch_failed', async () => {
		const unreachable_verifier = createCloudflareAccessVerifier(
			async () => {
				throw new Error('network down');
			},
			() => NOW_MS
		);

		const rejection = unreachable_verifier.verify(signedToken(), {
			issuer: ISSUER,
			audience: AUDIENCE
		});
		await expect(rejection).rejects.toMatchObject({ reason: 'jwks_fetch_failed' });
	});

	it('rejects a non-ok JWKS response with reason jwks_fetch_failed', async () => {
		const failing_verifier = createCloudflareAccessVerifier(
			async () => new Response('nope', { status: 500 }),
			() => NOW_MS
		);

		const rejection = failing_verifier.verify(signedToken(), {
			issuer: ISSUER,
			audience: AUDIENCE
		});
		await expect(rejection).rejects.toMatchObject({ reason: 'jwks_fetch_failed' });
	});

	it.each([
		['invalid JSON body', () => new Response('not json')],
		['a keys field that is not an array', () => new Response(JSON.stringify({ keys: 'nope' }))],
		['an empty keys array', () => new Response(JSON.stringify({ keys: [] }))]
	])('rejects a JWKS response with %s with reason jwks_malformed', async (_name, respond) => {
		const malformed_verifier = createCloudflareAccessVerifier(
			async () => respond(),
			() => NOW_MS
		);

		const rejection = malformed_verifier.verify(signedToken(), {
			issuer: ISSUER,
			audience: AUDIENCE
		});
		await expect(rejection).rejects.toMatchObject({ reason: 'jwks_malformed' });
	});
});
