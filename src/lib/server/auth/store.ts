/**
 * Account tables in `state.db` (ADR-0011) and the small queries Beadsmith runs
 * on them itself. Better Auth owns every row write through its Drizzle
 * adapter; this module only creates the tables, counts accounts for the
 * first-run bootstrap and last-admin guard, and stores the sign-up switch.
 */
import type { Client } from '@libsql/client';

/** `settings` key: `open` lets anyone with the URL create a member account. */
export const SIGNUP_SETTING_KEY = 'auth.signup';

/**
 * Keep in step with `authUser` / `authSession` / `authAccount` /
 * `authVerification` in `state/schema.ts`. Timestamps are epoch milliseconds,
 * booleans 0/1, as Drizzle's `timestamp_ms` / `boolean` modes write them.
 */
export const AUTH_SCHEMA_SQL: string[] = [
	`CREATE TABLE IF NOT EXISTS auth_user (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		email TEXT NOT NULL UNIQUE,
		email_verified INTEGER NOT NULL DEFAULT 0,
		image TEXT,
		role TEXT,
		banned INTEGER DEFAULT 0,
		ban_reason TEXT,
		ban_expires INTEGER,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS auth_session (
		id TEXT PRIMARY KEY,
		token TEXT NOT NULL UNIQUE,
		user_id TEXT NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
		expires_at INTEGER NOT NULL,
		ip_address TEXT,
		user_agent TEXT,
		impersonated_by TEXT,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	)`,
	'CREATE INDEX IF NOT EXISTS auth_session_user_id_idx ON auth_session (user_id)',
	`CREATE TABLE IF NOT EXISTS auth_account (
		id TEXT PRIMARY KEY,
		account_id TEXT NOT NULL,
		provider_id TEXT NOT NULL,
		user_id TEXT NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
		access_token TEXT,
		refresh_token TEXT,
		id_token TEXT,
		access_token_expires_at INTEGER,
		refresh_token_expires_at INTEGER,
		scope TEXT,
		password TEXT,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	)`,
	'CREATE INDEX IF NOT EXISTS auth_account_user_id_idx ON auth_account (user_id)',
	`CREATE TABLE IF NOT EXISTS auth_verification (
		id TEXT PRIMARY KEY,
		identifier TEXT NOT NULL,
		value TEXT NOT NULL,
		expires_at INTEGER NOT NULL,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	)`,
	'CREATE INDEX IF NOT EXISTS auth_verification_identifier_idx ON auth_verification (identifier)'
];

export interface AccountStore {
	/** Every account, banned or not. Zero means first-run bootstrap. */
	countUsers(): Promise<number>;
	/** Accounts holding the admin role that are not banned. */
	countAdmins(): Promise<number>;
	/** Whether self-service sign-up creates member accounts. Default closed. */
	getSignupOpen(): Promise<boolean>;
	setSignupOpen(open: boolean): Promise<void>;
}

/** Read a `COUNT(*)` result, whatever integer type the driver returns. */
function countOf(rows: unknown[]): number {
	const row = rows[0] as Record<string, unknown> | undefined;
	const value = row === undefined ? 0 : Object.values(row)[0];
	return Number(value ?? 0);
}

/** Build the account store over an already-initialised libsql client. */
export function createAccountStore(client: Client): AccountStore {
	return {
		async countUsers(): Promise<number> {
			const result = await client.execute('SELECT COUNT(*) AS n FROM auth_user');
			return countOf(result.rows);
		},

		async countAdmins(): Promise<number> {
			// The admin plugin stores multiple roles comma-separated.
			const result = await client.execute(
				`SELECT COUNT(*) AS n FROM auth_user
				 WHERE (',' || REPLACE(COALESCE(role, ''), ' ', '') || ',') LIKE '%,admin,%'
				   AND COALESCE(banned, 0) = 0`
			);
			return countOf(result.rows);
		},

		async getSignupOpen(): Promise<boolean> {
			const result = await client.execute({
				sql: 'SELECT value FROM settings WHERE key = ?',
				args: [SIGNUP_SETTING_KEY]
			});
			const row = result.rows[0] as Record<string, unknown> | undefined;
			return row?.value === 'open';
		},

		async setSignupOpen(open: boolean): Promise<void> {
			await client.execute({
				sql: 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
				args: [SIGNUP_SETTING_KEY, open ? 'open' : 'closed']
			});
		}
	};
}
