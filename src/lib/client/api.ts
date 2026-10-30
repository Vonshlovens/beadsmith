/**
 * Typed client for the `/api` surface described in docs/contract.md.
 *
 * Every request is same-origin and relative, mutations carry the
 * `x-bdx-request: 1` CSRF hard-stop header, and error bodies are parsed into
 * `ApiError` so callers can branch on `code` instead of scraping messages.
 */
import { browser } from '$app/environment';
import { goto } from '$app/navigation';
import type {
	AccountRole,
	AccountView,
	AccountsResponse,
	ActivityEvent,
	ApiErrorBody,
	ApiErrorCode,
	BackupConfigView,
	BackupSettingsUpdate,
	BackupsResponse,
	ConsoleProjectRow,
	ConsoleSnapshot,
	DispatchProjectAllow,
	DiscussIntent,
	DispatchRequest,
	DispatchTurnsResponse,
	DoltFailureKind,
	IssueDetailResponse,
	IssueListResponse,
	Mission,
	Project,
	ReadyListResponse,
	StatusSnapshot,
	ThemePreference
} from '$lib/types';

import type { Todo, TodoComment, TodoStatus } from '$lib/server/todos/store';

const BASE_URL = '/api';

/** Error thrown for any non-2xx API response. */
export class ApiError extends Error {
	code: ApiErrorCode;
	status: number;
	failure_kind?: DoltFailureKind;

	/**
	 * @param code - Machine-readable error code from the server envelope.
	 * @param message - Human-readable message, already scrubbed server-side.
	 * @param status - HTTP status code.
	 * @param failure_kind - Optional fixed remote-Dolt failure class.
	 */
	constructor(code: ApiErrorCode, message: string, status: number, failure_kind?: DoltFailureKind) {
		super(message);
		this.name = 'ApiError';
		this.code = code;
		this.status = status;
		this.failure_kind = failure_kind;
	}
}

export type FetchLike = typeof globalThis.fetch;

export interface RequestInitLike {
	/** SvelteKit's `fetch` during `load`, else the global one. */
	fetch?: FetchLike;
	signal?: AbortSignal;
}

type QueryValue = string | number | boolean | undefined | null;

/**
 * Build a query string from defined values only.
 *
 * @param query - Raw parameter map.
 */
function buildQuery(query: Record<string, QueryValue> | undefined): string {
	if (!query) {
		return '';
	}

	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (value === undefined || value === null || value === '') {
			continue;
		}
		params.set(key, String(value));
	}

	const encoded = params.toString();
	return encoded ? `?${encoded}` : '';
}

/**
 * Read the contract error envelope, falling back to a generic message.
 *
 * @param response - The failed response.
 */
async function readError(response: Response): Promise<ApiError> {
	let code: ApiErrorCode = 'bad_request';
	let message = `Request failed with status ${response.status}`;
	let failure_kind: DoltFailureKind | undefined;

	try {
		const body = (await response.json()) as Partial<ApiErrorBody>;
		if (body && body.error && typeof body.error.message === 'string') {
			code = body.error.code;
			message = body.error.message;
			if (
				body.error.failure_kind === 'credential_unavailable' ||
				body.error.failure_kind === 'authentication_rejected' ||
				body.error.failure_kind === 'unreachable' ||
				body.error.failure_kind === 'unknown'
			) {
				failure_kind = body.error.failure_kind;
			}
		}
	} catch {
		/* non-JSON body — keep the fallback message */
	}

	return new ApiError(code, message, response.status, failure_kind);
}

/**
 * Perform an API request and decode its JSON body.
 *
 * @param method - HTTP method.
 * @param path - Path below `/api`, starting with a slash.
 * @param options - Body, query and fetch overrides.
 */
async function request<T>(
	method: string,
	path: string,
	options: RequestInitLike & { body?: unknown; query?: Record<string, QueryValue> } = {}
): Promise<T> {
	const fetch_impl = options.fetch ?? globalThis.fetch;
	const is_mutation = method !== 'GET' && method !== 'HEAD';

	const headers: Record<string, string> = { accept: 'application/json' };
	if (is_mutation) {
		headers['x-bdx-request'] = '1';
	}
	if (options.body !== undefined) {
		headers['content-type'] = 'application/json';
	}

	const response = await fetch_impl(`${BASE_URL}${path}${buildQuery(options.query)}`, {
		method,
		headers,
		credentials: 'same-origin',
		signal: options.signal,
		body: options.body === undefined ? undefined : JSON.stringify(options.body)
	});

	if (response.status === 401) {
		if (browser) {
			await goto('/auth');
		}
		throw new ApiError('unauthorized', 'This session is not signed in.', 401);
	}

	if (!response.ok) {
		throw await readError(response);
	}

	if (response.status === 204) {
		return undefined as T;
	}

	return (await response.json()) as T;
}

