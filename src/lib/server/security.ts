import { timingSafeEqual } from 'node:crypto';
import { LOOPBACK_HOSTNAMES } from './env.js';
import { ProjectDiscoveryError } from './discovery.js';
import { DoltError, isDoltConnectionError } from './dolt/client.js';
import { DispatchError } from './dispatch/types.js';
import { UnsupportedSchemaError } from './dolt/schema.js';
import type { ApiErrorBody, ApiErrorCode, DoltFailureKind } from '$lib/types.js';

/**
 * `__Host-` prefix: cookies ignore ports, so without it any other local HTTP
 * server could shadow this cookie for the whole `localhost` origin. It is
 * Better Auth's signed session cookie (ADR-0011).
 */
export const SESSION_COOKIE = '__Host-bdx_session';
export const CSRF_HEADER = 'x-bdx-request';
export const CSRF_HEADER_VALUE = '1';
export const READ_BUCKET_CAPACITY = 60;
export const MUTATION_BUCKET_CAPACITY = 20;
export const BUCKET_WINDOW_MS = 10_000;
/** Password attempts per client address (ADR-0011): 10 per minute. */
export const CREDENTIAL_BUCKET_CAPACITY = 10;
export const CREDENTIAL_BUCKET_WINDOW_MS = 60_000;

const SECRET_LINE_PATTERN = /password|token|secret/i;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const SECURITY_HEADERS: Record<string, string> = {
	'X-Content-Type-Options': 'nosniff',
	'Referrer-Policy': 'no-referrer',
	'Cross-Origin-Opener-Policy': 'same-origin',
	'Cross-Origin-Resource-Policy': 'same-origin'
};

/**
 * Drop any output line that mentions a credential before it reaches a client.
 * @param text Raw text (typically `bd` stderr).
 */
export function scrubSecretLines(text: string): string {
	if (text.length === 0) {
		return text;
	}
	return text
		.split('\n')
		.filter((line) => {
			return !SECRET_LINE_PATTERN.test(line);
		})
		.join('\n');
}

/**
 * Strip the port from a raw `Host` header value, handling bracketed IPv6.
 * @param host Raw header value.
 */
export function parseHostname(host: string): string {
	const trimmed = host.trim().toLowerCase();
	if (trimmed.startsWith('[')) {
		const end = trimmed.indexOf(']');
		if (end === -1) {
			return trimmed;
		}
		return trimmed.slice(0, end + 1);
	}
	const colon = trimmed.indexOf(':');
	if (colon === -1) {
		return trimmed;
	}
	return trimmed.slice(0, colon);
}

/**
 * DNS-rebinding defense: only loopback names (any port) and explicitly
 * allowed hosts may reach the server.
 * @param host Raw `Host` header value.
 * @param allowed_hosts Extra hostnames from `BDX_ALLOWED_HOSTS`.
 */
export function isAllowedHost(host: string | null, allowed_hosts: string[] = []): boolean {
	if (host === null || host.trim().length === 0) {
		return false;
	}
	const hostname = parseHostname(host);
	if (LOOPBACK_HOSTNAMES.includes(hostname)) {
		return true;
	}
	return allowed_hosts.some((entry) => {
		return parseHostname(entry) === hostname;
	});
}

/**
 * Origin check: absent is fine, present must match the request origin exactly.
 * @param origin Raw `Origin` header value.
 * @param request_origin `event.url.origin`.
 */
export function isAcceptableOrigin(origin: string | null, request_origin: string): boolean {
	if (origin === null || origin === 'null') {
		return origin === null;
	}
	return origin === request_origin;
}

