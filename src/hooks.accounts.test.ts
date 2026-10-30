/**
 * `hooks.server.ts` with built-in accounts on (ADR-0011): a real Better Auth
 * service over a throwaway `state.db`, driven with the cookies a browser
 * would send. Covers signed-out, member, and admin paths, subrequests, the
 * service-token read path, and failing closed when accounts cannot open.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { handle } from './hooks.server.js';
import { CSRF_HEADER } from '$lib/server/security.js';
import { resetEnvCache } from '$lib/server/env.js';
import {
	resetCloudflareAccessVerifier,
	setCloudflareAccessVerifierForTest
} from '$lib/server/cloudflare-access.js';
import { setStateStore, type StateStore } from '$lib/server/state/db.js';
import { setAuthServiceForTest } from '$lib/server/auth/service.js';
import {
	bootstrapAdmin,
	createMember,
	createTestAuth,
	type TestAuth
} from '$lib/server/auth/test-helpers.js';

const ENV_KEYS = [
	'BEADS_DOLT_SERVER_HOST',
	'BETTER_AUTH_SECRET_FILE',
	'BDX_STATE_DIR',
	'BDX_ALLOWED_HOSTS',
	'BDX_CF_ACCESS_ISSUER',
	'BDX_CF_ACCESS_AUDIENCE',
	'BDX_CF_ACCESS_ALLOWED_SERVICE_TOKEN_IDS'
] as const;
const saved_env = new Map<string, string | undefined>();

interface EventOptions {
	path?: string;
	method?: string;
	host?: string;
	cookie?: string;
	csrf?: boolean;
	sub_request?: boolean;
	cloudflare_assertion?: string;
	client_address?: string;
}

let address_counter = 0;

/**
 * Minimal RequestEvent. Each event gets its own client address unless one
 * is given, so the shared per-address rate limiter never bleeds across tests.
 * @param options Request shape.
 */
function makeEvent(options: EventOptions = {}): RequestEvent {
	const host = options.host ?? 'localhost:4321';
	const path = options.path ?? '/api/status';
	const method = options.method ?? 'GET';
	const headers = new Headers();
	if (!options.sub_request) {
		headers.set('host', host);
	}
	if (options.cookie !== undefined) {
		headers.set('cookie', options.cookie);
	}
	if (options.csrf ?? method !== 'GET') {
		headers.set(CSRF_HEADER, '1');
	}
	if (options.cloudflare_assertion !== undefined) {
		headers.set('cf-access-jwt-assertion', options.cloudflare_assertion);
	}
	const url = new URL(`http://${host}${path}`);
	address_counter += 1;
	const address = options.client_address ?? `10.0.0.${address_counter % 250}`;
	return {
		url,
		locals: {} as App.Locals,
		isSubRequest: options.sub_request === true,
		request: new Request(url, { method, headers }),
		cookies: {
			get: () => undefined,
			set: () => {}
		},
		getClientAddress: () => address
	} as unknown as RequestEvent;
}

async function resolveOk(): Promise<Response> {
	return new Response('ok', { status: 200 });
}

async function run(options: EventOptions): Promise<{ response: Response; event: RequestEvent }> {
	const event = makeEvent(options);
	const response = await handle({ event, resolve: resolveOk });
	return { response, event };
}

let t: TestAuth;
let admin_cookie: string;
let member_cookie: string;

beforeEach(async () => {
	for (const key of ENV_KEYS) {
		saved_env.set(key, process.env[key]);
		delete process.env[key];
	}
	process.env.BEADS_DOLT_SERVER_HOST = 'dolt.test';
	resetEnvCache();
	resetCloudflareAccessVerifier();
	setStateStore({
		getSetting: async () => undefined,
		setSetting: async () => {}
	} as unknown as StateStore);

	t = await createTestAuth();
	setAuthServiceForTest(t.service);
	admin_cookie = await bootstrapAdmin(t.service);
	member_cookie = await createMember(t.service, admin_cookie);
});

