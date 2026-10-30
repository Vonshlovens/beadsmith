import type { Handle, HandleServerError, ServerInit } from '@sveltejs/kit';
import { startBackupScheduler } from '$lib/server/backup/runtime.js';
import {
	checkConfig,
	getEnv,
	isAllowedCloudflareAccessServiceToken,
	isLoopbackHost
} from '$lib/server/env.js';
import {
	CloudflareAccessVerificationError,
	getCloudflareAccessVerifier,
	normalizeCloudflareAccessIssuer
} from '$lib/server/cloudflare-access.js';
import { getStateStore } from '$lib/server/state/db.js';
import { getAuthService } from '$lib/server/auth/service.js';
import { requiredPermission, roleCan } from '$lib/server/auth/roles.js';
import {
	CSRF_HEADER,
	errorResponse,
	expectedOrigin,
	getRateLimiter,
	isAcceptableFetchSite,
	isAcceptableOrigin,
	isAllowedHost,
	isSafeMethod,
	isTopLevelNavigation,
	parseHostname,
	passesCsrfGate,
	requiresCsrfHeader,
	SECURITY_HEADERS
} from '$lib/server/security.js';

let config_error_logged = false;

/**
 * Configuration the server cannot run without (`checkConfig`) fails every
 * request closed with 403. The detailed reason goes to the server log only.
 */
function configError(): string | undefined {
	const error = checkConfig(getEnv());
	if (error !== undefined && !config_error_logged) {
		config_error_logged = true;
		console.error(`beads-web refusing all requests: ${error}`);
	}
	return error;
}

const HEALTH_PATH = '/healthz';
const SIGN_IN_PATH = '/auth';
/** Better Auth endpoints; the route itself exposes only an allowlist. */
const AUTH_API_PREFIX = '/api/auth/';
/** Credential attempts charged to the small per-address `credential` bucket. */
const CREDENTIAL_PATHS = [
	'/api/auth/sign-in/email',
	'/api/auth/sign-up/email',
	'/api/auth/change-password'
];

/** Single greppable prefix for every Cloudflare Access denial log line. */
const CLOUDFLARE_ACCESS_DENY_LOG_PREFIX = 'beads-web cloudflare-access-denied';

/**
 * Log a Cloudflare Access rejection with a machine-readable reason and the
 * request path only. Never pass token contents, a signature, or an email —
 * `reason` must be one of the fixed reason codes, never free text derived
 * from request data.
 */
function logCloudflareAccessDenial(reason: string, pathname: string): void {
	console.error(`${CLOUDFLARE_ACCESS_DENY_LOG_PREFIX} reason=${reason} path=${pathname}`);
}

/**
 * Client address for rate limiting, falling back to a constant when the
 * platform cannot supply one (SvelteKit throws rather than returning null).
 * @param event Request event.
 */
function clientAddress(event: Parameters<Handle>[0]['event']): string {
	try {
		return event.getClientAddress();
	} catch {
		return 'unknown';
	}
}

/**
 * True when `pathname` may be served without a signed-in account: the
 * sign-in page, its build assets, and the Better Auth endpoints.
 * @param pathname Request path.
 */
function isSignedOutPath(pathname: string): boolean {
	return (
		pathname === SIGN_IN_PATH ||
		pathname.startsWith(`${SIGN_IN_PATH}/`) ||
		pathname.startsWith('/_app/') ||
		pathname.startsWith('/favicon') ||
		pathname === '/robots.txt' ||
		pathname.startsWith(AUTH_API_PREFIX)
	);
}

let accounts_error_logged = false;

/**
 * Log, once, why the account service could not open. AuthSecretError and
 * driver messages name a variable or a path at most, never secret bytes.
 */
function logAccountsUnavailable(error: unknown): void {
	if (accounts_error_logged) {
		return;
	}
	accounts_error_logged = true;
	const detail = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
	console.error(`beads-web refusing all requests: accounts unavailable (${detail})`);
}

/**
 * `/auth?redirect=...` for a signed-out page visit, so sign-in can return there.
 * @param url Request URL.
 */
function signInLocation(url: URL): string {
	const target = `${url.pathname}${url.search}`;
	return target === '/' ? SIGN_IN_PATH : `${SIGN_IN_PATH}?redirect=${encodeURIComponent(target)}`;
}