/**
 * Resolve the origin the browser `Origin` header must match.
 *
 * Behind a TLS-terminating proxy (Cloudflare Tunnel) the adapter computes
 * `event.url.origin` from the plain-HTTP loopback hop, so it disagrees with
 * the `https://` origin a real browser sends. This corrects only that one
 * case: when the raw `Host` header (already checked against the allowed-host
 * list by the caller) exactly matches the operator-configured public host, the
 * expected origin becomes the operator-configured public origin instead of
 * `event.url.origin`. Every other request keeps today's strict same-origin
 * comparison. The result is driven solely by the Host header and static
 * server configuration — never by `X-Forwarded-*` or any other client-
 * supplied header — so a caller cannot make this resolve to any origin other
 * than the single one the operator configured.
 * @param raw_host Raw `Host` header value.
 * @param request_origin `event.url.origin`, used unless the public-origin
 *   override applies.
 * @param public_origin Operator-configured public origin, if any.
 */
export function expectedOrigin(
	raw_host: string | null,
	request_origin: string,
	public_origin?: { hostname: string; origin: string }
): string {
	if (public_origin === undefined || raw_host === null) {
		return request_origin;
	}
	if (parseHostname(raw_host) !== public_origin.hostname) {
		return request_origin;
	}
	return public_origin.origin;
}

/**
 * Fetch-metadata check. Browsers always send `Sec-Fetch-Site`; a cross-site
 * page loading a loopback URL as an image or script sends `cross-site` while
 * omitting `Origin`, so this closes the gap the origin check cannot see.
 * A missing header means a non-browser client (curl, tests) and is allowed —
 * those cannot be driven by a hostile page.
 * @param site Raw `Sec-Fetch-Site` header value.
 */
export function isAcceptableFetchSite(site: string | null): boolean {
	if (site === null) {
		return true;
	}
	return site === 'same-origin' || site === 'same-site' || site === 'none';
}

/**
 * True when the request is a real page visit rather than a subresource load.
 * Only these may mint a session, so a hostile page cannot churn the session
 * table and evict the live session. Missing headers mean a non-browser client.
 * @param headers Request headers.
 */
export function isTopLevelNavigation(headers: Headers): boolean {
	const dest = headers.get('sec-fetch-dest');
	const mode = headers.get('sec-fetch-mode');
	if (dest === null && mode === null) {
		return true;
	}
	return dest === 'document' && mode === 'navigate';
}

/**
 * True when the method mutates and therefore needs the custom CSRF header.
 * @param method HTTP method.
 */
export function requiresCsrfHeader(method: string): boolean {
	return !SAFE_METHODS.has(method.toUpperCase());
}

/**
 * True when the method does not mutate state.
 * @param method HTTP method.
 */
export function isSafeMethod(method: string): boolean {
	return SAFE_METHODS.has(method.toUpperCase());
}

/**
 * Verify the custom-header CSRF gate.
 * @param method HTTP method.
 * @param header_value Value of `x-bdx-request`.
 */
export function passesCsrfGate(method: string, header_value: string | null): boolean {
	if (!requiresCsrfHeader(method)) {
		return true;
	}
	return header_value === CSRF_HEADER_VALUE;
}

/**
 * Constant-time secret comparison that does not leak length through timing
 * branches beyond the unavoidable length check.
 * @param a First value.
 * @param b Second value.
 */
export function safeEqual(a: string, b: string): boolean {
	const buf_a = Buffer.from(a, 'utf8');
	const buf_b = Buffer.from(b, 'utf8');
	if (buf_a.length !== buf_b.length) {
		// Still burn a comparison so the fast path is not obviously shorter.
		timingSafeEqual(buf_a, buf_a);
		return false;
	}
	return timingSafeEqual(buf_a, buf_b);
}

export type RateLimitKind = 'read' | 'mutation' | 'credential';

export interface RateLimiter {
	/**
	 * @param key Session id (or a fallback key).
	 * @param kind Bucket to charge.
	 * @returns true when the request may proceed.
	 */
	consume(key: string, kind: RateLimitKind): boolean;
}

interface Bucket {
	tokens: number;
	updated_at: number;
}

/**
 * Token-bucket rate limiter: 60 reads / 10s and 20 mutations / 10s per
 * session, plus 10 password attempts / 60s per client address.
 * @param now Injectable clock (tests).
 */
