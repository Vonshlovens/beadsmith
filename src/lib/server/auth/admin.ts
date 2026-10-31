/**
 * Account management for the console (ADR-0011). Every call goes through the
 * admin plugin with the caller's own request headers, so Better Auth checks
 * the caller's session and permissions as well as `hooks.server.ts`. On top
 * of that this module keeps at least one admin: nobody may remove or demote
 * themselves, or remove or demote the last admin.
 */
import { isAPIError } from 'better-auth/api';
import { z } from 'zod';
import type { AccountView, AccountsResponse, ApiErrorCode } from '$lib/types.js';
import { ACCOUNT_ROLES, accountRole, type AccountRole } from './roles.js';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, type AuthService } from './service.js';

/** Raised for a refused account change; `message` is fixed copy. */
export class AccountAdminError extends Error {
	code: ApiErrorCode;

	constructor(code: ApiErrorCode, message: string) {
		super(message);
		this.name = 'AccountAdminError';
		this.code = code;
	}
}

export const account_id_schema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

const email_schema = z.string().trim().toLowerCase().pipe(z.email()).pipe(z.string().max(254));
const name_schema = z.string().trim().min(1).max(100);
const role_schema = z.enum(ACCOUNT_ROLES);
/**
 * The field is checked by `assertPasswordLength` (below) instead of zod: the
 * API error scrubber drops any message that names it.
 */
const password_field = z.string().max(4096);

export const create_account_schema = z
	.object({ email: email_schema, name: name_schema, role: role_schema, password: password_field })
	.strict();
export type CreateAccountInput = z.infer<typeof create_account_schema>;

export const update_account_schema = z
	.object({ role: role_schema.optional(), password: password_field.optional() })
	.strict()
	.refine((body) => body.role !== undefined || body.password !== undefined, {
		message: 'nothing to change'
	});
export type UpdateAccountInput = z.infer<typeof update_account_schema>;

export const signup_setting_schema = z.object({ signup_open: z.boolean() }).strict();

/**
 * Refuse a password outside Better Auth's length rules, with copy that
 * survives the error scrubber.
 * @param password Proposed password.
 */
export function assertPasswordLength(password: string): void {
	if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
		throw new AccountAdminError(
			'bad_request',
			`Use ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters.`
		);
	}
}

const ADMIN_ERROR_COPY: Record<string, string> = {
	USER_ALREADY_EXISTS: 'An account with that email already exists.',
	USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: 'An account with that email already exists.',
	INVALID_EMAIL: 'That email address is not valid.',
	USER_NOT_FOUND: 'No such account.',
	YOU_CANNOT_REMOVE_YOURSELF: 'You cannot remove your own account.'
};

const STATUS_CODE: Record<number, ApiErrorCode> = {
	400: 'bad_request',
	401: 'unauthorized',
	403: 'forbidden',
	404: 'not_found',
	409: 'conflict'
};

/**
 * Translate a Better Auth failure into fixed copy and a contract code.
 * @param error Thrown value.
 */
function translate(error: unknown): never {
	if (error instanceof AccountAdminError) {
		throw error;
	}
	if (isAPIError(error)) {
		const code = STATUS_CODE[error.statusCode] ?? 'unavailable';
		const body = (error.body ?? {}) as { code?: string };
		const message =
			(body.code === undefined ? undefined : ADMIN_ERROR_COPY[body.code]) ??
			(code === 'forbidden' ? 'Not allowed.' : 'The account change failed.');
		throw new AccountAdminError(code, message);
	}
	throw error;
}

/**
 * The console's view of one account.
 * @param user Admin-plugin user row.
 */
function toView(user: {
	id: string;
	email: string;
	name: string;
	role?: string | null;
	banned?: boolean | null;
	createdAt: Date | string;
}): AccountView {
	return {
		id: user.id,
		email: user.email,
		name: user.name,
		role: accountRole(user.role),
		banned: user.banned === true,
		created_at: new Date(user.createdAt).toISOString()
	};
}

/**
 * Every account, oldest first, plus the sign-up switch.
 * @param service Account service.
 * @param headers The admin's request headers.
 */