/**
 * Append `Set-Cookie` values (a refreshed or cleared session) to a response.
 * @param response Outgoing response.
 * @param set_cookies Raw `Set-Cookie` header values.
 */
function withSetCookies(response: Response, set_cookies: string[]): Response {
	for (const value of set_cookies) {
		response.headers.append('set-cookie', value);
	}
	return response;
}

type HandleEvent = Parameters<Handle>[0]['event'];

interface Identity {
	/** Rate-limit key: the session id, or '' for a sessionless caller. */
	session_id: string;
	set_cookies: string[];
}

/**
 * Establish who is calling and set `locals.user` / `locals.role`, or return
 * the response that refuses the request.
 *
 * Every route except the sign-in page and `/api/auth/*` needs a Better Auth
 * session (ADR-0011). A verified Access service-token principal may read
 * `/api` with GET/HEAD and no cookie; it is a read-only `member` and never
 * mints a session.
 * @param event Request event.
 * @param is_api Whether the request targets `/api`.
 * @param method Upper-case HTTP method.
 */
async function establishIdentity(
	event: HandleEvent,
	is_api: boolean,
	method: string
): Promise<Identity | Response> {
	const service_token = event.locals.cloudflare_access?.kind === 'service_token';
	const service_token_api_read = service_token && is_api && (method === 'GET' || method === 'HEAD');

	let lookup;
	try {
		lookup = await (await getAuthService()).lookupSession(event.request.headers);
	} catch (error) {
		logAccountsUnavailable(error);
		return errorResponse('unavailable', 'sign-in is unavailable; see the server log');
	}
	const { session, set_cookies } = lookup;
	if (session !== null) {
		event.locals.session_id = session.session_id;
		event.locals.user = session.user;
		event.locals.role = session.user.role;
		return { session_id: session.session_id, set_cookies };
	}
	event.locals.session_id = '';
	if (service_token_api_read) {
		event.locals.role = 'member';
		return { session_id: '', set_cookies };
	}
	if (isSignedOutPath(event.url.pathname)) {
		return { session_id: '', set_cookies };
	}
	if (is_api) {
		return withSetCookies(errorResponse('unauthorized', 'session required'), set_cookies);
	}
	if (service_token) {
		return errorResponse('forbidden', 'session required');
	}
	return withSetCookies(
		new Response(null, { status: 303, headers: { location: signInLocation(event.url) } }),
		set_cookies
	);
}

/**
 * Refuse an `/api` request the caller's role does not permit. Pages are
 * checked by their own load (`/console/+layout.server.ts`) so they can render
 * the error page; their data still comes from these API routes.
 * @param event Request event.
 * @param is_api Whether the request targets `/api`.
 * @param method Upper-case HTTP method.
 */
function roleDenial(event: HandleEvent, is_api: boolean, method: string): Response | undefined {
	if (!is_api) {
		return undefined;
	}
	const permission = requiredPermission(method, event.url.pathname);
	if (permission === undefined || roleCan(event.locals.role, permission)) {
		return undefined;
	}
	return errorResponse('forbidden', 'admin role required');
}

/** The deliberately isolated health probe cannot be reached through a tunnel. */
function isDirectLoopbackHealthRequest(
	event: Parameters<Handle>[0]['event'],
	host: string | null
): boolean {
	return (
		host !== null && isLoopbackHost(parseHostname(host)) && isLoopbackHost(clientAddress(event))
	);
}

/** Settings key and template placeholder for the UI theme preference. */
const THEME_SETTING_KEY = 'ui.theme';
const THEME_PLACEHOLDER = '%bdui.theme%';
const THEME_PREFERENCES = ['system', 'light', 'dark'];
const DEFAULT_THEME = 'system';

/**
 * The stored theme preference for the HTML shell, so the blocking script in
 * `app.html` can resolve it before first paint. Unset, unrecognised, or
 * unreadable values all fall back to `system`: the state DB must never be able
 * to fail a page request.
 */
async function themePreference(): Promise<string> {
	try {
		const store = await getStateStore();
		const value = await store.getSetting(THEME_SETTING_KEY);
		return value !== undefined && THEME_PREFERENCES.includes(value) ? value : DEFAULT_THEME;
	} catch {
		return DEFAULT_THEME;
	}
}

/**
 * Apply the standard security headers to a response.
 * @param response Response to decorate.
 * @param is_api Whether the request targeted `/api`.
 */
