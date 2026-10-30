import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { verifyPassword } from 'better-auth/crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	assertAccountExists,
	describeOutcome,
	listAccounts,
	openAccounts,
	parseRecoveryArgs,
	passwordFromInput,
	promoteAccount,
	RecoveryError,
	setAccountPassword
} from './recovery.js';
import {
	authPost,
	bootstrapAdmin,
	createMember,
	createTestAuth,
	sessionCookieFrom,
	TEST_PASSWORD,
	type TestAuth
} from './test-helpers.js';

const repoRoot = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));

let t: TestAuth;
let admin_cookie: string;
/** A password made for this run; never a real one. */
let new_password: string;

beforeEach(async () => {
	t = await createTestAuth();
	admin_cookie = await bootstrapAdmin(t.service);
	new_password = `new-${randomUUID()}`;
});

afterEach(() => {
	t.cleanup();
});

/** Sign in through the real service, returning the response. */
function signIn(email: string, password: string): Promise<Response> {
	return authPost(t.service, '/sign-in/email', { email, password });
}

/** The credential hash Better Auth would check at sign-in. */
async function storedHash(email: string): Promise<string> {
	const result = await t.client.execute({
		sql: `SELECT a.password AS hash FROM auth_account a
		      JOIN auth_user u ON u.id = a.user_id
		      WHERE u.email = ? AND a.provider_id = 'credential'`,
		args: [email]
	});
	return String((result.rows[0] as Record<string, unknown>).hash);
}

async function sessionCount(): Promise<number> {
	const result = await t.client.execute('SELECT COUNT(*) AS n FROM auth_session');
	return Number((result.rows[0] as Record<string, unknown>).n);
}

describe('setAccountPassword', () => {
	it('lets the account sign in with the new password and not the old one', async () => {
		const outcome = await setAccountPassword(t.client, 'admin@example.com', new_password);
		expect(outcome).toMatchObject({
			email: 'admin@example.com',
			role: 'admin',
			password_changed: true,
			promoted: false
		});

		const fresh = await signIn('admin@example.com', new_password);
		expect(fresh.status).toBe(200);
		expect(sessionCookieFrom(fresh)).toBeDefined();
		expect((await signIn('admin@example.com', TEST_PASSWORD)).status).toBe(401);
	});

	it("stores a hash that Better Auth's verifyPassword accepts", async () => {
		await setAccountPassword(t.client, 'admin@example.com', new_password);
		const hash = await storedHash('admin@example.com');
		expect(await verifyPassword({ hash, password: new_password })).toBe(true);
		expect(await verifyPassword({ hash, password: TEST_PASSWORD })).toBe(false);
		expect(hash).not.toContain(new_password);
	});

	it("revokes the account's sessions and nobody else's", async () => {
		const member_cookie = await createMember(t.service, admin_cookie);
		await signIn('admin@example.com', TEST_PASSWORD);
		expect(await sessionCount()).toBe(3);

		const outcome = await setAccountPassword(t.client, 'admin@example.com', new_password);
		expect(outcome.sessions_revoked).toBe(2);
		expect(
			(await t.service.lookupSession(new Headers({ cookie: admin_cookie }))).session
		).toBeNull();
		const member = await t.service.lookupSession(new Headers({ cookie: member_cookie }));
		expect(member.session?.user.email).toBe('member@example.com');
	});

	it('finds the account whatever the case of the email', async () => {
		await setAccountPassword(t.client, '  Admin@Example.COM ', new_password);
		expect((await signIn('admin@example.com', new_password)).status).toBe(200);
	});

	it('gives an account with no sign-in method one', async () => {
		await t.client.execute('DELETE FROM auth_account');
		expect((await signIn('admin@example.com', TEST_PASSWORD)).status).not.toBe(200);

		await setAccountPassword(t.client, 'admin@example.com', new_password);
		expect((await signIn('admin@example.com', new_password)).status).toBe(200);
		const rows = await t.client.execute(
			"SELECT id FROM auth_account WHERE provider_id = 'credential'"
		);
		expect(rows.rows).toHaveLength(1);
	});

	it('refuses an unknown email and changes nothing', async () => {
		const before = await storedHash('admin@example.com');
		await expect(setAccountPassword(t.client, 'nobody@example.com', new_password)).rejects.toThrow(
			RecoveryError
		);
		await expect(setAccountPassword(t.client, 'nobody@example.com', new_password)).rejects.toThrow(
			/No account has the email nobody@example.com/
		);
		expect(await storedHash('admin@example.com')).toBe(before);
		expect(await sessionCount()).toBe(1);
	});

	it('refuses an empty email', async () => {
		await expect(setAccountPassword(t.client, '  ', new_password)).rejects.toThrow(
			/email address is required/
		);
	});

	it.each([
		['empty', ''],
		['too short', 'x'.repeat(11)],
		['too long', 'x'.repeat(129)]
	])('refuses a password that is %s and changes nothing', async (_name, password) => {
		const before = await storedHash('admin@example.com');
		await expect(setAccountPassword(t.client, 'admin@example.com', password)).rejects.toThrow(
			/Use 12 to 128 characters/
		);
		expect(await storedHash('admin@example.com')).toBe(before);
		expect((await signIn('admin@example.com', TEST_PASSWORD)).status).toBe(200);
		expect(
			(await t.service.lookupSession(new Headers({ cookie: admin_cookie }))).session
		).not.toBeNull();
	});
});

