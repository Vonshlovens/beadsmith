/**
 * Roles and permissions (ADR-0011). Two roles today: `admin` runs the console
 * and launches agents; `member` reads. Permissions are Better Auth access
 * control statements so per-project membership and MCP
 * clients can add resources and roles without changing the
 * request gate, which asks for a permission rather than a role name.
 */
import { createAccessControl } from 'better-auth/plugins/access';
import { adminAc, defaultStatements } from 'better-auth/plugins/admin/access';

export const ACCOUNT_ROLES = ['admin', 'member'] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];
export const DEFAULT_ROLE: AccountRole = 'member';

/**
 * `user` / `session` are the admin plugin's own statements (account
 * management). `console` covers every `/console` and `/api/console` route,
 * backups included; `dispatch` covers File/Tackle/comment launches.
 */
export const statements = {
	...defaultStatements,
	console: ['manage'],
	dispatch: ['launch']
} as const;

export const access_control = createAccessControl(statements);

export const roles = {
	admin: access_control.newRole({
		...adminAc.statements,
		console: ['manage'],
		dispatch: ['launch']
	}),
	member: access_control.newRole({ user: [], session: [], console: [], dispatch: [] })
};

export type Permission = { [K in keyof typeof statements]?: (typeof statements)[K][number][] };

/**
 * Normalize a stored role string. The admin plugin allows comma-separated
 * roles; any unknown value collapses to `member`, the least privileged role.
 * @param raw Stored `auth_user.role`.
 */
export function accountRole(raw: string | null | undefined): AccountRole {
	const parts = (raw ?? '')
		.split(',')
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	return parts.includes('admin') ? 'admin' : 'member';
}

/**
 * True when `role` grants every action in `permission`.
 * @param role Effective request role.
 * @param permission Required statements.
 */
export function roleCan(role: AccountRole | undefined, permission: Permission): boolean {
	if (role === undefined) {
		return false;
	}
	return roles[role].authorize(permission).success;
}

/** Admin-only for every method, reads included (the todo list is private to admins). */
const ADMIN_PREFIXES = ['/console', '/api/console', '/api/todos'];
const DISPATCH_PATTERN = /^\/api\/projects\/[^/]+\/dispatch(?:\/|$)/;
/** Mutations a member may make: their own session/password, the shared theme, a re-scan. */
const MEMBER_MUTATIONS = ['/api/auth/', '/api/settings/theme', '/api/projects/refresh'];

/**
 * True when `pathname` is `prefix` or below it.
 * @param pathname Request path.
 * @param prefix Path prefix without a trailing slash.
 */
function under(pathname: string, prefix: string): boolean {
	return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Permission a request needs beyond being signed in, or undefined when any
 * signed-in role may make it. Unknown mutations default to `console:manage`
 * so a new write route is admin-only until someone decides otherwise.
 * @param method Upper-case HTTP method.
 * @param pathname Request path.
 */
export function requiredPermission(method: string, pathname: string): Permission | undefined {
	if (ADMIN_PREFIXES.some((prefix) => under(pathname, prefix))) {
		return { console: ['manage'] };
	}
	const safe = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
	if (safe || !pathname.startsWith('/api/')) {
		return undefined;
	}
	if (DISPATCH_PATTERN.test(pathname)) {
		return { dispatch: ['launch'] };
	}
	if (MEMBER_MUTATIONS.some((prefix) => pathname === prefix || pathname.startsWith(prefix))) {
		return undefined;
	}
	return { console: ['manage'] };
}
