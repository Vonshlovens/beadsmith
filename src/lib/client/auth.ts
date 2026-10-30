/**
 * Browser calls to the Better Auth endpoints under `/api/auth` (ADR-0011).
 * Kept apart from `api.ts`: these return Better Auth's `{ code, message }`
 * errors, and a 401 here means a wrong password, not a lapsed session.
 */

/** Header the first-admin form sends; mirrors `SETUP_TOKEN_HEADER` on the server. */
const SETUP_TOKEN_HEADER = 'x-bdx-setup-token';

export class AuthRequestError extends Error {
	code: string;
	status: number;

	/**
	 * @param code - Better Auth or API error code.
	 * @param message - Server message.
	 * @param status - HTTP status.
	 */
	constructor(code: string, message: string, status: number) {
		super(message);
		this.name = 'AuthRequestError';
		this.code = code;
		this.status = status;
	}
}

const COPY: Record<string, string> = {
	INVALID_EMAIL_OR_PASSWORD: 'That email and password do not match an account.',
	SETUP_TOKEN_INVALID:
		'That setup token is not right. Copy it from the setup-token file in the state directory.',
	SIGNUP_CLOSED: 'Sign-up is closed. Ask an admin to create your account.',
	PASSWORD_TOO_SHORT: 'The password is too short.',
	PASSWORD_TOO_LONG: 'The password is too long.',
	INVALID_PASSWORD: 'The current password is wrong.',
	USER_ALREADY_EXISTS: 'An account with that email already exists.',
	USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: 'An account with that email already exists.',
	INVALID_EMAIL: 'That email address is not valid.',
	BANNED_USER: 'This account is disabled.',
	rate_limited: 'Too many attempts. Wait a minute and try again.'
};

/**
 * Human copy for a failed auth call.
 * @param error - Anything thrown by the helpers below.
 */
export function authErrorMessage(error: unknown): string {
	if (error instanceof AuthRequestError) {
		return COPY[error.code] ?? error.message;
	}
	return error instanceof Error ? error.message : 'Something went wrong.';
}

/**
 * POST JSON to `/api/auth<path>` with the CSRF header.
 * @param path - Endpoint below `/api/auth`.
 * @param body - JSON body.
 * @param headers - Extra headers.
 */
async function post(
	path: string,
	body: unknown,
	headers: Record<string, string> = {}
): Promise<unknown> {
	const response = await fetch(`/api/auth${path}`, {
		method: 'POST',
		credentials: 'same-origin',
		headers: {
			accept: 'application/json',
			'content-type': 'application/json',
			'x-bdx-request': '1',
			...headers
		},
		body: JSON.stringify(body)
	});
	let payload: unknown = null;
	try {
		payload = await response.json();
	} catch {
		/* empty or non-JSON body */
	}
	if (!response.ok) {
		const record = (payload ?? {}) as {
			code?: string;
			message?: string;
			error?: { code?: string; message?: string };
		};
		const code = record.code ?? record.error?.code ?? `http_${response.status}`;
		const message =
			record.message ?? record.error?.message ?? `Request failed with status ${response.status}`;
		throw new AuthRequestError(code, message, response.status);
	}
	return payload;
}

export const auth = {
	signIn(email: string, password: string) {
		return post('/sign-in/email', { email, password, rememberMe: true });
	},

	/** Self-service sign-up; the first account also needs the setup token. */
	signUp(input: { name: string; email: string; password: string; setup_token?: string }) {
		const headers: Record<string, string> =
			input.setup_token === undefined ? {} : { [SETUP_TOKEN_HEADER]: input.setup_token.trim() };
		return post(
			'/sign-up/email',
			{ name: input.name, email: input.email, password: input.password },
			headers
		);
	},

	signOut() {
		return post('/sign-out', {});
	},

	changePassword(current_password: string, new_password: string) {
		return post('/change-password', {
			currentPassword: current_password,
			newPassword: new_password,
			revokeOtherSessions: true
		});
	}
};

/**
 * A same-origin path to return to after sign-in, or `/`. Rejects absolute
 * and protocol-relative URLs so the parameter cannot become an open redirect.
 * @param raw - `redirect` query value.
 */
export function safeRedirectPath(raw: string | null | undefined): string {
	if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) {
		return '/';
	}
	if (raw.includes('\\') || /[\u0000-\u001f]/.test(raw) || raw.startsWith('/auth')) {
		return '/';
	}
	return raw;
}
