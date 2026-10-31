import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	AccountAdminError,
	createAccount,
	listAccounts,
	removeAccount,
	updateAccount,
	update_account_schema
} from './admin.js';
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
let admin_cookie: string;
let admin_headers: Headers;
let admin_id: string;

/** Account id for an email, read through the admin's own session. */
async function idOf(email: string): Promise<string> {
	const listed = await listAccounts(t.service, admin_headers);
	const user = listed.users.find((candidate) => candidate.email === email);
	if (user === undefined) {
		throw new Error(`no account ${email}`);
	}
	return user.id;
}

beforeEach(async () => {
	t = await createTestAuth();
	admin_cookie = await bootstrapAdmin(t.service);
	admin_headers = new Headers({ cookie: admin_cookie });
	admin_id = await idOf('admin@example.com');
});

afterEach(() => {
	t.cleanup();
});

describe('listAccounts', () => {
	it('lists accounts oldest first without hashes or sessions', async () => {
		await createMember(t.service, admin_cookie);
		const listed = await listAccounts(t.service, admin_headers);
		expect(listed.signup_open).toBe(false);
		expect(listed.users.map((user) => [user.email, user.role])).toEqual([
			['admin@example.com', 'admin'],
			['member@example.com', 'member']
		]);
		expect(JSON.stringify(listed.users)).not.toMatch(/scrypt|password|token/i);
	});

	it('refuses a member', async () => {
		const member_cookie = await createMember(t.service, admin_cookie);
		await expect(
			listAccounts(t.service, new Headers({ cookie: member_cookie }))
		).rejects.toMatchObject({ code: 'forbidden' });
	});
});

describe('createAccount', () => {
	it('creates a member who can sign in with the initial password', async () => {
		const user = await createAccount(t.service, admin_headers, {
			email: 'new@example.com',
			name: 'New',
			role: 'member',
			password: TEST_PASSWORD
		});
		expect(user.role).toBe('member');
		const response = await authPost(t.service, '/sign-in/email', {
			email: 'new@example.com',
			password: TEST_PASSWORD
		});
		expect(sessionCookieFrom(response)).toBeDefined();
	});

	it('refuses a short initial password with copy that survives the scrubber', async () => {
		const error = await createAccount(t.service, admin_headers, {
			email: 'new@example.com',
			name: 'New',
			role: 'member',
			password: 'short'
		}).catch((thrown: unknown) => thrown);
		expect(error).toBeInstanceOf(AccountAdminError);
		expect((error as AccountAdminError).message).toBe('Use 12 to 128 characters.');
	});

	it('refuses a duplicate email', async () => {
		await expect(
			createAccount(t.service, admin_headers, {
				email: 'admin@example.com',
				name: 'Again',
				role: 'admin',
				password: TEST_PASSWORD
			})
		).rejects.toMatchObject({ code: 'bad_request' });
	});
});

describe('keeping an admin', () => {
	it('refuses to demote or remove yourself', async () => {
		await expect(
			updateAccount(t.service, admin_headers, admin_id, admin_id, { role: 'member' })
		).rejects.toMatchObject({ code: 'forbidden' });
		await expect(removeAccount(t.service, admin_headers, admin_id, admin_id)).rejects.toMatchObject(
			{ code: 'forbidden' }
		);
		expect(await t.service.store.countAdmins()).toBe(1);
	});

	it('lets one admin demote another while an admin remains', async () => {
		await createAccount(t.service, admin_headers, {
			email: 'second@example.com',
			name: 'Second',
			role: 'admin',
			password: TEST_PASSWORD
		});
		expect(await t.service.store.countAdmins()).toBe(2);
		await updateAccount(t.service, admin_headers, admin_id, await idOf('second@example.com'), {
			role: 'member'
		});
		expect(await t.service.store.countAdmins()).toBe(1);
	});

	it('refuses to remove the only unbanned admin even for another admin', async () => {
		await createAccount(t.service, admin_headers, {
			email: 'second@example.com',
			name: 'Second',
			role: 'admin',
			password: TEST_PASSWORD
		});
		const second_id = await idOf('second@example.com');
		// A disabled admin does not count towards keeping one.
		await t.client.execute({
			sql: 'UPDATE auth_user SET banned = 1 WHERE id = ?',
			args: [admin_id]
		});
		await expect(
			removeAccount(t.service, admin_headers, admin_id, second_id)
		).rejects.toMatchObject({ code: 'forbidden', message: 'Beadsmith needs at least one admin.' });
	});

	it('promotes and demotes members', async () => {
		await createMember(t.service, admin_cookie);
		const member_id = await idOf('member@example.com');
		const promoted = await updateAccount(t.service, admin_headers, admin_id, member_id, {
			role: 'admin'
		});
		expect(promoted.role).toBe('admin');
		const demoted = await updateAccount(t.service, admin_headers, admin_id, member_id, {
			role: 'member'
		});
		expect(demoted.role).toBe('member');
	});
});

describe('password reset and removal', () => {
	it('sets a new password and signs the account out', async () => {
		const member_cookie = await createMember(t.service, admin_cookie);
		const member_id = await idOf('member@example.com');
		await updateAccount(t.service, admin_headers, admin_id, member_id, {
			password: 'a brand new passphrase'
		});
		expect(
			(await t.service.lookupSession(new Headers({ cookie: member_cookie }))).session
		).toBeNull();
		const old = await authPost(t.service, '/sign-in/email', {
			email: 'member@example.com',
			password: TEST_PASSWORD
		});
		expect(old.status).toBe(401);
		const fresh = await authPost(t.service, '/sign-in/email', {
			email: 'member@example.com',
			password: 'a brand new passphrase'
		});
		expect(fresh.status).toBe(200);
	});

	it('removes an account and its sessions', async () => {
		const member_cookie = await createMember(t.service, admin_cookie);
		await removeAccount(t.service, admin_headers, admin_id, await idOf('member@example.com'));
		expect(await t.service.store.countUsers()).toBe(1);
		expect(
			(await t.service.lookupSession(new Headers({ cookie: member_cookie }))).session
		).toBeNull();
	});

	it('404s an unknown account', async () => {
		await expect(
			removeAccount(t.service, admin_headers, admin_id, 'no-such-account')
		).rejects.toMatchObject({ code: 'not_found' });
	});
});

describe('update_account_schema', () => {
	it('needs a change and rejects extra keys', () => {
		expect(update_account_schema.safeParse({}).success).toBe(false);
		expect(update_account_schema.safeParse({ role: 'owner' }).success).toBe(false);
		expect(update_account_schema.safeParse({ role: 'member', email: 'x' }).success).toBe(false);
		expect(update_account_schema.safeParse({ role: 'admin' }).success).toBe(true);
	});
});