export interface IssueFilters {
	status?: string;
	type?: string;
	priority?: string;
	q?: string;
	limit?: number;
	include_closed?: boolean;
}

export const api = {
	/** Health snapshot driving the top-right status cluster. */
	status(init?: RequestInitLike) {
		return request<StatusSnapshot>('GET', '/status', init);
	},

	/** Operator console: catalog coverage and redacted health. */
	console(init?: RequestInitLike) {
		return request<ConsoleSnapshot>('GET', '/console', init);
	},

	/** Persist a console-edited Tackle map for one discovered project. */
	putTackleMap(
		project_id: string,
		body: { url: string; ref?: string; auto_create_pr?: boolean },
		init?: RequestInitLike
	) {
		return request<{ project_id: string; tackle: ConsoleProjectRow['tackle'] }>(
			'PUT',
			`/console/projects/${encodeURIComponent(project_id)}/tackle-map`,
			{ ...init, body }
		);
	},

	/** Persist a console-edited File checkout for one discovered project. */
	putFileMap(project_id: string, body: { url: string; ref?: string }, init?: RequestInitLike) {
		return request<{ project_id: string; file: ConsoleProjectRow['file'] }>(
			'PUT',
			`/console/projects/${encodeURIComponent(project_id)}/file-map`,
			{ ...init, body }
		);
	},

	/** Arm or disarm File/Tackle globally. Provider configuration is unchanged. */
	setDispatchArmed(armed: boolean, init?: RequestInitLike) {
		return request<{ armed: boolean }>('PUT', '/console/dispatch', { ...init, body: { armed } });
	},

	/** Backup settings (no secrets), recent runs, and run state. */
	backups(init?: RequestInitLike) {
		return request<BackupsResponse>('GET', '/console/backups', init);
	},

	/** Save backup settings; secrets are write-only. */
	putBackups(body: BackupSettingsUpdate, init?: RequestInitLike) {
		return request<{ config: BackupConfigView }>('PUT', '/console/backups', { ...init, body });
	},

	/** Start a manual backup run in the background. */
	runBackup(init?: RequestInitLike) {
		return request<{ started: boolean }>('POST', '/console/backups/run', { ...init, body: {} });
	},

	/** Write and delete a probe object with the saved settings. */
	testBackup(init?: RequestInitLike) {
		return request<{ ok: boolean }>('POST', '/console/backups/test', { ...init, body: {} });
	},

	/** Accounts and the sign-up switch (ADR-0011). */
	accounts(init?: RequestInitLike) {
		return request<AccountsResponse>('GET', '/console/accounts', init);
	},

	/** Let anyone with the URL create a member account, or stop it. */
	setSignupOpen(signup_open: boolean, init?: RequestInitLike) {
		return request<{ signup_open: boolean }>('PUT', '/console/accounts', {
			...init,
			body: { signup_open }
		});
	},

	/** Create an account with an initial password. */
	createAccount(
		body: { email: string; name: string; role: AccountRole; password: string },
		init?: RequestInitLike
	) {
		return request<{ user: AccountView }>('POST', '/console/accounts/users', { ...init, body });
	},

	/** Change an account's role, or give it a new password (signs it out). */
	updateAccount(
		user_id: string,
		body: { role?: AccountRole; password?: string },
		init?: RequestInitLike
	) {
		return request<{ user: AccountView }>(
			'PATCH',
			`/console/accounts/users/${encodeURIComponent(user_id)}`,
			{ ...init, body }
		);
	},

	/** Remove an account and its sessions. */
	removeAccount(user_id: string, init?: RequestInitLike) {
		return request<void>('DELETE', `/console/accounts/users/${encodeURIComponent(user_id)}`, init);
	},

	/** Persist per-project File vs Tackle allow. Extra keys fail closed. */
	putDispatchAllow(project_id: string, allow: DispatchProjectAllow, init?: RequestInitLike) {
		return request<{ project_id: string; allow: DispatchProjectAllow }>(
			'PUT',
			`/console/projects/${encodeURIComponent(project_id)}/allow`,
			{ ...init, body: allow }
		);
	},

	/** Clear a console-edited Tackle map (env/file maps are unchanged). */
	deleteTackleMap(project_id: string, init?: RequestInitLike) {
		return request<{ project_id: string; tackle: ConsoleProjectRow['tackle'] }>(
			'DELETE',
			`/console/projects/${encodeURIComponent(project_id)}/tackle-map`,
			init
		);
	},

	/** Clear a console-edited File checkout (Tackle maps are unchanged). */
	deleteFileMap(project_id: string, init?: RequestInitLike) {
		return request<{ project_id: string; file: ConsoleProjectRow['file'] }>(
			'DELETE',
			`/console/projects/${encodeURIComponent(project_id)}/file-map`,
			init
		);
	},

	/** All known projects with their reconciliation state. */
	projects(init?: RequestInitLike) {
		return request<{ projects: Project[] }>('GET', '/projects', init);
	},

	/** Force a new project-discovery pass. */
	refreshProjects(init?: RequestInitLike) {
		return request<{ projects: Project[] }>('POST', '/projects/refresh', {
			...init,
			body: {}
		});
	},

	/** Persist the UI theme preference so the next page load paints it. */
	setTheme(theme: ThemePreference, init?: RequestInitLike) {
		return request<{ theme: ThemePreference }>('POST', '/settings/theme', {
			...init,
			body: { theme }
		});
	},

	/** Issue list for one project. */
	issues(project_id: string, filters: IssueFilters = {}, init?: RequestInitLike) {
		return request<IssueListResponse>('GET', `/projects/${encodeURIComponent(project_id)}/issues`, {
			...init,
			query: {
				status: filters.status,
				type: filters.type,
				priority: filters.priority,
				q: filters.q,
				limit: filters.limit,
				include_closed: filters.include_closed ? '1' : undefined
			}
		});
	},

	issue(project_id: string, issue_id: string, init?: RequestInitLike) {
		return request<IssueDetailResponse>(
			'GET',
			`/projects/${encodeURIComponent(project_id)}/issues/${encodeURIComponent(issue_id)}`,
			init
		);
	},

	/** Per-project activity feed. */
	projectActivity(project_id: string, limit = 30, init?: RequestInitLike) {
		return request<{ events: ActivityEvent[] }>(
			'GET',
			`/projects/${encodeURIComponent(project_id)}/activity`,
			{ ...init, query: { limit } }
		);
	},

	/** Cross-project merged activity feed. */
	activity(limit = 30, init?: RequestInitLike) {
		return request<{ events: ActivityEvent[] }>('GET', '/activity', { ...init, query: { limit } });
	},

	/** Cross-project Ready deck: unblocked open issues, priority-sorted. */
	ready(limit = 100, init?: RequestInitLike) {
		return request<ReadyListResponse>('GET', '/ready', { ...init, query: { limit } });
	},

	/** Launch an agent to file a Beads issue. */
	fileIssue(
		project_id: string,
		body: {
			idempotency_key: string;
			notes: string;
			title?: string;
			issue_type?: string;
			priority?: number;
			labels?: string[];
			status?: string;
		},
		init?: RequestInitLike
	) {
		return request<{ request: DispatchRequest }>(
			'POST',
			`/projects/${encodeURIComponent(project_id)}/dispatch`,
			{ ...init, body: { operation: 'file', ...body } }
		);
	},

	/** Launch an agent to claim and implement a Beads issue. */
	tackleIssue(
		project_id: string,
		body: {
			idempotency_key: string;
			issue_id: string;
			destination_status?: 'open' | 'in_progress' | 'blocked' | 'deferred' | 'closed';
		},
		init?: RequestInitLike
	) {
		return request<{ request: DispatchRequest }>(
			'POST',
			`/projects/${encodeURIComponent(project_id)}/dispatch`,
			{ ...init, body: { operation: 'tackle', ...body } }
		);
	},

	/** Launch an agent to add a Beads comment. */
	commentIssue(
		project_id: string,
		body: { idempotency_key: string; issue_id: string; text: string },
		init?: RequestInitLike
	) {
		return request<{ request: DispatchRequest }>(
			'POST',
			`/projects/${encodeURIComponent(project_id)}/dispatch`,
			{ ...init, body: { operation: 'comment', ...body } }
		);
	},

	/** Ask an agent to discuss, elaborate, or close an issue. */
	discussIssue(
		project_id: string,
		body: { idempotency_key: string; issue_id: string; intent: DiscussIntent; message?: string },
		init?: RequestInitLike
	) {
		return request<{ request: DispatchRequest }>(
			'POST',
			`/projects/${encodeURIComponent(project_id)}/dispatch`,
			{ ...init, body: { operation: 'discuss', ...body } }
		);
	},

	/** One mission's conversation: operator messages and finished runs' replies. */
	dispatchTurns(project_id: string, request_id: string, init?: RequestInitLike) {
		return request<DispatchTurnsResponse>(
			'GET',
			`/projects/${encodeURIComponent(project_id)}/dispatch/${encodeURIComponent(request_id)}/turns`,
			init
		);
	},

	dispatch(project_id: string, request_id: string, init?: RequestInitLike) {
		return request<{ request: DispatchRequest }>(
			'GET',
			`/projects/${encodeURIComponent(project_id)}/dispatch/${encodeURIComponent(request_id)}`,
			init
		);
	},

	/** Cancel the active agent run for a File/Tackle mission. */
	cancelDispatch(project_id: string, request_id: string, init?: RequestInitLike) {
		return request<{ request: DispatchRequest }>(
			'POST',
			`/projects/${encodeURIComponent(project_id)}/dispatch/${encodeURIComponent(request_id)}/cancel`,
			init
		);
	},

	/** Send a size-capped follow-up on the same agent. */
	followUpDispatch(
		project_id: string,
		request_id: string,
		body: { text: string },
		init?: RequestInitLike
	) {
		return request<{ request: DispatchRequest }>(
			'POST',
			`/projects/${encodeURIComponent(project_id)}/dispatch/${encodeURIComponent(request_id)}/follow-up`,
			{ ...init, body }
		);
	},

	/** Cross-project File/Tackle fleet, optionally scoped to one issue. */
	missions(
		filters: { project_id?: string; issue_id?: string; limit?: number } = {},
		init?: RequestInitLike
	) {
		return request<{ missions: Mission[] }>('GET', '/missions', {
			...init,
			query: {
				project_id: filters.project_id,
				issue_id: filters.issue_id,
				limit: filters.limit
			}
		});
	},

	/** Admin todo list. */
	todos(
		filters: { status?: TodoStatus | 'all'; tag?: string; q?: string; limit?: number } = {},
		init?: RequestInitLike
	) {
		return request<{ todos: Todo[] }>('GET', '/todos', { ...init, query: filters });
	},

	createTodo(
		body: {
			title: string;
			priority?: number;
			due_at?: string | null;
			tags?: string[];
			body?: string | null;
		},
		init?: RequestInitLike
	) {
		return request<{ todo: Todo }>('POST', '/todos', { ...init, body });
	},

	updateTodo(
		id: string,
		body: {
			title?: string;
			priority?: number;
			due_at?: string | null;
			tags?: string[];
			status?: TodoStatus;
			sort_key?: number;
		},
		init?: RequestInitLike
	) {
		return request<{ todo: Todo }>('PATCH', `/todos/${encodeURIComponent(id)}`, {
			...init,
			body
		});
	},

	/** Saved searches of the list view (settings `todos.filters`). */
	todoFilters(init?: RequestInitLike) {
		return request<{ filters: Record<string, string> }>('GET', '/todos/filters', init);
	},

	saveTodoFilters(filters: Record<string, string>, init?: RequestInitLike) {
		return request<{ filters: Record<string, string> }>('PUT', '/todos/filters', {
			...init,
			body: { filters }
		});
	},

	/** Archives (never hard-deletes). */
	archiveTodo(id: string, init?: RequestInitLike) {
		return request<{ todo: Todo }>('DELETE', `/todos/${encodeURIComponent(id)}`, init);
	},

	todoComments(id: string, init?: RequestInitLike) {
		return request<{ todo: Todo; comments: TodoComment[] }>(
			'GET',
			`/todos/${encodeURIComponent(id)}/comments`,
			init
		);
	},

	/** Route a todo into a project through File dispatch. */
	routeTodo(id: string, body: { project_id: string; notes?: string }, init?: RequestInitLike) {
		return request<{ todo: Todo; request: DispatchRequest }>(
			'POST',
			`/todos/${encodeURIComponent(id)}/route`,
			{ ...init, body }
		);
	},

	/** The routed todo with its dispatch refreshed; `request` is null when unrouted. */
	todoRoute(id: string, init?: RequestInitLike) {
		return request<{ todo: Todo; request: DispatchRequest | null }>(
			'GET',
			`/todos/${encodeURIComponent(id)}/route`,
			init
		);
	},

	addTodoComment(id: string, text: string, init?: RequestInitLike) {
		return request<{ comment: TodoComment }>('POST', `/todos/${encodeURIComponent(id)}/comments`, {
			...init,
			body: { text }
		});
	},

	deleteTodoComment(id: string, comment_id: string, init?: RequestInitLike) {
		return request<{ deleted: true }>(
			'DELETE',
			`/todos/${encodeURIComponent(id)}/comments/${encodeURIComponent(comment_id)}`,
			init
		);
	}
};

/**
 * Reduce any thrown value to a message safe to show in a toast or banner.
 *
 * @param error - The caught value.
 */
export function errorMessage(error: unknown): string {
	if (error instanceof ApiError) {
		return error.message;
	}
	if (error instanceof Error) {
		return error.message;
	}
	return 'Something went wrong.';
}
