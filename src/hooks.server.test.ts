import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent, ResolveOptions } from '@sveltejs/kit';
import { handle } from './hooks.server.js';
import { randomBytes } from 'node:crypto';
import { CSRF_HEADER, getRateLimiter, SESSION_COOKIE } from '$lib/server/security.js';
import { setAuthServiceForTest, type AuthService } from '$lib/server/auth/service.js';
import { resetEnvCache } from '$lib/server/env.js';
import {
	CloudflareAccessVerificationError,
	resetCloudflareAccessVerifier,
	setCloudflareAccessVerifierForTest
} from '$lib/server/cloudflare-access.js';
import { setDispatchPolicyStore, setStateStore, type StateStore } from '$lib/server/state/db.js';

interface EventOptions {
	path?: string;
	method?: string;
	host?: string;
	origin?: string;
	csrf?: string;
	session?: string;
	cloudflare_assertion?: string;
	client_address?: string;
	/** Additional raw headers, e.g. spoofed `X-Forwarded-*` values under test. */
	extra_headers?: Record<string, string>;
}

interface FakeEvent {
	event: RequestEvent;
	cookies_set: { name: string; value: string }[];
}

/**
 * Build a minimal RequestEvent for the hook under test.
 * @param options Request shape.
 */
function makeEvent(options: EventOptions = {}): FakeEvent {
	const host = options.host ?? 'localhost:5173';
	const path = options.path ?? '/api/status';
	const headers = new Headers();
	headers.set('host', host);
	if (options.origin !== undefined) {
		headers.set('origin', options.origin);
	}
	if (options.csrf !== undefined) {
		headers.set(CSRF_HEADER, options.csrf);
	}
	if (options.cloudflare_assertion !== undefined) {
		headers.set('cf-access-jwt-assertion', options.cloudflare_assertion);
	}
	if (options.session !== undefined) {
		headers.set('cookie', `${SESSION_COOKIE}=${options.session}`);
	}
	for (const [name, value] of Object.entries(options.extra_headers ?? {})) {
		headers.set(name, value);
	}
	const url = new URL(`http://${host}${path}`);
	const cookies_set: { name: string; value: string }[] = [];
	const jar = new Map<string, string>();
	if (options.session !== undefined) {
		jar.set(SESSION_COOKIE, options.session);
	}

	const event = {
		url,
		locals: {} as App.Locals,
		request: new Request(url, { method: options.method ?? 'GET', headers }),
		cookies: {
			get(name: string): string | undefined {
				return jar.get(name);
			},
			set(name: string, value: string): void {
				jar.set(name, value);
				cookies_set.push({ name, value });
			}
		},
		getClientAddress(): string {
			return options.client_address ?? '127.0.0.1';
		}
	} as unknown as RequestEvent;

	return { event, cookies_set };
}

/** Terminal handler used by the hook under test. */
async function resolveOk(): Promise<Response> {
	return new Response('ok', { status: 200 });
}

/** Page shell carrying the placeholder the hook substitutes. */
const SHELL = '<html lang="en" data-theme="%bdui.theme%"></html>';

/**
 * Terminal handler that renders the shell through `transformPageChunk`.
 * @param event Request event.
 * @param options Resolve options supplied by the hook.
 */
async function resolveShell(_event: RequestEvent, options?: ResolveOptions): Promise<Response> {
	const html = await options?.transformPageChunk?.({ html: SHELL, done: true });
	return new Response(html ?? SHELL, {
		status: 200,
		headers: { 'content-type': 'text/html' }
	});
}

let stored_theme: string | undefined;

/** Dummy Dolt host so the config check does not 403 every request under test. */
const TEST_DOLT_HOST = 'dolt.test';
const ORIGINAL_DOLT_HOST = process.env.BEADS_DOLT_SERVER_HOST;

/**
 * Restore or delete a process env var.
 * @param name Variable name.
 * @param value Original value, or undefined to delete.
 */
function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
	} else {
		process.env[name] = value;
	}
}

/**
 * Install a state store stub so no test ever opens the on-disk state DB.
 * @param theme Value returned for `ui.theme`.
 */
