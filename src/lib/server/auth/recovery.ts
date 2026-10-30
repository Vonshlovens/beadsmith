/**
 * Host-side account recovery behind `node scripts/accounts.ts` (ADR-0011): set an
 * account's password or promote it to admin, directly in `state.db`, and
 * revoke its sessions. It is the way back in when the last admin's password
 * is lost, since the console cannot reset or demote the last admin.
 *
 * Node runs this without SvelteKit or a bundler (type stripping), so it
 * imports no `$lib` alias and not `service.ts`, and it names its relative
 * imports `.ts`. The Dockerfile copies this file and what it imports, one by
 * one. Passwords are hashed by
 * Better Auth's own `hashPassword`, so the sign-in page accepts them. The
 * server need not be stopped: each change is one short write transaction that
 * waits for the server's own writes.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createClient, type Client, type Transaction } from '@libsql/client';
import { generateRandomString, hashPassword } from 'better-auth/crypto';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './password-policy.ts';
import { accountRole, type AccountRole } from './roles.ts';

/** SQLite's default is to fail at once when the running server holds the write lock. */
const BUSY_TIMEOUT_MS = 5000;

/** Raised for a refused change; `message` is safe to print. */
export class RecoveryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RecoveryError';
	}
}

export const RECOVERY_USAGE = `usage:
  node scripts/accounts.ts list
  node scripts/accounts.ts set-password <email>   (new password at a prompt, or on stdin)
  node scripts/accounts.ts promote <email>        (make the account an admin)`;

export type RecoveryCommand =
	| { action: 'list' }
	| { action: 'set-password'; email: string }
	| { action: 'promote'; email: string };

export interface AccountSummary {
	email: string;
	name: string;
	role: AccountRole;
}

export interface RecoveryOutcome {
	email: string;
	/** The account's role once the change is made. */
	role: AccountRole;
	promoted: boolean;
	password_changed: boolean;
	sessions_revoked: number;
}

/**
 * Read the command line. The password is never an argument: arguments end up
 * in shell history and process listings.
 * @param args Arguments after the script name.
 */
export function parseRecoveryArgs(args: string[]): RecoveryCommand {
	const [action, ...rest] = args;
	if (action === 'list' && rest.length === 0) {
		return { action };
	}
	if (action === 'set-password' && rest.length > 1) {
		throw new RecoveryError(
			'set-password takes only an email. The new password comes from a prompt or stdin, never an argument.'
		);
	}
	if ((action === 'set-password' || action === 'promote') && rest.length === 1) {
		return { action, email: rest[0] };
	}
	throw new RecoveryError(RECOVERY_USAGE);
}

/**
 * The password from piped input: its first line, without the line ending.
 * @param text Everything read from stdin.
 */
export function passwordFromInput(text: string): string {
	const line = text.split('\n', 1)[0].replace(/\r$/, '');
	if (line === '') {
		throw new RecoveryError(
			'The password is empty. Pipe it in on one line, or run in a terminal to be prompted.'
		);
	}
	return line;
}

/**
 * Refuse a password outside the sign-in rules, as the console does.
 * @param password Proposed password.
 */
export function checkPassword(password: string): void {
	if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
		throw new RecoveryError(`Use ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters.`);
	}
}

/**
 * Open `state.db` for recovery. Unlike the server it never creates the file
 * or the tables: a missing one means the wrong directory, or accounts never
 * started.
 * @param state_dir Directory holding `state.db` (`resolveStateDir`).
 */