afterEach(() => {
	setAuthServiceForTest(undefined);
	setStateStore(undefined);
	t.cleanup();
	for (const key of ENV_KEYS) {
		const value = saved_env.get(key);
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	resetEnvCache();
	resetCloudflareAccessVerifier();
});

describe('signed out', () => {
	it('gets 401 from the API', async () => {
		const { response } = await run({ path: '/api/projects' });
		expect(response.status).toBe(401);
	});

	it('is sent to sign-in from a page, with a same-origin return path', async () => {
		const { response } = await run({ path: '/p/abc?view=board' });
		expect(response.status).toBe(303);
		expect(response.headers.get('location')).toBe('/auth?redirect=%2Fp%2Fabc%3Fview%3Dboard');
	});

	it('is sent to plain /auth from the home page', async () => {
		const { response } = await run({ path: '/' });
		expect(response.headers.get('location')).toBe('/auth');
	});

	it('may load the sign-in page and call the Better Auth endpoints', async () => {
		expect((await run({ path: '/auth' })).response.status).toBe(200);
		expect((await run({ path: '/api/auth/get-session' })).response.status).toBe(200);
		expect((await run({ path: '/api/auth/sign-in/email', method: 'POST' })).response.status).toBe(
			200
		);
	});

	it('still needs the CSRF header to call Better Auth', async () => {
		const { response } = await run({
			path: '/api/auth/sign-in/email',
			method: 'POST',
			csrf: false
		});
		expect(response.status).toBe(403);
	});

	it('cannot reach any console route, backups included', async () => {
		for (const [method, path] of [
			['GET', '/api/console'],
			['GET', '/api/console/backups'],
			['PUT', '/api/console/backups'],
			['POST', '/api/console/backups/run'],
			['POST', '/api/console/backups/test'],
			['GET', '/api/console/accounts']
		]) {
			const { response } = await run({ path, method });
			expect(response.status, `${method} ${path}`).toBe(401);
		}
	});

	it('is not taken for the old in-memory session cookie', async () => {
		const { response } = await run({ path: '/api/projects', cookie: '__Host-bdx_session=abc123' });
		expect(response.status).toBe(401);
	});
});

describe('member', () => {
	it('reads the API and sees its role on locals', async () => {
		const { response, event } = await run({ path: '/api/projects', cookie: member_cookie });
		expect(response.status).toBe(200);
		expect(event.locals.role).toBe('member');
		expect(event.locals.user?.email).toBe('member@example.com');
		expect(event.locals.session_id).not.toBe('');
	});

	it('is refused every console route, backups included', async () => {
		for (const [method, path] of [
			['GET', '/api/console'],
			['GET', '/api/console/backups'],
			['PUT', '/api/console/backups'],
			['POST', '/api/console/backups/run'],
			['POST', '/api/console/backups/test'],
			['PUT', '/api/console/dispatch'],
			['PUT', '/api/console/projects/p1/allow'],
			['GET', '/api/console/accounts'],
			['GET', '/api/todos'],
			['POST', '/api/todos'],
			['PATCH', '/api/todos/td_1'],
			['DELETE', '/api/todos/td_1'],
			['POST', '/api/todos/td_1/comments'],
			['POST', '/api/console/accounts/users'],
			['DELETE', '/api/console/accounts/users/abc']
		]) {
			const { response } = await run({ path, method, cookie: member_cookie });
			expect(response.status, `${method} ${path}`).toBe(403);
		}
	});

	it('may not launch, cancel, or steer agents', async () => {
		for (const path of [
			'/api/projects/p1/dispatch',
			'/api/projects/p1/dispatch/r1/cancel',
			'/api/projects/p1/dispatch/r1/follow-up'
		]) {
			const { response } = await run({ path, method: 'POST', cookie: member_cookie });
			expect(response.status, path).toBe(403);
		}
	});

	it('may still read agent progress, set the theme, and refresh projects', async () => {
		expect(
			(await run({ path: '/api/projects/p1/dispatch/r1/stream', cookie: member_cookie })).response
				.status
		).toBe(200);
		expect(
			(await run({ path: '/api/settings/theme', method: 'PUT', cookie: member_cookie })).response
				.status
		).toBe(200);
		expect(
			(await run({ path: '/api/projects/refresh', method: 'POST', cookie: member_cookie })).response
				.status
		).toBe(200);
	});

	it('is refused an unknown write route by default', async () => {
		const { response } = await run({
			path: '/api/something/new',
			method: 'POST',
			cookie: member_cookie
		});
		expect(response.status).toBe(403);
	});

	it('cannot read admin data through an SSR subrequest', async () => {
		const { response } = await run({
			path: '/api/console/backups',
			cookie: member_cookie,
			sub_request: true
		});
		expect(response.status).toBe(403);
	});
});

describe('admin', () => {
	it('reaches every console route, backups included', async () => {
		for (const [method, path] of [
			['GET', '/api/console'],
			['GET', '/api/console/backups'],
			['PUT', '/api/console/backups'],
			['POST', '/api/console/backups/run'],
			['POST', '/api/console/backups/test'],
			['GET', '/api/console/accounts']
		]) {
			const { response, event } = await run({ path, method, cookie: admin_cookie });
			expect(response.status, `${method} ${path}`).toBe(200);
			expect(event.locals.role).toBe('admin');
		}
	});

	it('may launch agents', async () => {
		const { response } = await run({
			path: '/api/projects/p1/dispatch',
			method: 'POST',
			cookie: admin_cookie
		});
		expect(response.status).toBe(200);
	});

	it('loses access once removed', async () => {
		const users = await t.service.auth.api.listUsers({
			headers: new Headers({ cookie: admin_cookie }),
			query: {}
		});
		const member = users.users.find((user) => user.email === 'member@example.com');
		await t.service.auth.api.removeUser({
			headers: new Headers({ cookie: admin_cookie }),
			body: { userId: member?.id ?? '' }
		});
		const { response } = await run({ path: '/api/projects', cookie: member_cookie });
		expect(response.status).toBe(401);
	});
});

describe('signed-out subrequest', () => {
	it('gets 401 rather than skipping the gate', async () => {
		const { response } = await run({ path: '/api/projects', sub_request: true });
		expect(response.status).toBe(401);
	});
});

describe('password attempts', () => {
	it('are limited to ten a minute per client address', async () => {
		const statuses: number[] = [];
		for (let attempt = 0; attempt < 11; attempt += 1) {
			const { response } = await run({
				path: '/api/auth/sign-in/email',
				method: 'POST',
				client_address: '192.0.2.77'
			});
			statuses.push(response.status);
		}
		expect(statuses.slice(0, 10).every((status) => status === 200)).toBe(true);
		expect(statuses[10]).toBe(429);
	});
});

describe('Cloudflare Access as an outer layer', () => {
	const TOKEN_ID = '0123456789abcdef0123456789abcdef';

	beforeEach(() => {
		process.env.BDX_CF_ACCESS_ISSUER = 'https://beads.cloudflareaccess.com';
		process.env.BDX_CF_ACCESS_AUDIENCE = 'beads-web-audience';
		process.env.BDX_CF_ACCESS_ALLOWED_SERVICE_TOKEN_IDS = TOKEN_ID;
		process.env.BDX_ALLOWED_HOSTS = 'beads.example.com';
		resetEnvCache();
	});

	it('still demands the Access assertion before sign-in', async () => {
		const { response } = await run({ host: 'beads.example.com', path: '/auth' });
		expect(response.status).toBe(403);
	});

	it('still demands an account after Access lets a human through', async () => {
		setCloudflareAccessVerifierForTest({
			verify: async () => ({ kind: 'human', subject: 'sub', email: 'admin@example.com' })
		});
		const { response } = await run({
			host: 'beads.example.com',
			path: '/api/projects',
			cloudflare_assertion: 'verified-by-test'
		});
		expect(response.status).toBe(401);
	});

	it('keeps the service-token read path as a read-only member', async () => {
		setCloudflareAccessVerifierForTest({
			verify: async () => ({ kind: 'service_token', subject: TOKEN_ID })
		});
		const read = await run({
			host: 'beads.example.com',
			path: '/api/projects',
			cloudflare_assertion: 'verified-by-test'
		});
		expect(read.response.status).toBe(200);
		expect(read.event.locals.role).toBe('member');

		const console_read = await run({
			host: 'beads.example.com',
			path: '/api/console/backups',
			cloudflare_assertion: 'verified-by-test'
		});
		expect(console_read.response.status).toBe(403);
	});
});

describe('failure', () => {
	it('fails every request closed when the accounts secret is unusable', async () => {
		const state_dir = mkdtempSync(join(tmpdir(), 'bdx-hooks-'));
		try {
			writeFileSync(join(state_dir, 'auth-secret'), 'too-short\n');
			process.env.BDX_STATE_DIR = state_dir;
			resetEnvCache();
			setAuthServiceForTest(undefined);
			for (const path of ['/api/projects', '/auth', '/']) {
				const { response } = await run({ path, cookie: admin_cookie });
				expect(response.status, path).toBe(503);
			}
		} finally {
			rmSync(state_dir, { recursive: true, force: true });
		}
	});
});