function stubStateStore(theme: string | undefined): void {
	stored_theme = theme;
	setStateStore({
		getSetting: async (key: string) => (key === 'ui.theme' ? stored_theme : undefined),
		setSetting: async () => {}
	} as unknown as StateStore);
	setDispatchPolicyStore({
		async getArmed() {
			return true;
		},
		async setArmed() {
			return;
		},
		async getAllow() {
			return { file: true, tackle: true };
		},
		async listAllows() {
			return {};
		},
		async putAllow() {
			return;
		}
	});
}

/** Session ids the fake account service treats as a signed-in admin. */
const live_sessions = new Set<string>();

/**
 * Accounts stand-in: these tests cover the transport gates, so a session is
 * just an id in `live_sessions`. `hooks.accounts.test.ts` drives the real
 * Better Auth service.
 */
const fake_auth = {
	async lookupSession(headers: Headers) {
		const match = (headers.get('cookie') ?? '').match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
		const id = match?.[1];
		if (id === undefined || !live_sessions.has(id)) {
			return { session: null, set_cookies: [] };
		}
		return {
			session: {
				session_id: id,
				user: { id: 'admin-id', email: 'admin@example.com', name: 'Admin', role: 'admin' as const }
			},
			set_cookies: []
		};
	},
	async needsBootstrap() {
		return false;
	}
} as unknown as AuthService;

beforeEach(() => {
	stubStateStore(undefined);
	setAuthServiceForTest(fake_auth);
	delete process.env.BDX_CF_ACCESS_ISSUER;
	delete process.env.BDX_CF_ACCESS_AUDIENCE;
	delete process.env.BDX_CF_ACCESS_ALLOWED_SERVICE_TOKEN_IDS;
	delete process.env.BDX_ALLOWED_HOSTS;
	delete process.env.BDX_PUBLIC_ORIGIN;
	process.env.BEADS_DOLT_SERVER_HOST = TEST_DOLT_HOST;
	resetEnvCache();
	resetCloudflareAccessVerifier();
});

afterEach(() => {
	setAuthServiceForTest(undefined);
	restoreEnv('BEADS_DOLT_SERVER_HOST', ORIGINAL_DOLT_HOST);
	resetEnvCache();
});

/**
 * Sign in a fake admin so requests can pass the session gate.
 * @returns A fresh session id.
 */
function mintSession(): string {
	const id = randomBytes(16).toString('hex');
	live_sessions.add(id);
	return id;
}

/** Charge a fresh key so per-session rate limits do not bleed between tests. */
function freshSession(): string {
	const id = mintSession();
	getRateLimiter().consume(id, 'read');
	return id;
}

describe('config check', () => {
	it('refuses every request when the Dolt host is not configured', async () => {
		delete process.env.BEADS_DOLT_SERVER_HOST;
		resetEnvCache();
		const { event } = makeEvent({ session: freshSession() });

		const response = await handle({ event, resolve: resolveOk });

		expect(response.status).toBe(403);
		await expect(response.json()).resolves.toEqual({
			error: {
				code: 'forbidden',
				message: 'server configuration rejected; see the server log'
			}
		});
	});
});

describe('host allowlist', () => {
	it('allows a loopback host', async () => {
		const { event } = makeEvent({
			host: '127.0.0.1:5173',
			session: freshSession()
		});

		const response = await handle({ event, resolve: resolveOk });

		expect(response.status).toBe(200);
	});

	it('rejects a rebinding host with 403', async () => {
		const { event } = makeEvent({
			host: 'evil.example.com',
			session: mintSession()
		});

		const response = await handle({ event, resolve: resolveOk });

		expect(response.status).toBe(403);
	});

	it('rejects a host that merely looks like loopback', async () => {
		const { event } = makeEvent({ host: 'localhost.evil.example.com' });

		const response = await handle({ event, resolve: resolveOk });

		expect(response.status).toBe(403);
	});
});

describe('origin check', () => {
	it('allows a same-origin request', async () => {
		const { event } = makeEvent({
			origin: 'http://localhost:5173',
			session: freshSession()
		});

		const response = await handle({ event, resolve: resolveOk });

		expect(response.status).toBe(200);
	});

	it('rejects a cross-origin GET', async () => {
		const { event } = makeEvent({
			origin: 'http://evil.example.com',
			session: mintSession()
		});

		const response = await handle({ event, resolve: resolveOk });

		expect(response.status).toBe(403);
	});
});

