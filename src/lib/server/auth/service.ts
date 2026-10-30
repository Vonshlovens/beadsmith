/**
 * Built-in accounts (ADR-0011): Better Auth over the service-local SQLite
 * file, email+password sign-in, and the admin plugin for `admin` / `member`
 * roles. Always on: `hooks.server.ts` requires a signed-in account on every
 * route except the sign-in page and `/api/auth/*`. The cookie-signing secret
 * is `BETTER_AUTH_SECRET_FILE` or one generated in the state directory.
 *
 * Better Auth's own rate limiter is off: `hooks.server.ts` meters every
 * request, and charges credential endpoints to a smaller per-address bucket.
 */
import type { Client } from '@libsql/client';
import { betterAuth } from 'better-auth/minimal';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { admin } from 'better-auth/plugins/admin';
import { drizzle } from 'drizzle-orm/libsql';
import { PRODUCT_NAME } from '$lib/product.js';
import { getEnv } from '../env.js';
import { SESSION_COOKIE, expectedOrigin } from '../security.js';
import { authSchema } from '../state/schema.js';
import { getStateClient } from '../state/db.js';
import { createSetupTokenFile, SETUP_TOKEN_HEADER, type SetupTokenFile } from './bootstrap.js';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './password-policy.js';
import { access_control, accountRole, DEFAULT_ROLE, roles, type AccountRole } from './roles.js';
import { resolveAuthSecret } from './secret.js';
import { createAccountStore, type AccountStore } from './store.js';

export { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH };
export const AUTH_BASE_PATH = '/api/auth';
export const SESSION_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60;
export const SESSION_UPDATE_AGE_SECONDS = 24 * 60 * 60;

/** The signed-in account as the rest of the app sees it. */
export interface SignedInUser {
	id: string;
	email: string;
	name: string;
	role: AccountRole;
}

export interface ResolvedSession {
	user: SignedInUser;
	session_id: string;
}

export interface SessionLookup {
	session: ResolvedSession | null;
	/** `Set-Cookie` values Better Auth emitted (a refreshed or cleared cookie). */
	set_cookies: string[];
}

export interface AuthServiceOptions {
	client: Client;
	secret: string;
	state_dir: string;
	/** Configured public origin (`BDX_PUBLIC_ORIGIN`), used as Better Auth's base URL. */
	public_origin?: { hostname: string; origin: string };
	setup?: SetupTokenFile;
}

/** Fixed error codes the sign-in page maps to copy. */
export const AUTH_ERROR = {
	setup_token: 'SETUP_TOKEN_INVALID',
	signup_closed: 'SIGNUP_CLOSED'
} as const;

/**
 * Decide whether a self-service account may be created right now and with
 * which role. The first account needs the setup token and becomes admin;
 * later ones need open sign-up and become members. Throws `APIError`.
 * @param store Account store.
 * @param setup Setup token file.
 * @param headers Request headers (carry the setup token).
 */
async function selfSignupRole(
	store: AccountStore,
	setup: SetupTokenFile,
	headers: Headers | undefined
): Promise<AccountRole> {
	if ((await store.countUsers()) === 0) {
		if (!setup.matches(headers?.get(SETUP_TOKEN_HEADER))) {
			throw APIError.from('FORBIDDEN', {
				code: AUTH_ERROR.setup_token,
				message: 'A valid setup token is required to create the first admin account.'
			});
		}
		return 'admin';
	}
	if (await store.getSignupOpen()) {
		return DEFAULT_ROLE;
	}
	throw APIError.from('FORBIDDEN', {
		code: AUTH_ERROR.signup_closed,
		message: 'Sign-up is closed. Ask an admin to create your account.'
	});
}

/**
 * Better Auth messages go to the server log only, without their argument
 * objects (those can carry request data), and only at warn or error. The
 * missing-base-URL warning is expected without `BDX_PUBLIC_ORIGIN`: the hooks
 * have already pinned Host.
 */
function logAuthMessage(level: string, message: string): void {
	if ((level !== 'warn' && level !== 'error') || message.includes('Base URL is not set')) {
		return;
	}
	const line = `beads-web accounts ${level}: ${message}`;
	if (level === 'error') {
		console.error(line);
	} else {
		console.warn(line);
	}
}

/**
 * Build the Better Auth instance. Exported for tests; the app uses
 * `getAuthService`.
 * @param options Database, secret, and origin configuration.
 */
