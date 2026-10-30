import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { setAuthServiceForTest } from '$lib/server/auth/service.js';
import {
	bootstrapAdmin,
	createTestAuth,
	TEST_AUTH_ORIGIN,
	TEST_PASSWORD,
	type TestAuth
} from '$lib/server/auth/test-helpers.js';
import { GET, POST } from './+server.js';

let t: TestAuth;
let admin_cookie: string;

/**
 * Call the route like SvelteKit would, after the hooks have passed it.
 * @param method HTTP method.
 * @param path Path below `/api/auth`.
 * @param body JSON body for POST.
 */
async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
	const url = new URL(`${TEST_AUTH_ORIGIN}/api/auth${path}`);
	const request = new Request(url, {
		method,
		headers: {
			host: url.host,
			origin: TEST_AUTH_ORIGIN,
			cookie: admin_cookie,
			'content-type': 'application/json'
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) })
	});
	const event = { request, url } as unknown as RequestEvent<{ all: string }, '/api/auth/[...all]'>;
	return method === 'GET' ? GET(event) : POST(event);
}

beforeEach(async () => {
	t = await createTestAuth();
	setAuthServiceForTest(t.service);
	admin_cookie = await bootstrapAdmin(t.service);
});

afterEach(() => {
	setAuthServiceForTest(undefined);
	t.cleanup();
});

describe('/api/auth allowlist', () => {
	it('serves the session endpoint the pages use', async () => {
		const response = await call('GET', '/get-session');
		expect(response.status).toBe(200);
		expect((await response.json()).user.email).toBe('admin@example.com');
	});

	it('hides the admin plugin and every other Better Auth endpoint', async () => {
		for (const [method, path] of [
			['POST', '/admin/create-user'],
			['POST', '/admin/set-role'],
			['POST', '/admin/impersonate-user'],
			['GET', '/admin/list-users'],
			['POST', '/update-user'],
			['POST', '/delete-user'],
			['POST', '/request-password-reset'],
			['GET', '/list-sessions'],
			['GET', '/ok']
		] as const) {
			const response = await call(method, path, method === 'POST' ? {} : undefined);
			expect(response.status, `${method} ${path}`).toBe(404);
		}
		expect(await t.service.store.countUsers()).toBe(1);
	});

	it('lets a signed-in account change its own password', async () => {
		const response = await call('POST', '/change-password', {
			currentPassword: TEST_PASSWORD,
			newPassword: 'another long passphrase',
			revokeOtherSessions: true
		});
		expect(response.status).toBe(200);
	});
});
