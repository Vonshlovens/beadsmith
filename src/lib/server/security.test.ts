import { describe, expect, it } from 'vitest';
import {
	BUCKET_WINDOW_MS,
	MUTATION_BUCKET_CAPACITY,
	READ_BUCKET_CAPACITY,
	createRateLimiter,
	errorBody,
	errorFromException,
	errorResponse,
	expectedOrigin,
	isAcceptableOrigin,
	isAllowedHost,
	jsonResponse,
	parseHostname,
	passesCsrfGate,
	requiresCsrfHeader,
	safeEqual,
	scrubSecretLines,
	statusForErrorCode
} from './security.js';
import { DoltConnectionError, DoltError } from './dolt/client.js';
import { DispatchError } from './dispatch/types.js';
import { ProjectDiscoveryError } from './discovery.js';

describe('parseHostname', () => {
	it('strips the port', () => {
		expect(parseHostname('localhost:5173')).toBe('localhost');
	});

	it('keeps bracketed IPv6 literals intact', () => {
		expect(parseHostname('[::1]:5173')).toBe('[::1]');
	});
});

describe('isAllowedHost', () => {
	it('accepts loopback names on any port', () => {
		expect(isAllowedHost('localhost:5173')).toBe(true);
		expect(isAllowedHost('127.0.0.1:3000')).toBe(true);
		expect(isAllowedHost('[::1]:8080')).toBe(true);
	});

	it('rejects a rebinding host that is not allow-listed', () => {
		expect(isAllowedHost('evil.example.com')).toBe(false);
	});

	it('rejects a host that merely embeds a loopback name', () => {
		expect(isAllowedHost('localhost.evil.example.com')).toBe(false);
	});

	it('accepts an explicitly allow-listed host', () => {
		expect(isAllowedHost('beads.local:5173', ['beads.local'])).toBe(true);
	});

	it('rejects a missing host header', () => {
		expect(isAllowedHost(null)).toBe(false);
	});
});

describe('isAcceptableOrigin', () => {
	it('accepts an absent Origin', () => {
		expect(isAcceptableOrigin(null, 'http://localhost:5173')).toBe(true);
	});

	it('accepts an exactly matching Origin', () => {
		expect(isAcceptableOrigin('http://localhost:5173', 'http://localhost:5173')).toBe(true);
	});

	it('rejects a different Origin', () => {
		expect(isAcceptableOrigin('http://evil.example.com', 'http://localhost:5173')).toBe(false);
	});

	it('rejects the opaque null Origin', () => {
		expect(isAcceptableOrigin('null', 'http://localhost:5173')).toBe(false);
	});

	it('rejects a scheme-only mismatch', () => {
		expect(isAcceptableOrigin('https://localhost:5173', 'http://localhost:5173')).toBe(false);
	});
});

describe('expectedOrigin', () => {
	const public_origin = {
		hostname: 'beads.example.com',
		origin: 'https://beads.example.com'
	};

	it('returns the request origin unchanged when no public origin is configured', () => {
		expect(expectedOrigin('beads.example.com', 'http://beads.example.com', undefined)).toBe(
			'http://beads.example.com'
		);
	});

	it('returns the configured public origin when the Host matches exactly', () => {
		expect(expectedOrigin('beads.example.com', 'http://beads.example.com', public_origin)).toBe(
			'https://beads.example.com'
		);
	});

	it('matches the Host header regardless of a port suffix', () => {
		expect(
			expectedOrigin('beads.example.com:4321', 'http://beads.example.com:4321', public_origin)
		).toBe('https://beads.example.com');
	});

	it('falls back to the request origin for a different host', () => {
		expect(expectedOrigin('localhost:5173', 'http://localhost:5173', public_origin)).toBe(
			'http://localhost:5173'
		);
	});

	it('falls back to the request origin when Host is absent', () => {
		expect(expectedOrigin(null, 'http://localhost:5173', public_origin)).toBe(
			'http://localhost:5173'
		);
	});

	it('is not influenced by any forwarded-header value, because it never reads one', () => {
		// expectedOrigin's signature intentionally has no forwarded-header
		// parameter: a hostile caller has no input that changes this result
		// beyond the raw Host header, which is already gated by isAllowedHost.
		expect(expectedOrigin('evil.example.com', 'http://evil.example.com', public_origin)).toBe(
			'http://evil.example.com'
		);
	});
});

describe('CSRF gate', () => {
	it('treats GET, HEAD, and OPTIONS as safe', () => {
		expect(requiresCsrfHeader('GET')).toBe(false);
		expect(requiresCsrfHeader('head')).toBe(false);
		expect(requiresCsrfHeader('OPTIONS')).toBe(false);
	});

	it('treats every other method as a mutation', () => {
		expect(requiresCsrfHeader('POST')).toBe(true);
		expect(requiresCsrfHeader('DELETE')).toBe(true);
		expect(requiresCsrfHeader('PATCH')).toBe(true);
	});

	it('passes a mutation carrying the custom header', () => {
		expect(passesCsrfGate('POST', '1')).toBe(true);
	});

	it('blocks a mutation without the custom header', () => {
		expect(passesCsrfGate('POST', null)).toBe(false);
	});

	it('blocks a mutation with a wrong header value', () => {
		expect(passesCsrfGate('POST', 'true')).toBe(false);
	});
});

describe('safeEqual', () => {
	it('matches identical secrets', () => {
		expect(safeEqual('token-value', 'token-value')).toBe(true);
	});

	it('rejects different secrets of equal length', () => {
		expect(safeEqual('token-value', 'token-valve')).toBe(false);
	});

	it('rejects secrets of different lengths', () => {
		expect(safeEqual('short', 'a-much-longer-token')).toBe(false);
	});
});