describe('CSRF header gate', () => {
	it('rejects an API mutation without the custom header', async () => {
		const { event } = makeEvent({
			method: 'POST',
			path: '/api/projects/refresh',
			session: mintSession()
		});

		const response = await handle({ event, resolve: resolveOk });

		expect(response.status).toBe(403);
	});

	it('accepts an API mutation carrying the custom header', async () => {
		const { event } = makeEvent({
			method: 'POST',
			path: '/api/projects/refresh',
			csrf: '1',
			session: freshSession()
		});

		const response = await handle({ event, resolve: resolveOk });

		expect(response.status).toBe(200);
	});

	it('does not require the header for API reads', async () => {
		const { event } = makeEvent({ session: freshSession() });

		const response = await handle({ event, resolve: resolveOk });

		expect(response.status).toBe(200);
	});
});

describe('session gate', () => {
	it('rejects an API read without a session', async () => {
		const { event } = makeEvent({ path: '/api/projects' });

		const response = await handle({ event, resolve: resolveOk });

		expect(response.status).toBe(401);
	});

	it('rejects a console API read without a session', async () => {
		const { event } = makeEvent({ path: '/api/console' });

		const response = await handle({ event, resolve: resolveOk });

		expect(response.status).toBe(401);
	});

	it('rejects a console map write without a session', async () => {
		const { event } = makeEvent({
			path: '/api/console/projects/d_beads_web/tackle-map',
			method: 'PUT',
			csrf: '1'
		});

		const response = await handle({ event, resolve: resolveOk });

		expect(response.status).toBe(401);
	});

	it('rejects a console File checkout write without a session', async () => {
		const { event } = makeEvent({
			path: '/api/console/projects/d_beads_web/file-map',
			method: 'PUT',
			csrf: '1'
		});

		const response = await handle({ event, resolve: resolveOk });

		expect(response.status).toBe(401);
	});

	it('rejects a console arm write without a session', async () => {
		const { event } = makeEvent({
			path: '/api/console/dispatch',
			method: 'PUT',
			csrf: '1'
		});

		const response = await handle({ event, resolve: resolveOk });

		expect(response.status).toBe(401);
	});

	it('rejects a Ready API read without a session', async () => {
		const { event } = makeEvent({ path: '/api/ready' });

		const response = await handle({ event, resolve: resolveOk });

		expect(response.status).toBe(401);
	});

	it('rejects an API read with an unknown session cookie', async () => {
		const { event } = makeEvent({
			path: '/api/projects',
			session: 'forged-session-id'
		});

		const response = await handle({ event, resolve: resolveOk });

		expect(response.status).toBe(401);
	});

	it('sends a signed-out page load to sign-in without minting a session', async () => {
		const { event, cookies_set } = makeEvent({ path: '/issues?x=1' });

		const response = await handle({ event, resolve: resolveOk });

		expect(response.status).toBe(303);
		expect(response.headers.get('location')).toBe('/auth?redirect=%2Fissues%3Fx%3D1');
		expect(cookies_set).toEqual([]);
	});

	it('serves the sign-in page signed out', async () => {
		const { event } = makeEvent({ path: '/auth' });

		const response = await handle({ event, resolve: resolveOk });

		expect(response.status).toBe(200);
	});

	it('exposes the session id on locals', async () => {
		const session = freshSession();
		const { event } = makeEvent({ session });

		await handle({ event, resolve: resolveOk });

		expect(event.locals.session_id).toBe(session);
	});
});