describe('promoteAccount', () => {
	it('makes a member an admin and signs them out', async () => {
		const member_cookie = await createMember(t.service, admin_cookie);
		expect(await t.service.store.countAdmins()).toBe(1);

		const outcome = await promoteAccount(t.client, 'member@example.com');
		expect(outcome).toMatchObject({
			email: 'member@example.com',
			role: 'admin',
			promoted: true,
			password_changed: false,
			sessions_revoked: 1
		});
		expect(await t.service.store.countAdmins()).toBe(2);
		expect(
			(await t.service.lookupSession(new Headers({ cookie: member_cookie }))).session
		).toBeNull();

		// The password is untouched, and the next sign-in carries the new role.
		const fresh = await signIn('member@example.com', TEST_PASSWORD);
		const cookie = sessionCookieFrom(fresh) as string;
		const lookup = await t.service.lookupSession(new Headers({ cookie }));
		expect(lookup.session?.user.role).toBe('admin');
	});

	it('keeps an existing admin an admin and still signs them out', async () => {
		const outcome = await promoteAccount(t.client, 'admin@example.com');
		expect(outcome).toMatchObject({ role: 'admin', promoted: false, sessions_revoked: 1 });
		expect(describeOutcome(outcome)).toEqual([
			'admin@example.com is already an admin.',
			'Revoked 1 session.'
		]);
		expect(
			(await t.service.lookupSession(new Headers({ cookie: admin_cookie }))).session
		).toBeNull();
	});

	it('refuses an unknown email and changes nothing', async () => {
		await expect(promoteAccount(t.client, 'nobody@example.com')).rejects.toThrow(
			/No account has the email nobody@example.com/
		);
		expect(await sessionCount()).toBe(1);
		await expect(promoteAccount(t.client, '')).rejects.toThrow(/email address is required/);
	});
});