export function buildAuth(options: AuthServiceOptions, store: AccountStore, setup: SetupTokenFile) {
	return betterAuth({
		appName: PRODUCT_NAME,
		secret: options.secret,
		basePath: AUTH_BASE_PATH,
		...(options.public_origin === undefined ? {} : { baseURL: options.public_origin.origin }),
		database: drizzleAdapter(drizzle(options.client, { schema: authSchema }), {
			provider: 'sqlite',
			schema: authSchema
		}),
		emailAndPassword: {
			enabled: true,
			autoSignIn: true,
			requireEmailVerification: false,
			minPasswordLength: MIN_PASSWORD_LENGTH,
			maxPasswordLength: MAX_PASSWORD_LENGTH,
			revokeSessionsOnPasswordReset: true
		},
		session: {
			expiresIn: SESSION_EXPIRES_IN_SECONDS,
			updateAge: SESSION_UPDATE_AGE_SECONDS,
			// Read the session row on every request so a role change, ban, or
			// removal takes effect immediately.
			cookieCache: { enabled: false }
		},
		user: {
			changeEmail: { enabled: false },
			deleteUser: { enabled: false }
		},
		account: { accountLinking: { enabled: false } },
		rateLimit: { enabled: false },
		telemetry: { enabled: false },
		// The hooks already rejected any Origin but this one; Better Auth repeats
		// the check for cookie-bearing POSTs, so give it the same answer.
		trustedOrigins: (request) => {
			if (request === undefined) {
				return [];
			}
			return [
				expectedOrigin(
					request.headers.get('host'),
					new URL(request.url).origin,
					options.public_origin
				)
			];
		},
		advanced: {
			// Cookie names are fixed below; this only stops a `__Secure-` prefix
			// being added in front of `__Host-`. Attributes force Secure anyway.
			useSecureCookies: false,
			cookiePrefix: 'bdx',
			cookies: {
				session_token: { name: SESSION_COOKIE },
				session_data: { name: '__Host-bdx_session_data' },
				dont_remember: { name: '__Host-bdx_dont_remember' }
			},
			defaultCookieAttributes: {
				secure: true,
				httpOnly: true,
				sameSite: 'strict',
				path: '/'
			},
			// No proxy header is trusted for addresses; sessions record none.
			ipAddress: { disableIpTracking: true }
		},
		// `info`, not `warn`: at warn or error Better Auth also prints every
		// expected refusal (wrong password, closed sign-up) as an ERROR line
		// through its default logger. Internal errors still reach this one.
		logger: { level: 'info', log: (level, message) => logAuthMessage(level, message) },
		plugins: [
			admin({
				ac: access_control,
				roles,
				defaultRole: DEFAULT_ROLE,
				adminRoles: ['admin']
			})
		],
		hooks: {
			// Reject a closed sign-up before Better Auth hashes the password.
			before: createAuthMiddleware(async (ctx) => {
				if (ctx.path === '/sign-up/email') {
					await selfSignupRole(store, setup, ctx.headers);
				}
			})
		},
		databaseHooks: {
			user: {
				create: {
					// Every account creation passes here, whatever endpoint started
					// it, so this is the one place sign-up policy is enforced.
					before: async (user, ctx) => {
						if (ctx?.path === '/admin/create-user') {
							// The admin plugin has already checked the caller holds
							// `user:create`, and validated the requested role.
							return { data: { ...user, role: accountRole(user.role as string | undefined) } };
						}
						const role = await selfSignupRole(store, setup, ctx?.headers);
						return { data: { ...user, role } };
					},
					after: async () => {
						setup.clear();
					}
				}
			}
		}
	});
}

export type BeadsmithAuth = ReturnType<typeof buildAuth>;

export interface AuthService {
	auth: BeadsmithAuth;
	store: AccountStore;
	setup: SetupTokenFile;
	/** Resolve the session cookie on `headers`, if any. */
	lookupSession(headers: Headers): Promise<SessionLookup>;
	/** True while no account exists; ensures the setup token file then. */
	needsBootstrap(): Promise<boolean>;
}

/**
 * Wire Better Auth to the account store and setup token.
 * @param options Database, secret, and origin configuration.
 */
export function createAuthService(options: AuthServiceOptions): AuthService {
	const store = createAccountStore(options.client);
	const setup = options.setup ?? createSetupTokenFile(options.state_dir);
	const auth = buildAuth(options, store, setup);

	return {
		auth,
		store,
		setup,
		async lookupSession(headers: Headers): Promise<SessionLookup> {
			if (!(headers.get('cookie') ?? '').includes(SESSION_COOKIE)) {
				return { session: null, set_cookies: [] };
			}
			const result = await auth.api.getSession({ headers, returnHeaders: true });
			const set_cookies = result.headers.getSetCookie();
			const data = result.response;
			if (data === null) {
				return { session: null, set_cookies };
			}
			return {
				session: {
					session_id: data.session.id,
					user: {
						id: data.user.id,
						email: data.user.email,
						name: data.user.name,
						role: accountRole(data.user.role)
					}
				},
				set_cookies
			};
		},
		async needsBootstrap(): Promise<boolean> {
			if ((await store.countUsers()) > 0) {
				return false;
			}
			setup.ensure();
			return true;
		}
	};
}

let service_promise: Promise<AuthService> | undefined;

/**
 * Open (once) the process-wide account service. Rejects, and is retried on
 * the next call, when the secret or the state database is unavailable; the
 * hooks then fail every request closed.
 */
export function getAuthService(): Promise<AuthService> {
	if (service_promise === undefined) {
		service_promise = (async () => {
			const env = getEnv();
			const [secret, client] = await Promise.all([
				resolveAuthSecret({ state_dir: env.state_dir }),
				getStateClient()
			]);
			return createAuthService({
				client,
				secret,
				state_dir: env.state_dir,
				public_origin: env.public_origin
			});
		})().catch((error: unknown) => {
			service_promise = undefined;
			throw error;
		});
	}
	return service_promise;
}

/** Replace the process-wide service (tests only). */
export function setAuthServiceForTest(service: AuthService | undefined): void {
	service_promise = service === undefined ? undefined : Promise.resolve(service);
}