export function createRateLimiter(now: () => number = Date.now): RateLimiter {
	const buckets = new Map<string, Bucket>();

	/**
	 * Refill and charge one token.
	 * @param key Bucket key.
	 * @param capacity Bucket capacity.
	 * @param window_ms Time to refill a whole bucket.
	 */
	function take(key: string, capacity: number, window_ms: number): boolean {
		const current = now();
		const bucket = buckets.get(key) ?? { tokens: capacity, updated_at: current };
		const elapsed = current - bucket.updated_at;
		if (elapsed > 0) {
			const refill = (elapsed / window_ms) * capacity;
			bucket.tokens = Math.min(capacity, bucket.tokens + refill);
			bucket.updated_at = current;
		}
		if (bucket.tokens < 1) {
			buckets.set(key, bucket);
			return false;
		}
		bucket.tokens -= 1;
		buckets.set(key, bucket);
		return true;
	}

	return {
		consume(key: string, kind: RateLimitKind): boolean {
			if (kind === 'credential') {
				return take(`${kind}:${key}`, CREDENTIAL_BUCKET_CAPACITY, CREDENTIAL_BUCKET_WINDOW_MS);
			}
			const capacity = kind === 'mutation' ? MUTATION_BUCKET_CAPACITY : READ_BUCKET_CAPACITY;
			return take(`${kind}:${key}`, capacity, BUCKET_WINDOW_MS);
		}
	};
}

const ERROR_STATUS: Record<ApiErrorCode, number> = {
	bad_request: 400,
	unauthorized: 401,
	forbidden: 403,
	not_found: 404,
	conflict: 409,
	dolt_error: 502,
	rate_limited: 429,
	unavailable: 503
};

/**
 * HTTP status for an API error code.
 * @param code Contract error code.
 */
export function statusForErrorCode(code: ApiErrorCode): number {
	return ERROR_STATUS[code];
}

/**
 * Build the contract error body.
 * @param code Contract error code.
 * @param message Human message; scrubbed of credential-bearing lines.
 */
export function errorBody(
	code: ApiErrorCode,
	message: string,
	failure_kind?: DoltFailureKind
): ApiErrorBody {
	const safe_message = scrubSecretLines(message).trim() || 'Request failed.';
	return {
		error: {
			code,
			message: safe_message,
			...(failure_kind === undefined ? {} : { failure_kind })
		}
	};
}

/**
 * JSON error response with `Cache-Control: no-store`.
 * @param code Contract error code.
 * @param message Human message.
 */
export function errorResponse(
	code: ApiErrorCode,
	message: string,
	failure_kind?: DoltFailureKind
): Response {
	return new Response(JSON.stringify(errorBody(code, message, failure_kind)), {
		status: statusForErrorCode(code),
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
	});
}

/**
 * JSON success response with `Cache-Control: no-store`.
 * @param payload Body to serialise.
 * @param status HTTP status.
 */
export function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
	});
}

/**
 * Map a thrown error onto the contract error shape.
 *
 * Only known safe adapter errors retain their fixed message. Unknown errors
 * are deliberately collapsed so driver, filesystem, and connection detail
 * cannot reach a browser response.
 * @param error Caught value.
 * @param fallback Code used for unrecognised errors.
 */
export function errorFromException(
	error: unknown,
	fallback: ApiErrorCode = 'unavailable'
): Response {
	if (isDoltConnectionError(error)) {
		return errorResponse('unavailable', error.message, error.kind);
	}
	if (error instanceof ProjectDiscoveryError) {
		return errorResponse('unavailable', error.message, error.failure_kind);
	}
	if (error instanceof DispatchError) {
		return errorResponse(error.code, error.message);
	}
	if (error instanceof UnsupportedSchemaError) {
		return errorResponse('unavailable', error.message);
	}
	if (error instanceof DoltError) {
		return errorResponse('dolt_error', 'Remote Dolt query failed.');
	}
	return errorResponse(fallback, 'The requested service is currently unavailable.');
}

let rate_limiter: RateLimiter | undefined;

/** Process-wide rate limiter. */
export function getRateLimiter(): RateLimiter {
	if (rate_limiter === undefined) {
		rate_limiter = createRateLimiter();
	}
	return rate_limiter;
}