describe('Cloudflare Access gate', () => {
	function configureAccess(): void {
		process.env.BDX_CF_ACCESS_ISSUER = 'https://beads.cloudflareaccess.com';
		process.env.BDX_CF_ACCESS_AUDIENCE = 'beads-web-audience';
		process.env.BDX_ALLOWED_HOSTS = 'beads.example.com';
		resetEnvCache();
	}

	function acceptPrincipal(email: string | undefined = 'admin@example.com'): void {
		setCloudflareAccessVerifierForTest({
			verify: async () => ({
				kind: 'human',
				subject: 'cloudflare-subject',
				...(email === undefined ? {} : { email })
			})
		});
	}

	let error_spy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		error_spy = vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		error_spy.mockRestore();
	});

	/** The single log line the hook is expected to have written, as plain text. */
	function loggedLine(): string {
		expect(error_spy).toHaveBeenCalledTimes(1);
		return String(error_spy.mock.calls[0][0]);
	}

	it('requires an assertion for the configured public hostname before session minting', async () => {
		configureAccess();
		const { event, cookies_set } = makeEvent({
			host: 'beads.example.com',
			path: '/'
		});

		const response = await handle({ event, resolve: resolveOk });

		expect(response.status).toBe(403);
		expect(cookies_set).toEqual([]);
	});

	it('requires Access on an application route even for a direct loopback request', async () => {
		configureAccess();
		const { event, cookies_set } = makeEvent({
			host: '127.0.0.1:4321',
			path: '/'
		});

		const response = await handle({ event, resolve: resolveOk });

		expect(response.status).toBe(403);
		expect(cookies_set).toEqual([]);
	});

	it('passes a verified human assertion on to the account gate', async () => {
		configureAccess();
		acceptPrincipal('Someone@Example.com');
		const { event } = makeEvent({
			host: 'beads.example.com',
			path: '/',
			cloudflare_assertion: 'verified-by-test',
			session: freshSession()
		});

		const response = await handle({ event, resolve: resolveOk });

		expect(response.status).toBe(200);
		expect(event.locals.cloudflare_access).toEqual({
			kind: 'human',
			subject: 'cloudflare-subject',
			email: 'Someone@Example.com'
		});
	});

	it('still sends a verified human without an account session to sign-in', async () => {
		configureAccess();
		acceptPrincipal();
		const { event } = makeEvent({
			host: 'beads.example.com',
			path: '/',
			cloudflare_assertion: 'verified-by-test'
		});

		const response = await handle({ event, resolve: resolveOk });

		expect(response.status).toBe(303);
		expect(response.headers.get('location')).toBe('/auth');
	});

	describe('denial logging', () => {
		/** Client-visible body is identical across every Access denial path. */
		async function expectUnchangedDenial(response: Response): Promise<void> {
			expect(response.status).toBe(403);
			await expect(response.json()).resolves.toEqual({
				error: { code: 'forbidden', message: 'access authentication required' }
			});
		}

		it('logs assertion_missing and returns the unchanged denial when the header is absent', async () => {
			configureAccess();
			const { event } = makeEvent({ host: 'beads.example.com', path: '/api/projects' });

			await expectUnchangedDenial(await handle({ event, resolve: resolveOk }));

			const line = loggedLine();
			expect(line).toContain('beads-web cloudflare-access-denied');
			expect(line).toContain('reason=assertion_missing');
			expect(line).toContain('path=/api/projects');
		});

		it('logs issuer_config_invalid for a misconfigured issuer', async () => {
			process.env.BDX_CF_ACCESS_ISSUER = 'https://not-cloudflareaccess.example.com';
			process.env.BDX_CF_ACCESS_AUDIENCE = 'beads-web-audience';
			process.env.BDX_ALLOWED_HOSTS = 'beads.example.com';
			resetEnvCache();
			const { event } = makeEvent({ host: 'beads.example.com', path: '/api/projects' });

			await expectUnchangedDenial(await handle({ event, resolve: resolveOk }));

			expect(loggedLine()).toContain('reason=issuer_config_invalid');
		});

		it.each(['audience_mismatch', 'signature_invalid', 'token_expired'] as const)(
			'logs the verifier reason %s without printing the token',
			async (reason) => {
				configureAccess();
				setCloudflareAccessVerifierForTest({
					verify: async () => {
						throw new CloudflareAccessVerificationError(reason);
					}
				});
				const { event } = makeEvent({
					host: 'beads.example.com',
					path: '/api/projects',
					cloudflare_assertion: 'verified-by-test'
				});

				await expectUnchangedDenial(await handle({ event, resolve: resolveOk }));

				const line = loggedLine();
				expect(line).toContain(`reason=${reason}`);
				expect(line).not.toContain('verified-by-test');
			}
		);

		it('logs verification_unexpected_error when verify() throws something other than the opaque error', async () => {
			configureAccess();
			setCloudflareAccessVerifierForTest({
				verify: async () => {
					throw new Error('boom');
				}
			});
			const { event } = makeEvent({
				host: 'beads.example.com',
				path: '/api/projects',
				cloudflare_assertion: 'verified-by-test'
			});

			await expectUnchangedDenial(await handle({ event, resolve: resolveOk }));

			const line = loggedLine();
			expect(line).toContain('reason=verification_unexpected_error');
			expect(line).not.toContain('verified-by-test');
		});
	});

	it('serves the isolated health probe only to a direct loopback peer without session or resolve', async () => {
		configureAccess();
		let resolved = false;
		const { event, cookies_set } = makeEvent({
			host: '127.0.0.1:4321',
			path: '/healthz'
		});

		const response = await handle({
			event,
			resolve: async () => {
				resolved = true;
				return resolveOk();
			}
		});

		expect(response.status).toBe(204);
		expect(await response.text()).toBe('');
		expect(cookies_set).toEqual([]);
		expect(event.locals).toEqual({});
		expect(resolved).toBe(false);
	});

	it('rejects the health probe from a non-loopback peer', async () => {
		configureAccess();
		const { event } = makeEvent({
			host: '127.0.0.1:4321',
			path: '/healthz',
			client_address: '198.51.100.8'
		});

		const response = await handle({ event, resolve: resolveOk });

		expect(response.status).toBe(403);
	});

	describe('service-token principal', () => {
		const TOKEN_ID = '0123456789abcdef0123456789abcdef';
		const OTHER_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

		function configureAccessWithToken(): void {
			configureAccess();
			process.env.BDX_CF_ACCESS_ALLOWED_SERVICE_TOKEN_IDS = TOKEN_ID;
			resetEnvCache();
		}

		function acceptServiceToken(client_id: string = TOKEN_ID): void {
			setCloudflareAccessVerifierForTest({
				verify: async () => ({
					kind: 'service_token',
					subject: client_id
				})
			});
		}

		it('lets an allowlisted service token GET /api/projects without a session cookie', async () => {
			configureAccessWithToken();
			acceptServiceToken();
			const { event, cookies_set } = makeEvent({
				host: 'beads.example.com',
				path: '/api/projects',
				cloudflare_assertion: 'verified-by-test'
			});

			const response = await handle({ event, resolve: resolveOk });

			expect(response.status).toBe(200);
			expect(cookies_set).toEqual([]);
			expect(event.locals.session_id).toBe('');
			expect(event.locals.cloudflare_access).toEqual({
				kind: 'service_token',
				subject: TOKEN_ID
			});
		});

		it('lets an allowlisted service token GET an issue list without a session cookie', async () => {
			configureAccessWithToken();
			acceptServiceToken();
			const { event, cookies_set } = makeEvent({
				host: 'beads.example.com',
				path: '/api/projects/d_beads_web/issues',
				cloudflare_assertion: 'verified-by-test'
			});

			const response = await handle({ event, resolve: resolveOk });

			expect(response.status).toBe(200);
			expect(cookies_set).toEqual([]);
		});

		it('lets an allowlisted service token HEAD /api/projects without a session cookie', async () => {
			configureAccessWithToken();
			acceptServiceToken();
			const { event } = makeEvent({
				host: 'beads.example.com',
				path: '/api/projects',
				method: 'HEAD',
				cloudflare_assertion: 'verified-by-test'
			});

			const response = await handle({ event, resolve: resolveOk });

			expect(response.status).toBe(200);
		});

		it('still requires a session for a human Access JWT on /api without a cookie', async () => {
			configureAccessWithToken();
			acceptPrincipal();
			const { event, cookies_set } = makeEvent({
				host: 'beads.example.com',
				path: '/api/projects',
				cloudflare_assertion: 'verified-by-test'
			});

			const response = await handle({ event, resolve: resolveOk });

			expect(response.status).toBe(401);
			expect(cookies_set).toEqual([]);
			await expect(response.json()).resolves.toEqual({
				error: { code: 'unauthorized', message: 'session required' }
			});
		});

		it('rejects a non-allowlisted service token with a generic 403', async () => {
			configureAccessWithToken();
			acceptServiceToken(OTHER_ID);
			const { event } = makeEvent({
				host: 'beads.example.com',
				path: '/api/projects',
				cloudflare_assertion: 'verified-by-test'
			});

			const response = await handle({ event, resolve: resolveOk });

			expect(response.status).toBe(403);
			await expect(response.json()).resolves.toEqual({
				error: { code: 'forbidden', message: 'access authentication required' }
			});
			const line = loggedLine();
			expect(line).toContain('reason=service_token_not_allowlisted');
			expect(line).not.toContain(OTHER_ID);
			expect(line).not.toContain(TOKEN_ID);
			expect(line).not.toContain('verified-by-test');
		});

		it('rejects a service token when no Client ID allowlist is configured', async () => {
			configureAccess();
			acceptServiceToken();
			const { event } = makeEvent({
				host: 'beads.example.com',
				path: '/api/projects',
				cloudflare_assertion: 'verified-by-test'
			});

			const response = await handle({ event, resolve: resolveOk });

			expect(response.status).toBe(403);
			expect(loggedLine()).toContain('reason=service_token_not_allowlisted');
		});

		it('does not make HTML routes sessionless for a service token and does not mint a cookie', async () => {
			configureAccessWithToken();
			acceptServiceToken();
			const { event, cookies_set } = makeEvent({
				host: 'beads.example.com',
				path: '/',
				cloudflare_assertion: 'verified-by-test'
			});

			const response = await handle({ event, resolve: resolveOk });

			expect(response.status).toBe(403);
			expect(cookies_set).toEqual([]);
			expect(event.locals.session_id).toBe('');
		});

		it('keeps mutating /api closed without a session, including theme and dispatch', async () => {
			configureAccessWithToken();
			acceptServiceToken();
			for (const path of ['/api/settings/theme', '/api/projects/d_beads_web/dispatch']) {
				const { event, cookies_set } = makeEvent({
					host: 'beads.example.com',
					path,
					method: 'POST',
					csrf: '1',
					cloudflare_assertion: 'verified-by-test'
				});

				const response = await handle({ event, resolve: resolveOk });

				expect(response.status, path).toBe(401);
				expect(cookies_set, path).toEqual([]);
				await expect(response.json()).resolves.toEqual({
					error: { code: 'unauthorized', message: 'session required' }
				});
			}
		});

		it('does not take identity from CF-Access-Client-Id; only the verified JWT counts', async () => {
			configureAccessWithToken();
			acceptPrincipal();
			const { event } = makeEvent({
				host: 'beads.example.com',
				path: '/',
				cloudflare_assertion: 'verified-by-test',
				session: freshSession(),
				extra_headers: { 'cf-access-client-id': OTHER_ID }
			});

			const response = await handle({ event, resolve: resolveOk });

			expect(response.status).toBe(200);
			expect(event.locals.cloudflare_access).toEqual({
				kind: 'human',
				subject: 'cloudflare-subject',
				email: 'admin@example.com'
			});
		});
	});
});