export async function listAccounts(
	service: AuthService,
	headers: Headers
): Promise<AccountsResponse> {
	try {
		const result = await service.auth.api.listUsers({
			headers,
			query: { limit: 500, sortBy: 'createdAt', sortDirection: 'asc' }
		});
		return {
			signup_open: await service.store.getSignupOpen(),
			users: result.users.map(toView),
			min_password_length: MIN_PASSWORD_LENGTH
		};
	} catch (error) {
		translate(error);
	}
}

/**
 * Create an account with an initial password ("invite" without email).
 * @param service Account service.
 * @param headers The admin's request headers.
 * @param input Validated body.
 */
export async function createAccount(
	service: AuthService,
	headers: Headers,
	input: CreateAccountInput
): Promise<AccountView> {
	assertPasswordLength(input.password);
	try {
		const result = await service.auth.api.createUser({
			headers,
			body: { email: input.email, name: input.name, password: input.password, role: input.role }
		});
		return toView(result.user);
	} catch (error) {
		translate(error);
	}
}

/**
 * Look up one account's role, or fail with 404.
 * @param service Account service.
 * @param headers The admin's request headers.
 * @param user_id Target account id.
 */
async function roleOf(
	service: AuthService,
	headers: Headers,
	user_id: string
): Promise<AccountRole> {
	try {
		const user = await service.auth.api.getUser({ headers, query: { id: user_id } });
		return accountRole(user.role);
	} catch (error) {
		translate(error);
	}
}

/**
 * Refuse a change that would leave no admin, or that targets the caller's
 * own admin rights.
 * @param service Account service.
 * @param actor_id The signed-in admin.
 * @param user_id Target account.
 * @param current Target's current role.
 */
async function assertKeepsAnAdmin(
	service: AuthService,
	actor_id: string,
	user_id: string,
	current: AccountRole
): Promise<void> {
	if (user_id === actor_id) {
		throw new AccountAdminError(
			'forbidden',
			'You cannot remove or demote your own account. Ask another admin.'
		);
	}
	if (current === 'admin' && (await service.store.countAdmins()) <= 1) {
		throw new AccountAdminError('forbidden', 'Beadsmith needs at least one admin.');
	}
}

/**
 * Change an account's role and/or set a new password (which signs it out).
 * @param service Account service.
 * @param headers The admin's request headers.
 * @param actor_id The signed-in admin.
 * @param user_id Target account.
 * @param input Validated body.
 */
export async function updateAccount(
	service: AuthService,
	headers: Headers,
	actor_id: string,
	user_id: string,
	input: UpdateAccountInput
): Promise<AccountView> {
	if (input.password !== undefined) {
		assertPasswordLength(input.password);
	}
	const current = await roleOf(service, headers, user_id);
	if (input.role !== undefined && input.role !== current) {
		if (input.role !== 'admin') {
			await assertKeepsAnAdmin(service, actor_id, user_id, current);
		}
	}
	try {
		if (input.role !== undefined && input.role !== current) {
			await service.auth.api.setRole({ headers, body: { userId: user_id, role: input.role } });
		}
		if (input.password !== undefined) {
			await service.auth.api.setUserPassword({
				headers,
				body: { userId: user_id, newPassword: input.password }
			});
			if (user_id !== actor_id) {
				await service.auth.api.revokeUserSessions({ headers, body: { userId: user_id } });
			}
		}
		return toView(await service.auth.api.getUser({ headers, query: { id: user_id } }));
	} catch (error) {
		translate(error);
	}
}

/**
 * Delete an account and its sessions.
 * @param service Account service.
 * @param headers The admin's request headers.
 * @param actor_id The signed-in admin.
 * @param user_id Target account.
 */
export async function removeAccount(
	service: AuthService,
	headers: Headers,
	actor_id: string,
	user_id: string
): Promise<void> {
	const current = await roleOf(service, headers, user_id);
	await assertKeepsAnAdmin(service, actor_id, user_id, current);
	try {
		await service.auth.api.removeUser({ headers, body: { userId: user_id } });
	} catch (error) {
		translate(error);
	}
}