function applySecurityHeaders(response: Response, is_api: boolean): Response {
	for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
		response.headers.set(name, value);
	}
	if (is_api) {
		response.headers.set('Cache-Control', 'no-store');
	}
	return response;
}

/** Runs once at server start (not in unit tests, which never call it). */
export const init: ServerInit = () => {
	startBackupScheduler();
	// Generate the auth secret and, on a fresh install, write the first-admin
	// setup token now so the operator sees where it is.
	void getAuthService()
		.then((service) => service.needsBootstrap())
		.catch(logAccountsUnavailable);
};

export const handle: Handle = async ({ event, resolve }) => {
	const env = getEnv();
	const is_api = event.url.pathname.startsWith('/api');
	const method = event.request.method.toUpperCase();

	if (configError() !== undefined) {
		return applySecurityHeaders(
			errorResponse('forbidden', 'server configuration rejected; see the server log'),
			is_api
		);
	}

	// Health is intentionally handled before all application/session/catalog
	// behavior. A route cannot use it as an auth bypass: both the socket peer
	// and Host must be loopback, and it returns no body or identity/session.
	if (event.url.pathname === HEALTH_PATH) {
		if (!isDirectLoopbackHealthRequest(event, event.request.headers.get('host'))) {
			return applySecurityHeaders(errorResponse('forbidden', 'health probe not allowed'), is_api);
		}
		return applySecurityHeaders(
			new Response(null, {
				status: 204,
				headers: { 'cache-control': 'no-store' }
			}),
			is_api
		);
	}

	// Internal SSR fetches (`event.fetch` from load functions) are synthesized
	// by the framework, carry no Host header, and only exist inside a request
	// that already passed the transport gates below. They get fresh `locals`,
	// though, so identity and role are established again from the forwarded
	// cookie: a member's page load must not read admin-only API data.
	if (event.isSubRequest) {
		const identity = await establishIdentity(event, is_api, method);
		if (identity instanceof Response) {
			return applySecurityHeaders(identity, is_api);
		}
		const denied = roleDenial(event, is_api, method);
		if (denied !== undefined) {
			return applySecurityHeaders(denied, is_api);
		}
		return applySecurityHeaders(withSetCookies(await resolve(event), identity.set_cookies), is_api);
	}

	// 1. DNS-rebinding defense on the raw Host header (not event.url, which the
	//    SvelteKit server derives from that same header).
	const raw_host = event.request.headers.get('host');
	if (!isAllowedHost(raw_host, env.allowed_hosts)) {
		return applySecurityHeaders(errorResponse('forbidden', 'host not allowed'), is_api);
	}

	// 2. Origin must be same-origin when present, for every method. Behind the
	//    configured public host, "same-origin" is corrected to the operator's
	//    configured public scheme (see `expectedOrigin`) rather than trusting
	//    any client-supplied forwarded header.
	const origin = event.request.headers.get('origin');
	const origin_target = expectedOrigin(raw_host, event.url.origin, env.public_origin);
	if (!isAcceptableOrigin(origin, origin_target)) {
		return applySecurityHeaders(
			errorResponse('forbidden', 'cross-origin request rejected'),
			is_api
		);
	}

	// 2b. Fetch metadata: a cross-site page can load loopback URLs as an image
	//     or script without ever sending Origin. Those requests carry
	//     Sec-Fetch-Site: cross-site, so reject them before any work happens.
	//
	//     A cross-site *top-level navigation* with a safe method is exempt, as
	//     in the standard fetch-metadata isolation policy: that is how any
	//     inbound link arrives, and specifically how the browser returns from
	//     the Cloudflare Access login at cloudflareaccess.com, which is a
	//     different site. The exemption is deliberately limited to GET/HEAD
	//     document navigations — a cross-site POST is still rejected here, and
	//     mutations remain covered by the Origin comparison and CSRF gate
	//     below.
	const fetch_site_ok =
		isAcceptableFetchSite(event.request.headers.get('sec-fetch-site')) ||
		(isTopLevelNavigation(event.request.headers) && isSafeMethod(event.request.method));
	if (!fetch_site_ok) {
		return applySecurityHeaders(errorResponse('forbidden', 'cross-site request rejected'), is_api);
	}

	// 3. Cloudflare Access, when configured, is an outer layer in front of
	// everything else (ADR-0005): every route, including sign-in, needs an
	// assertion signed for this issuer and audience, even when its peer is
	// loopback. Which people may pass is the Access policy's job; who they are
	// here is still their account. Only allowlisted service tokens get through.
	if (env.cloudflare_access !== undefined) {
		const issuer = normalizeCloudflareAccessIssuer(env.cloudflare_access.issuer);
		if (issuer === undefined) {
			logCloudflareAccessDenial('issuer_config_invalid', event.url.pathname);
			return applySecurityHeaders(
				errorResponse('forbidden', 'access authentication required'),
				is_api
			);
		}
		const assertion = event.request.headers.get('cf-access-jwt-assertion');
		if (assertion === null) {
			// Cloudflare is not forwarding the JWT at all — a routing/tunnel
			// misconfiguration, not a bad login attempt.
			logCloudflareAccessDenial('assertion_missing', event.url.pathname);
			return applySecurityHeaders(
				errorResponse('forbidden', 'access authentication required'),
				is_api
			);
		}
		try {
			const principal = await getCloudflareAccessVerifier().verify(assertion, {
				issuer,
				audience: env.cloudflare_access.audience
			});
			if (
				principal.kind === 'service_token' &&
				!isAllowedCloudflareAccessServiceToken(
					principal.subject,
					env.cloudflare_access.allowed_service_token_ids
				)
			) {
				logCloudflareAccessDenial('service_token_not_allowlisted', event.url.pathname);
				return applySecurityHeaders(
					errorResponse('forbidden', 'access authentication required'),
					is_api
				);
			}
			event.locals.cloudflare_access = principal;
		} catch (error) {
			const reason =
				error instanceof CloudflareAccessVerificationError
					? error.reason
					: 'verification_unexpected_error';
			logCloudflareAccessDenial(reason, event.url.pathname);
			return applySecurityHeaders(
				errorResponse('forbidden', 'access authentication required'),
				is_api
			);
		}
	}

	// 4. Custom-header CSRF gate for mutations under /api.
	if (is_api && requiresCsrfHeader(method)) {
		if (!passesCsrfGate(method, event.request.headers.get(CSRF_HEADER))) {
			return applySecurityHeaders(
				errorResponse('forbidden', `missing ${CSRF_HEADER} header`),
				is_api
			);
		}
	}

	// 5. Identity and role. See `establishIdentity` and `roleDenial`.
	const identity = await establishIdentity(event, is_api, method);
	if (identity instanceof Response) {
		return applySecurityHeaders(identity, is_api);
	}
	const { session_id, set_cookies } = identity;
	const denied = roleDenial(event, is_api, method);
	if (denied !== undefined) {
		return applySecurityHeaders(withSetCookies(denied, set_cookies), is_api);
	}

	// 6. Rate limiting. Page routes are limited too: their load functions fan
	//    out to SQL, so an unauthenticated flood of page requests is as
	//    expensive as an API flood. Sessionless requests share one bucket
	//    keyed by client address so they cannot mint their way around it.
	//    Password attempts also draw on a small per-address bucket.
	const limiter = getRateLimiter();
	const kind = requiresCsrfHeader(method) ? 'mutation' : 'read';
	const limit_key = session_id === '' ? `addr:${clientAddress(event)}` : session_id;
	const credential_attempt = method === 'POST' && CREDENTIAL_PATHS.includes(event.url.pathname);
	if (
		!limiter.consume(limit_key, kind) ||
		(credential_attempt && !limiter.consume(`addr:${clientAddress(event)}`, 'credential'))
	) {
		return applySecurityHeaders(errorResponse('rate_limited', 'too many requests'), is_api);
	}

	// 7. Page shells carry the persisted theme preference; API responses are not
	//    HTML and must not pay for the lookup.
	if (is_api) {
		return applySecurityHeaders(withSetCookies(await resolve(event), set_cookies), is_api);
	}

	const theme = await themePreference();
	const response = await resolve(event, {
		transformPageChunk: ({ html }) => {
			return html.replace(THEME_PLACEHOLDER, theme);
		}
	});
	return applySecurityHeaders(withSetCookies(response, set_cookies), is_api);
};

export const handleError: HandleServerError = ({ status }) => {
	return { message: status === 404 ? 'not found' : 'internal error' };
};