describe('trusted public origin (BDX_PUBLIC_ORIGIN)', () => {
	const PUBLIC_HOST = 'beads.example.com';
	const PUBLIC_HTTPS_ORIGIN = 'https://beads.example.com';

	function configureAccessAndPublicOrigin(): void {
		process.env.BDX_CF_ACCESS_ISSUER = 'https://beads.cloudflareaccess.com';
		process.env.BDX_CF_ACCESS_AUDIENCE = 'beads-web-audience';
		process.env.BDX_ALLOWED_HOSTS = PUBLIC_HOST;
		process.env.BDX_PUBLIC_ORIGIN = PUBLIC_HTTPS_ORIGIN;
		resetEnvCache();
	}

	function acceptPrincipal(): void {
		setCloudflareAccessVerifierForTest({
			verify: async () => ({
				kind: 'human',
				subject: 'cloudflare-subject',
				email: 'admin@example.com'
			})
		});
	}

	it('accepts a legitimate Cloudflare-shaped mutation: https Origin over the plain-HTTP loopback hop', async () => {
		configureAccessAndPublicOrigin();
		acceptPrincipal();
		// makeEvent builds event.url as http://<host>..., mirroring the adapter
		// computing the origin from the plain-HTTP loopback hop behind the tunnel.
		const { event } = makeEvent({
			method: 'POST',
			path: '/api/projects/refresh',
			host: PUBLIC_HOST,
			origin: PUBLIC_HTTPS_ORIGIN,
			csrf: '1',
			cloudflare_assertion: 'verified-by-test',
			session: freshSession()
		});

		const response = await handle({ event, resolve: resolveOk });

		expect(response.status).toBe(200);
	});

	it('allows the cross-site top-level navigation returning from Cloudflare Access login', async () => {
		configureAccessAndPublicOrigin();
		acceptPrincipal();
		// The browser arrives back from example.cloudflareaccess.com, a
		// different site, so Chrome sends Sec-Fetch-Site: cross-site on the
		// document navigation. Rejecting it made login unreachable.
		const { event } = makeEvent({
			method: 'GET',
			path: '/',
			host: PUBLIC_HOST,
			cloudflare_assertion: 'verified-by-test',
			session: freshSession(),
			extra_headers: {
				'sec-fetch-site': 'cross-site',
				'sec-fetch-mode': 'navigate',
				'sec-fetch-dest': 'document'
			}
		});

		const response = await handle({ event, resolve: resolveOk });

		expect(response.status).toBe(200);
	});

	it('still rejects a cross-site POST navigation (form-submission CSRF)', async () => {
		configureAccessAndPublicOrigin();
		acceptPrincipal();
		const { event } = makeEvent({
			method: 'POST',
			path: '/api/projects/refresh',
			host: PUBLIC_HOST,
			csrf: '1',
			cloudflare_assertion: 'verified-by-test',
			session: mintSession(),
			extra_headers: {
				'sec-fetch-site': 'cross-site',
				'sec-fetch-mode': 'navigate',
				'sec-fetch-dest': 'document'
			}
		});

		const response = await handle({ event, resolve: resolveOk });

		expect(response.status).toBe(403);
	});

	it('still rejects a cross-site subresource load', async () => {
		configureAccessAndPublicOrigin();
		acceptPrincipal();
		const { event } = makeEvent({
			method: 'GET',
			path: '/api/projects',
			host: PUBLIC_HOST,
			cloudflare_assertion: 'verified-by-test',
			session: mintSession(),
			extra_headers: {
				'sec-fetch-site': 'cross-site',
				'sec-fetch-mode': 'no-cors',
				'sec-fetch-dest': 'image'
			}
		});

		const response = await handle({ event, resolve: resolveOk });

		expect(response.status).toBe(403);
	});

	it('rejects the same request when Origin belongs to an attacker', async () => {
		configureAccessAndPublicOrigin();
		acceptPrincipal();
		const { event } = makeEvent({
			method: 'POST',
			path: '/api/projects/refresh',
			host: PUBLIC_HOST,
			origin: 'https://evil.example.com',
			csrf: '1',
			cloudflare_assertion: 'verified-by-test',
			session: mintSession()
		});

		const response = await handle({ event, resolve: resolveOk });

		expect(response.status).toBe(403);
	});

	it('rejects the plain-HTTP origin once the public-origin override is configured for that host', async () => {
		configureAccessAndPublicOrigin();
		acceptPrincipal();
		const { event } = makeEvent({
			method: 'POST',
			path: '/api/projects/refresh',
			host: PUBLIC_HOST,
			origin: 'http://beads.example.com',
			csrf: '1',
			cloudflare_assertion: 'verified-by-test',
			session: mintSession()
		});

		const response = await handle({ event, resolve: resolveOk });

		expect(response.status).toBe(403);
	});

	it('leaves an unconfigured host on strict same-origin comparison', async () => {
		configureAccessAndPublicOrigin();
		process.env.BDX_ALLOWED_HOSTS = `${PUBLIC_HOST},localhost:5173`;
		resetEnvCache();
		acceptPrincipal();
		// localhost never matches the configured public origin's hostname, so
		// the override must not apply: only an exact scheme match is accepted.
		const { event } = makeEvent({
			method: 'POST',
			path: '/api/projects/refresh',
			host: 'localhost:5173',
			origin: PUBLIC_HTTPS_ORIGIN,
			csrf: '1',
			cloudflare_assertion: 'verified-by-test',
			session: mintSession()
		});

		const response = await handle({ event, resolve: resolveOk });

		expect(response.status).toBe(403);
	});

	it('cannot be bypassed by a direct caller spoofing X-Forwarded-Proto/X-Forwarded-Host without a valid Access assertion', async () => {
		configureAccessAndPublicOrigin();
		const { event } = makeEvent({
			method: 'POST',
			path: '/api/projects/refresh',
			host: PUBLIC_HOST,
			origin: PUBLIC_HTTPS_ORIGIN,
			csrf: '1',
			session: mintSession(),
			extra_headers: {
				'x-forwarded-proto': 'https',
				'x-forwarded-host': PUBLIC_HOST
			}
		});

		const response = await handle({ event, resolve: resolveOk });

		// No Cf-Access-Jwt-Assertion header: the forwarded headers cannot forge
		// Cloudflare's cryptographically verified assertion.
		expect(response.status).toBe(403);
	});

	it('cannot spoof the allowed Host via X-Forwarded-Host', async () => {
		configureAccessAndPublicOrigin();
		acceptPrincipal();
		const { event } = makeEvent({
			method: 'POST',
			path: '/api/projects/refresh',
			host: 'evil.example.com',
			origin: PUBLIC_HTTPS_ORIGIN,
			csrf: '1',
			cloudflare_assertion: 'verified-by-test',
			session: mintSession(),
			extra_headers: { 'x-forwarded-host': PUBLIC_HOST, 'x-forwarded-proto': 'https' }
		});

		const response = await handle({ event, resolve: resolveOk });

		// The raw Host header (not any forwarded header) drives the allow-list
		// check, so a mismatched literal Host is still rejected.
		expect(response.status).toBe(403);
	});

	it('produces an identical outcome with or without spoofed forwarded headers on an otherwise-legitimate request', async () => {
		configureAccessAndPublicOrigin();
		acceptPrincipal();
		const base = {
			method: 'POST',
			path: '/api/projects/refresh',
			host: PUBLIC_HOST,
			origin: PUBLIC_HTTPS_ORIGIN,
			csrf: '1',
			cloudflare_assertion: 'verified-by-test'
		} as const;

		const { event: without_headers } = makeEvent({ ...base, session: freshSession() });
		const { event: with_headers } = makeEvent({
			...base,
			session: freshSession(),
			extra_headers: {
				'x-forwarded-proto': 'http',
				'x-forwarded-host': 'evil.example.com',
				forwarded: 'proto=http;host=evil.example.com'
			}
		});

		const status_without = (await handle({ event: without_headers, resolve: resolveOk })).status;
		const status_with = (await handle({ event: with_headers, resolve: resolveOk })).status;

		expect(status_with).toBe(status_without);
		expect(status_with).toBe(200);
	});
});

