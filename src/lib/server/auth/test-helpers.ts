/**
 * Test-only helpers: a real Better Auth service over a throwaway state
 * directory, and small HTTP helpers that talk to it like a browser would.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { initStateSchema } from '../state/db.js';
import { CSRF_HEADER, SESSION_COOKIE } from '../security.js';
import { SETUP_TOKEN_HEADER } from './bootstrap.js';
import { createAuthService, type AuthService } from './service.js';

export const TEST_AUTH_ORIGIN = 'http://localhost:4321';
export const TEST_AUTH_SECRET = 'test-secret-that-is-at-least-32-characters-long';
export const TEST_PASSWORD = 'correct horse battery';

export interface TestAuth {
	service: AuthService;
	client: Client;
	state_dir: string;
	cleanup(): void;
}

/** A fresh account service over a temporary `state.db`. */
export async function createTestAuth(): Promise<TestAuth> {
	const state_dir = mkdtempSync(join(tmpdir(), 'bdx-auth-'));
	const client = createClient({ url: `file:${join(state_dir, 'state.db')}` });
	await initStateSchema(client);
	const service = createAuthService({
		client,
		secret: TEST_AUTH_SECRET,
		state_dir,
		setup: undefined
	});
	return {
		service,
		client,
		state_dir,
		cleanup() {
			client.close();
			rmSync(state_dir, { recursive: true, force: true });
		}
	};
}

/**
 * POST JSON to a Better Auth endpoint the way the sign-in page does.
 * @param service Account service.
 * @param path Path below `/api/auth`.
 * @param body JSON body.
 * @param headers Extra headers (cookie, setup token).
 */
export async function authPost(
	service: AuthService,
	path: string,
	body: unknown,
	headers: Record<string, string> = {}
): Promise<Response> {
	return service.auth.handler(
		new Request(`${TEST_AUTH_ORIGIN}/api/auth${path}`, {
			method: 'POST',
			headers: {
				host: new URL(TEST_AUTH_ORIGIN).host,
				origin: TEST_AUTH_ORIGIN,
				'content-type': 'application/json',
				[CSRF_HEADER]: '1',
				...headers
			},
			body: JSON.stringify(body)
		})
	);
}

/**
 * The `name=value` pair of the session cookie a response set.
 * @param response Better Auth response.
 */
export function sessionCookieFrom(response: Response): string | undefined {
	for (const line of response.headers.getSetCookie()) {
		const pair = line.split(';')[0];
		if (pair.startsWith(`${SESSION_COOKIE}=`)) {
			return pair;
		}
	}
	return undefined;
}

/**
 * Create the first admin with the setup token and return its cookie.
 * @param service Account service.
 * @param email Admin email.
 */
export async function bootstrapAdmin(
	service: AuthService,
	email = 'admin@example.com'
): Promise<string> {
	await service.needsBootstrap();
	const token = service.setup.ensure();
	const response = await authPost(
		service,
		'/sign-up/email',
		{ name: 'Admin', email, password: TEST_PASSWORD },
		{ [SETUP_TOKEN_HEADER]: token }
	);
	const cookie = sessionCookieFrom(response);
	if (response.status !== 200 || cookie === undefined) {
		throw new Error(`bootstrap failed: ${response.status} ${await response.text()}`);
	}
	return cookie;
}

/**
 * Have an admin create a member, then sign the member in.
 * @param service Account service.
 * @param admin_cookie Admin session cookie pair.
 * @param email Member email.
 */
export async function createMember(
	service: AuthService,
	admin_cookie: string,
	email = 'member@example.com'
): Promise<string> {
	await service.auth.api.createUser({
		headers: new Headers({ cookie: admin_cookie }),
		body: { email, name: 'Member', password: TEST_PASSWORD, role: 'member' }
	});
	const response = await authPost(service, '/sign-in/email', { email, password: TEST_PASSWORD });
	const cookie = sessionCookieFrom(response);
	if (response.status !== 200 || cookie === undefined) {
		throw new Error(`member sign-in failed: ${response.status} ${await response.text()}`);
	}
	return cookie;
}
