import { existsSync, statSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../security.js';
import { SETUP_TOKEN_HEADER } from './bootstrap.js';
import {
	authPost,
	bootstrapAdmin,
	createMember,
	createTestAuth,
	sessionCookieFrom,
	TEST_PASSWORD,
	type TestAuth
} from './test-helpers.js';

let t: TestAuth;

beforeEach(async () => {
	t = await createTestAuth();
});

afterEach(() => {
	t.cleanup();
});

describe('account schema', () => {
	it('matches what Better Auth and the admin plugin write', async () => {
		const context = await t.service.auth.$context;
		await expect(context.checkSchema?.() ?? Promise.resolve()).resolves.not.toThrow();
	});
});

describe('first-run bootstrap', () => {
	it('writes a 0600 setup token file while no account exists', async () => {
		expect(await t.service.needsBootstrap()).toBe(true);
		expect(existsSync(t.service.setup.path)).toBe(true);
		expect(statSync(t.service.setup.path).mode & 0o777).toBe(0o600);
	});

	it('refuses the first account without the setup token', async () => {
		await t.service.needsBootstrap();
		const response = await authPost(t.service, '/sign-up/email', {
			name: 'Mallory',
			email: 'mallory@example.com',
			password: TEST_PASSWORD
		});
		expect(response.status).toBe(403);
		expect((await response.json()).code).toBe('SETUP_TOKEN_INVALID');
		expect(await t.service.store.countUsers()).toBe(0);
	});

	it('refuses the first account with a wrong setup token', async () => {
		await t.service.needsBootstrap();
		const response = await authPost(
			t.service,
			'/sign-up/email',
			{ name: 'Mallory', email: 'mallory@example.com', password: TEST_PASSWORD },
			{ [SETUP_TOKEN_HEADER]: 'not-the-token' }
		);
		expect(response.status).toBe(403);
		expect(await t.service.store.countUsers()).toBe(0);
	});

	it('makes the first account an admin, signs it in, and deletes the token', async () => {
		const cookie = await bootstrapAdmin(t.service);
		expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
		expect(existsSync(t.service.setup.path)).toBe(false);
		expect(await t.service.needsBootstrap()).toBe(false);

		const lookup = await t.service.lookupSession(new Headers({ cookie }));
		expect(lookup.session?.user).toMatchObject({ email: 'admin@example.com', role: 'admin' });
	});

	it('sets the session cookie as __Host-, Secure, HttpOnly, SameSite=Strict, Path=/', async () => {
		await t.service.needsBootstrap();
		const response = await authPost(
			t.service,
			'/sign-up/email',
			{ name: 'Admin', email: 'admin@example.com', password: TEST_PASSWORD },
			{ [SETUP_TOKEN_HEADER]: t.service.setup.ensure() }
		);
		const line = response.headers
			.getSetCookie()
			.find((value) => value.startsWith(`${SESSION_COOKIE}=`));
		expect(line).toBeDefined();
		expect(line).toMatch(/; Secure/i);
		expect(line).toMatch(/; HttpOnly/i);
		expect(line).toMatch(/; SameSite=Strict/i);
		expect(line).toMatch(/; Path=\//i);
		expect(line).not.toMatch(/; Domain=/i);
	});
});

describe('sign-up after bootstrap', () => {
	it('is closed by default', async () => {
		await bootstrapAdmin(t.service);
		const response = await authPost(t.service, '/sign-up/email', {
			name: 'Eve',
			email: 'eve@example.com',
			password: TEST_PASSWORD
		});
		expect(response.status).toBe(403);
		expect((await response.json()).code).toBe('SIGNUP_CLOSED');
		expect(await t.service.store.countUsers()).toBe(1);
	});

	it('creates members only, once an admin opens it', async () => {
		await bootstrapAdmin(t.service);
		await t.service.store.setSignupOpen(true);
		const response = await authPost(t.service, '/sign-up/email', {
			name: 'Eve',
			email: 'eve@example.com',
			password: TEST_PASSWORD,
			role: 'admin'
		});
		// `role` is not an input field: asking for it is a 400, not an admin.
		expect(response.status).toBe(400);
		expect(sessionCookieFrom(response)).toBeUndefined();
		const plain = await authPost(t.service, '/sign-up/email', {
			name: 'Eve2',
			email: 'eve2@example.com',
			password: TEST_PASSWORD
		});
		expect(plain.status).toBe(200);
		const lookup = await t.service.lookupSession(
			new Headers({ cookie: sessionCookieFrom(plain) ?? '' })
		);
		expect(lookup.session?.user.role).toBe('member');
	});

	it('rejects passwords shorter than 12 characters', async () => {
		await bootstrapAdmin(t.service);
		await t.service.store.setSignupOpen(true);
		const response = await authPost(t.service, '/sign-up/email', {
			name: 'Eve',
			email: 'eve@example.com',
			password: 'short'
		});
		expect(response.status).toBe(400);
	});
});

describe('admin-created accounts', () => {
	it('lets an admin create a member who can sign in', async () => {
		const admin_cookie = await bootstrapAdmin(t.service);
		const member_cookie = await createMember(t.service, admin_cookie);
		const lookup = await t.service.lookupSession(new Headers({ cookie: member_cookie }));
		expect(lookup.session?.user).toMatchObject({ email: 'member@example.com', role: 'member' });
	});

	it('does not let a member create accounts', async () => {
		const admin_cookie = await bootstrapAdmin(t.service);
		const member_cookie = await createMember(t.service, admin_cookie);
		await expect(
			t.service.auth.api.createUser({
				headers: new Headers({ cookie: member_cookie }),
				body: { email: 'x@example.com', name: 'X', password: TEST_PASSWORD, role: 'admin' }
			})
		).rejects.toThrow();
		expect(await t.service.store.countUsers()).toBe(2);
	});
});

describe('sessions', () => {
	it('returns no session without the cookie or with a forged one', async () => {
		await bootstrapAdmin(t.service);
		expect((await t.service.lookupSession(new Headers())).session).toBeNull();
		const forged = await t.service.lookupSession(
			new Headers({ cookie: `${SESSION_COOKIE}=forged.value` })
		);
		expect(forged.session).toBeNull();
	});

	it('ends the session on sign-out', async () => {
		const cookie = await bootstrapAdmin(t.service);
		const response = await authPost(t.service, '/sign-out', {}, { cookie });
		expect(response.status).toBe(200);
		expect((await t.service.lookupSession(new Headers({ cookie }))).session).toBeNull();
	});

	it('rejects wrong passwords', async () => {
		await bootstrapAdmin(t.service);
		const response = await authPost(t.service, '/sign-in/email', {
			email: 'admin@example.com',
			password: 'wrong password here'
		});
		expect(response.status).toBe(401);
		expect(sessionCookieFrom(response)).toBeUndefined();
	});

	it('counts admins for the last-admin guard', async () => {
		const admin_cookie = await bootstrapAdmin(t.service);
		await createMember(t.service, admin_cookie);
		expect(await t.service.store.countAdmins()).toBe(1);
		expect(await t.service.store.countUsers()).toBe(2);
	});
});