describe('rate limiting', () => {
	it('returns 429 once the mutation budget is exhausted', async () => {
		const session = mintSession();

		let status = 200;
		for (let attempt = 0; attempt < 25; attempt += 1) {
			const { event } = makeEvent({
				method: 'POST',
				path: '/api/projects/refresh',
				csrf: '1',
				session
			});
			status = (await handle({ event, resolve: resolveOk })).status;
		}

		expect(status).toBe(429);
	});
});

describe('theme preference injection', () => {
	it('substitutes the stored preference into the page shell', async () => {
		stubStateStore('light');
		const { event } = makeEvent({ path: '/', session: freshSession() });

		const response = await handle({ event, resolve: resolveShell });

		expect(await response.text()).toBe('<html lang="en" data-theme="light"></html>');
	});

	it('falls back to system when unset or unrecognised', async () => {
		const { event: unset } = makeEvent({ path: '/', session: freshSession() });
		expect(await (await handle({ event: unset, resolve: resolveShell })).text()).toContain(
			'data-theme="system"'
		);

		stubStateStore('neon');
		const { event: bogus } = makeEvent({ path: '/', session: freshSession() });
		expect(await (await handle({ event: bogus, resolve: resolveShell })).text()).toContain(
			'data-theme="system"'
		);
	});

	it('falls back to system when the state DB throws', async () => {
		setStateStore({
			getSetting: async () => {
				throw new Error('state db unavailable');
			},
			setSetting: async () => {}
		} as unknown as StateStore);
		const { event } = makeEvent({ path: '/', session: freshSession() });

		const response = await handle({ event, resolve: resolveShell });

		expect(await response.text()).toContain('data-theme="system"');
	});

	it('does not transform API responses', async () => {
		stubStateStore('dark');
		const { event } = makeEvent({ session: freshSession() });

		const response = await handle({ event, resolve: resolveShell });

		expect(await response.text()).toContain('%bdui.theme%');
	});
});

describe('security headers', () => {
	it('sets the documented headers on API responses', async () => {
		const { event } = makeEvent({ session: freshSession() });

		const response = await handle({ event, resolve: resolveOk });

		expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
		expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
		expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
		expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
		expect(response.headers.get('Cache-Control')).toBe('no-store');
	});

	it('does not force no-store on page responses', async () => {
		const { event } = makeEvent({ path: '/' });

		const response = await handle({ event, resolve: resolveOk });

		expect(response.headers.get('Cache-Control')).toBeNull();
		expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
	});

	it('sets the headers on rejected requests too', async () => {
		const { event } = makeEvent({ host: 'evil.example.com' });

		const response = await handle({ event, resolve: resolveOk });

		expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
	});
});