describe('scrubSecretLines', () => {
	it('drops lines mentioning a password', () => {
		const text = 'warning: .beads has permissions 0755\npassword=hunter2\nok';

		expect(scrubSecretLines(text)).toBe('warning: .beads has permissions 0755\nok');
	});

	it('drops lines mentioning a token or secret', () => {
		expect(scrubSecretLines('auth TOKEN abc\nSecret: xyz\nkeep')).toBe('keep');
	});

	it('leaves clean text untouched', () => {
		expect(scrubSecretLines('database acme not found on Dolt server')).toBe(
			'database acme not found on Dolt server'
		);
	});
});

describe('createRateLimiter', () => {
	it('allows the full read budget', () => {
		const limiter = createRateLimiter(() => {
			return 0;
		});

		const allowed = new Array(READ_BUCKET_CAPACITY).fill(0).every(() => {
			return limiter.consume('session', 'read');
		});

		expect(allowed).toBe(true);
	});

	it('rejects reads beyond the budget', () => {
		const limiter = createRateLimiter(() => {
			return 0;
		});
		for (let index = 0; index < READ_BUCKET_CAPACITY; index += 1) {
			limiter.consume('session', 'read');
		}

		const result = limiter.consume('session', 'read');

		expect(result).toBe(false);
	});

	it('rejects mutations beyond the smaller mutation budget', () => {
		const limiter = createRateLimiter(() => {
			return 0;
		});
		for (let index = 0; index < MUTATION_BUCKET_CAPACITY; index += 1) {
			limiter.consume('session', 'mutation');
		}

		const result = limiter.consume('session', 'mutation');

		expect(result).toBe(false);
	});

	it('refills the bucket as time passes', () => {
		let now = 0;
		const limiter = createRateLimiter(() => {
			return now;
		});
		for (let index = 0; index < MUTATION_BUCKET_CAPACITY; index += 1) {
			limiter.consume('session', 'mutation');
		}

		now = BUCKET_WINDOW_MS;

		expect(limiter.consume('session', 'mutation')).toBe(true);
	});

	it('keeps buckets separate per session', () => {
		const limiter = createRateLimiter(() => {
			return 0;
		});
		for (let index = 0; index < MUTATION_BUCKET_CAPACITY; index += 1) {
			limiter.consume('session-a', 'mutation');
		}

		expect(limiter.consume('session-b', 'mutation')).toBe(true);
	});
});

describe('error responses', () => {
	it('maps every code to its documented status', () => {
		expect(statusForErrorCode('bad_request')).toBe(400);
		expect(statusForErrorCode('unauthorized')).toBe(401);
		expect(statusForErrorCode('forbidden')).toBe(403);
		expect(statusForErrorCode('not_found')).toBe(404);
		expect(statusForErrorCode('conflict')).toBe(409);
		expect(statusForErrorCode('rate_limited')).toBe(429);
		expect(statusForErrorCode('unavailable')).toBe(503);
	});

	it('scrubs credential lines out of the body', () => {
		const body = errorBody('unavailable', 'failed\npassword=hunter2');

		expect(body.error.message).toBe('failed');
	});

	it('sets no-store on error responses', () => {
		const response = errorResponse('not_found', 'missing');

		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.status).toBe(404);
	});

	it('sets no-store on success responses', () => {
		const response = jsonResponse({ ok: true });

		expect(response.headers.get('cache-control')).toBe('no-store');
	});
});

describe('errorFromException', () => {
	it('maps a DoltError to dolt_error', () => {
		const error = new DoltError('private-host:3306 sql-user password=not-safe');

		const response = errorFromException(error);

		expect(response.status).toBe(502);
		return response.json().then((body) => {
			expect(body).toEqual({
				error: { code: 'dolt_error', message: 'Remote Dolt query failed.' }
			});
		});
	});

	it('preserves only the fixed safe message and class of a Dolt connection failure', async () => {
		const response = errorFromException(new DoltConnectionError('authentication_rejected'));

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			error: {
				code: 'unavailable',
				message: 'Dolt authentication was rejected. Check the configured service credentials.',
				failure_kind: 'authentication_rejected'
			}
		});
	});

	it("preserves a discovery failure's safe class without its cause", async () => {
		const response = errorFromException(new ProjectDiscoveryError('unreachable'));

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			error: {
				code: 'unavailable',
				message:
					'Remote project discovery is unavailable because the Dolt server cannot be reached.',
				failure_kind: 'unreachable'
			}
		});
	});

	it('maps a DispatchError to its declared code and message', async () => {
		const response = errorFromException(
			new DispatchError('forbidden', 'Agent dispatch is not configured on this service.')
		);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: {
				code: 'forbidden',
				message: 'Agent dispatch is not configured on this service.'
			}
		});
	});

	it('never exposes an unrecognised error message', async () => {
		const response = errorFromException(
			new Error('mysql://sql-user:password@private-host:3306/beads_web')
		);

		expect(response.status).toBe(503);
		const body = await response.json();
		expect(body).toEqual({
			error: { code: 'unavailable', message: 'The requested service is currently unavailable.' }
		});
		expect(JSON.stringify(body)).not.toContain('private-host');
		expect(JSON.stringify(body)).not.toContain('sql-user');
		expect(JSON.stringify(body)).not.toContain('beads_web');
	});

	it('falls back for unknown throwables', () => {
		const response = errorFromException('boom', 'unavailable');

		expect(response.status).toBe(503);
	});
});