describe('openAccounts', () => {
	it('opens the state database a server wrote', async () => {
		await createMember(t.service, admin_cookie);
		const client = await openAccounts(t.state_dir);
		try {
			expect(await listAccounts(client)).toEqual([
				{ email: 'admin@example.com', name: 'Admin', role: 'admin' },
				{ email: 'member@example.com', name: 'Member', role: 'member' }
			]);
			await expect(assertAccountExists(client, 'MEMBER@example.com')).resolves.toBeUndefined();
			await expect(assertAccountExists(client, 'nobody@example.com')).rejects.toThrow(
				RecoveryError
			);
		} finally {
			client.close();
		}
	});

	it('refuses a directory with no state.db, and does not create one', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'bdx-recovery-'));
		try {
			await expect(openAccounts(dir)).rejects.toThrow(/No state\.db in/);
			expect(existsSync(join(dir, 'state.db'))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('refuses a state.db that never had accounts', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'bdx-recovery-'));
		try {
			const bare = createClient({ url: `file:${join(dir, 'state.db')}` });
			await bare.execute('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
			bare.close();
			await expect(openAccounts(dir)).rejects.toThrow(/no accounts table/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('parseRecoveryArgs', () => {
	it('reads each command', () => {
		expect(parseRecoveryArgs(['list'])).toEqual({ action: 'list' });
		expect(parseRecoveryArgs(['set-password', 'a@example.com'])).toEqual({
			action: 'set-password',
			email: 'a@example.com'
		});
		expect(parseRecoveryArgs(['promote', 'a@example.com'])).toEqual({
			action: 'promote',
			email: 'a@example.com'
		});
	});

	it('refuses a password on the command line', () => {
		expect(() => parseRecoveryArgs(['set-password', 'a@example.com', new_password])).toThrow(
			/never an argument/
		);
	});

	it('prints usage for anything else', () => {
		for (const args of [[], ['set-password'], ['promote'], ['list', 'x'], ['delete', 'a@b.c']]) {
			expect(() => parseRecoveryArgs(args)).toThrow(/usage:/);
		}
	});
});

describe('passwordFromInput', () => {
	it('takes the first line without its ending', () => {
		expect(passwordFromInput('one two three\n')).toBe('one two three');
		expect(passwordFromInput('one two three\r\nignored\n')).toBe('one two three');
		expect(passwordFromInput('no newline')).toBe('no newline');
		expect(passwordFromInput(' spaces kept ')).toBe(' spaces kept ');
	});

	it('refuses empty input', () => {
		for (const text of ['', '\n', '\r\n', '\nsecond line']) {
			expect(() => passwordFromInput(text)).toThrow(/password is empty/);
		}
	});
});

describe('describeOutcome', () => {
	it('names what changed', () => {
		expect(
			describeOutcome({
				email: 'a@example.com',
				role: 'member',
				promoted: false,
				password_changed: true,
				sessions_revoked: 0
			})
		).toEqual(['Set a new password for a@example.com (member).', 'Revoked 0 sessions.']);
	});
});

/** Run `node scripts/accounts.ts` against the test state directory. */
function accountsTask(args: string[], stdin: string) {
	const run = spawnSync('node', ['scripts/accounts.ts', ...args], {
		cwd: repoRoot,
		input: stdin,
		encoding: 'utf8',
		env: { ...process.env, BDX_STATE_DIR: t.state_dir }
	});
	return { code: run.status, out: run.stdout, err: run.stderr };
}

describe('node scripts/accounts.ts', () => {
	it('sets a password read from stdin, then signs in with it', async () => {
		const run = accountsTask(['set-password', 'admin@example.com'], `${new_password}\n`);
		expect(run.err).not.toContain('accounts:');
		expect(run.code).toBe(0);
		expect(run.out.split('\n')).toEqual([
			'Set a new password for admin@example.com (admin).',
			'Revoked 1 session.',
			''
		]);
		expect(run.out).not.toContain(new_password);
		expect((await signIn('admin@example.com', new_password)).status).toBe(200);
		expect((await signIn('admin@example.com', TEST_PASSWORD)).status).toBe(401);
	});

	it('promotes a member', async () => {
		await createMember(t.service, admin_cookie);
		const run = accountsTask(['promote', 'member@example.com'], '');
		expect(run.code).toBe(0);
		expect(run.out).toContain('Promoted member@example.com to admin.');
		expect(await t.service.store.countAdmins()).toBe(2);
	});

	it('lists accounts', () => {
		const run = accountsTask(['list'], '');
		expect(run.code).toBe(0);
		expect(run.out).toBe('admin@example.com\tadmin\tAdmin\n');
	});

	it('refuses an unknown email, empty input, and a password argument', async () => {
		const unknown = accountsTask(['set-password', 'nobody@example.com'], `${new_password}\n`);
		expect(unknown.code).toBe(1);
		expect(unknown.err).toContain('No account has the email nobody@example.com');

		const empty = accountsTask(['set-password', 'admin@example.com'], '');
		expect(empty.code).toBe(1);
		expect(empty.err).toContain('The password is empty');

		const argument = accountsTask(['set-password', 'admin@example.com', new_password], '');
		expect(argument.code).toBe(1);
		expect(argument.err).toContain('never an argument');

		expect((await signIn('admin@example.com', TEST_PASSWORD)).status).toBe(200);
	});
});