export async function openAccounts(state_dir: string): Promise<Client> {
	const path = join(state_dir, 'state.db');
	if (!existsSync(path)) {
		throw new RecoveryError(
			`No state.db in ${state_dir}. Set BDX_STATE_DIR to the directory Beadsmith uses (/state in the container).`
		);
	}
	const client = createClient({ url: `file:${path}` });
	await client.execute(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
	const tables = await client.execute(
		"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auth_user'"
	);
	if (tables.rows.length === 0) {
		client.close();
		throw new RecoveryError(
			`${path} has no accounts table. Start Beadsmith once with BETTER_AUTH_SECRET_FILE set.`
		);
	}
	return client;
}

/** Better Auth stores emails lower-case. */
function normalizeEmail(email: string): string {
	const address = email.trim().toLowerCase();
	if (address === '') {
		throw new RecoveryError('An email address is required.');
	}
	return address;
}

function unknownEmail(address: string): RecoveryError {
	return new RecoveryError(
		`No account has the email ${address}. Run "node scripts/accounts.ts list" to see them.`
	);
}

/**
 * Every account, oldest first.
 * @param client Open `state.db`.
 */
export async function listAccounts(client: Client): Promise<AccountSummary[]> {
	const result = await client.execute(
		'SELECT email, name, role FROM auth_user ORDER BY created_at, email'
	);
	return result.rows.map((row) => {
		const user = row as Record<string, unknown>;
		return {
			email: String(user.email),
			name: String(user.name),
			role: accountRole(user.role as string | null)
		};
	});
}

/**
 * Fail early on an unknown email, before anyone types a password.
 * @param client Open `state.db`.
 * @param email Account email.
 */
export async function assertAccountExists(client: Client, email: string): Promise<void> {
	const address = normalizeEmail(email);
	const result = await client.execute({
		sql: 'SELECT 1 FROM auth_user WHERE email = ?',
		args: [address]
	});
	if (result.rows.length === 0) {
		throw unknownEmail(address);
	}
}

/**
 * Run `change` on one account and revoke all of its sessions, in a single
 * write transaction: either both happen or neither does.
 * @param client Open `state.db`.
 * @param email Account email.
 * @param change Edits the account's rows; reports what it changed.
 */
async function changeAccount(
	client: Client,
	email: string,
	change: (
		tx: Transaction,
		user: { id: string; role: AccountRole }
	) => Promise<Partial<Pick<RecoveryOutcome, 'promoted' | 'password_changed'>>>
): Promise<RecoveryOutcome> {
	const address = normalizeEmail(email);
	const tx = await client.transaction('write');
	try {
		const found = await tx.execute({
			sql: 'SELECT id, email, role FROM auth_user WHERE email = ?',
			args: [address]
		});
		const row = found.rows[0] as Record<string, unknown> | undefined;
		if (row === undefined) {
			throw unknownEmail(address);
		}
		const user = { id: String(row.id), role: accountRole(row.role as string | null) };
		const changed = await change(tx, user);
		const revoked = await tx.execute({
			sql: 'DELETE FROM auth_session WHERE user_id = ?',
			args: [user.id]
		});
		await tx.commit();
		return {
			email: String(row.email),
			role: changed.promoted === true ? 'admin' : user.role,
			promoted: changed.promoted === true,
			password_changed: changed.password_changed === true,
			sessions_revoked: revoked.rowsAffected
		};
	} finally {
		// Rolls back whatever was not committed.
		tx.close();
	}
}

/**
 * Set an account's password and sign it out everywhere. Creates the sign-in
 * method if the account has none, as the admin plugin's own set-password does.
 * @param client Open `state.db`.
 * @param email Account email.
 * @param password New password.
 */
export async function setAccountPassword(
	client: Client,
	email: string,
	password: string
): Promise<RecoveryOutcome> {
	checkPassword(password);
	// Hashing takes a moment; do it before holding the write lock.
	const hash = await hashPassword(password);
	return changeAccount(client, email, async (tx, user) => {
		const now = Date.now();
		const updated = await tx.execute({
			sql: `UPDATE auth_account SET password = ?, updated_at = ?
			      WHERE user_id = ? AND provider_id = 'credential'`,
			args: [hash, now, user.id]
		});
		if (updated.rowsAffected === 0) {
			await tx.execute({
				sql: `INSERT INTO auth_account
				        (id, account_id, provider_id, user_id, password, created_at, updated_at)
				      VALUES (?, ?, 'credential', ?, ?, ?, ?)`,
				args: [generateRandomString(32, 'a-z', 'A-Z', '0-9'), user.id, user.id, hash, now, now]
			});
		}
		return { password_changed: true };
	});
}

/**
 * Make an account an admin and sign it out everywhere, so its next sign-in
 * starts fresh. An account that is already an admin keeps the role and is
 * still signed out.
 * @param client Open `state.db`.
 * @param email Account email.
 */
export async function promoteAccount(client: Client, email: string): Promise<RecoveryOutcome> {
	return changeAccount(client, email, async (tx, user) => {
		if (user.role === 'admin') {
			return {};
		}
		await tx.execute({
			sql: 'UPDATE auth_user SET role = ?, updated_at = ? WHERE id = ?',
			args: ['admin', Date.now(), user.id]
		});
		return { promoted: true };
	});
}

/**
 * What to tell the operator about a finished change.
 * @param outcome Result of `setAccountPassword` or `promoteAccount`.
 */
export function describeOutcome(outcome: RecoveryOutcome): string[] {
	const lines: string[] = [];
	if (outcome.password_changed) {
		lines.push(`Set a new password for ${outcome.email} (${outcome.role}).`);
	}
	if (outcome.promoted) {
		lines.push(`Promoted ${outcome.email} to admin.`);
	} else if (!outcome.password_changed) {
		lines.push(`${outcome.email} is already an admin.`);
	}
	const n = outcome.sessions_revoked;
	lines.push(`Revoked ${n} session${n === 1 ? '' : 's'}.`);
	return lines;
}
