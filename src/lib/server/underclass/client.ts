/**
 * Server-side reader for Underclass's admin API (ADR-0022 rule 4).
 *
 * Underclass pools the operator's model subscriptions. Its UI token unlocks
 * far more than this console needs (it can read the proxy key, remove
 * accounts and start onboarding), so this module is the one place that holds
 * it, and it only ever sends it to a fixed list of read routes on the
 * configured origin, plus four account actions. Nothing from the browser
 * reaches an Underclass URL except an account id, which must match
 * `UNDERCLASS_ACCOUNT_ID` and is path-encoded; every route and query below
 * is otherwise a constant.
 *
 * Upstream responses are parsed into the typed view in `#lib/types.js` and
 * everything else is dropped: request ids, sticky-session keys, raw account
 * ids in request logs, catalog entries. Account labels are the
 * subscriptions' email addresses: they pass to admins in the view, and never
 * into a log line or an error message.
 *
 * Failures reduce to the four classes the Dolt reader uses (ADR-0003), with
 * fixed messages, so no upstream text, URL or token path leaves the server.
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type {
	DoltFailureKind,
	ModelPoolAccount,
	ModelPoolAction,
	ModelPoolActionResponse,
	ModelPoolRefusal,
	ModelPoolCounters,
	ModelPoolRequest,
	ModelPoolSnapshot,
	ModelPoolWindow
} from '#lib/types.js';
import type { UnderclassSettings } from '../env.js';

const REQUEST_TIMEOUT_MS = 10_000;
/** Recent requests shown in the console; Underclass keeps more in memory. */
const RECENT_LIMIT = 20;

/**
 * The read routes Beadsmith may call. The only other calls are the account
 * actions in `UNDERCLASS_ACTIONS`. Never add `client-key`, `flows`, account
 * deletion, `relogin`, catalog writes or `events/import` (ADR-0022 rule 4).
 */
export const UNDERCLASS_READ_ROUTES = {
	monitor: '/admin/api/monitor',
	state: '/admin/api/state',
	/** Month to date (Underclass's default window), one row per model. */
	usage: '/admin/api/usage?group_by=model',
	/** The last day in hourly buckets: outcomes and upstream events. */
	stats: '/admin/api/stats?since=24h&bucket=hour'
} as const;

export type UnderclassRoute = keyof typeof UNDERCLASS_READ_ROUTES;

/** The account actions ADR-0022 rule 4 allows, in Underclass's route names. */
export const UNDERCLASS_ACTIONS: readonly ModelPoolAction[] = [
	'refresh',
	'enable',
	'disable',
	'reset'
] as const;

/**
 * An Underclass account id as the console accepts it. Underclass mints
 * UUID-like ids; this is looser than that but admits nothing that could
 * change the path (`/`, `..`, `?`, `%`).
 */
export const UNDERCLASS_ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * Underclass's refusal codes (`ui.rs` `refresh_account` and `reset_account`,
 * `resets.rs` and `claude.rs` error codes) mapped to the console's. Anything
 * else is not a refusal Beadsmith understands.
 */
const REFUSALS: Record<string, ModelPoolRefusal> = {
	not_refreshable: 'not_refreshable',
	refresh_failed: 'refresh_failed',
	not_rate_limited: 'not_rate_limited',
	already_redeemed: 'already_redeemed',
	no_credit: 'no_credit',
	not_codex: 'not_resettable',
	upstream_error: 'upstream_failed'
};

/** Refusals a forced reset may override (Underclass ADR 0020). */
const FORCEABLE: ReadonlySet<ModelPoolRefusal> = new Set(['not_rate_limited', 'already_redeemed']);

const account_status_schema = z.enum(['healthy', 'cooling', 'auth_error', 'disabled']);

/** The parts of a refresh or reset answer the console keeps; label and credit id are dropped. */
const action_result_schema = z.object({
	status: z.unknown().optional(),
	available_resets: z.number().int().nullish()
});

const refusal_schema = z.object({ error: z.string() });

/** An action on an account Underclass does not know (404). */
export class UnderclassAccountNotFound extends Error {
	constructor() {
		super('No such account in the model pool.');
		this.name = 'UnderclassAccountNotFound';
	}
}

/**
 * Fixed messages. They avoid the words password, token and secret, which
 * `errorBody` strips from any message line.
 */
const MESSAGES: Record<DoltFailureKind, string> = {
	credential_unavailable: 'Beadsmith could not load its Underclass credential.',
	authentication_rejected: 'Underclass did not accept the configured credential.',
	unreachable: 'Underclass could not be reached.',
	unknown: 'Underclass returned a response Beadsmith could not read.'
};

/** A sanitized Underclass failure: one of four classes, a fixed message. */
export class UnderclassError extends Error {
	readonly kind: DoltFailureKind;
	constructor(kind: DoltFailureKind) {
		super(MESSAGES[kind]);
		this.name = 'UnderclassError';
		this.kind = kind;
	}
}

// Upstream shapes, as Underclass serialises them. Unknown fields are dropped.
const int = z.number().int();
const nullable_number = z.number().nullish();

const counters_schema = z.object({
	attempts: int,
	unknown: int,
	input_tokens: int,
	output_tokens: int
});

const codex_window_schema = z
	.object({
		used_percent: z.number(),
		reset_at: nullable_number,
		limit_window_seconds: nullable_number
	})
	.nullish();

const codex_quota_schema = z
	.object({
		rate_limit: z
			.object({ primary_window: codex_window_schema, secondary_window: codex_window_schema })
			.nullish(),
		available_resets: int,
		fetched_at_ms: int
	})
	.nullish();

const claude_window_schema = z
	.object({ utilization: nullable_number, resets_at_ms: nullable_number })
	.nullish();

/** Claude accounts' quota, which Underclass polls from the account's usage API. */
const claude_observation_schema = z.object({
	five_hour: claude_window_schema,
	seven_day: claude_window_schema,
	seven_day_fable: claude_window_schema,
	reset_credits: nullable_number,
	observed_at_ms: int
});

const backend_schema = z.enum(['claude', 'codex', 'copilot']);

const monitor_schema = z.object({
	now_ms: int,
	month_start_ms: int,
	accounts: z.array(
		z.object({
			id: z.string(),
			label: z.string(),
			backend: backend_schema,
			plan: z.string().nullish(),
			status: z.enum(['healthy', 'cooling', 'auth_error', 'disabled']),
			reset_at: int,
			inflight: int,
			sticky_sessions: int,
			month: counters_schema,
			quota: codex_quota_schema,
			observation: z.unknown().optional()
		})
	),
	month: counters_schema,
	last_minute: counters_schema,
	minute_bins: z.array(int)
});

const state_schema = z.object({
	requests: z.array(
		z.object({
			ts: int,
			model: z.string(),
			backend: z.string().nullish(),
			label: z.string().nullish(),
			status: int,
			duration_ms: int,
			stream_outcome: z.string().nullish(),
			error_code: z.string().nullish()
		})
	)
});

const usage_schema = z.object({
	groups: z.array(
		z.object({
			model: z.string().nullish(),
			requests: int,
			unknown_requests: int,
			input_tokens: int,
			output_tokens: int
		})
	)
});

const totals_schema = z.object({
	requests: int,
	attempts: int,
	input_tokens: int,
	output_tokens: int,
	peak_concurrency: int,
	outcomes: z.record(z.string(), int).default({}),
	events: z.record(z.string(), int).default({})
});

const stats_schema = z.object({
	from_ms: int,
	to_ms: int,
	live_inflight: int,
	totals: totals_schema,
	buckets: z.array(z.object({ start_ms: int }).and(totals_schema))
});

type Monitor = z.infer<typeof monitor_schema>;

export type TokenReader = (path: string) => Promise<string>;

export interface UnderclassClientDeps {
	fetch?: typeof fetch;
	readToken?: TokenReader;
	timeout_ms?: number;
}

export interface UnderclassClient {
	/** The console's view of the pool, from all four read routes. */
	snapshot(): Promise<ModelPoolSnapshot>;
	/**
	 * Run one account action. Underclass's refusals come back as
	 * `outcome: 'refused'`; transport and credential failures throw
	 * `UnderclassError`, an unknown account `UnderclassAccountNotFound`.
	 * @param account_id Must match `UNDERCLASS_ACCOUNT_ID`.
	 * @param options.force Reset only: spend the credit despite an overridable refusal.
	 */
	act(
		account_id: string,
		action: ModelPoolAction,
		options?: { force?: boolean }
	): Promise<ModelPoolActionResponse>;
}

const readTokenFile: TokenReader = (path) => readFile(path, 'utf8');

function iso(ms: number | null | undefined): string | null {
	return ms === null || ms === undefined || ms <= 0 ? null : new Date(ms).toISOString();
}

function counters(raw: z.infer<typeof counters_schema>): ModelPoolCounters {
	return {
		attempts: raw.attempts,
		unmeasured: raw.unknown,
		input_tokens: raw.input_tokens,
		output_tokens: raw.output_tokens
	};
}

/**
 * Quota windows and banked resets, from whichever shape the backend reports:
 * Codex accounts carry a `quota` snapshot (percent used, reset in seconds),
 * Claude accounts an `observation` from their usage API (fraction used,
 * reset in milliseconds). Copilot reports neither.
 */
function quota(
	account: Monitor['accounts'][number]
): Pick<ModelPoolAccount, 'windows' | 'banked_resets' | 'quota_observed_at'> {
	if (account.quota) {
		const windows: ModelPoolWindow[] = [];
		const rate = account.quota.rate_limit;
		for (const [name, window] of [
			['primary', rate?.primary_window],
			['secondary', rate?.secondary_window]
		] as const) {
			if (!window) continue;
			windows.push({
				name,
				used_fraction: window.used_percent / 100,
				resets_at: iso(window.reset_at == null ? null : window.reset_at * 1000),
				window_seconds: window.limit_window_seconds ?? null
			});
		}
		return {
			windows,
			banked_resets: account.quota.available_resets,
			quota_observed_at: iso(account.quota.fetched_at_ms)
		};
	}
	const observation = claude_observation_schema.safeParse(account.observation);
	if (account.observation != null && observation.success) {
		const windows: ModelPoolWindow[] = [];
		for (const name of ['five_hour', 'seven_day', 'seven_day_fable'] as const) {
			const window = observation.data[name];
			if (!window || (window.utilization == null && window.resets_at_ms == null)) continue;
			windows.push({
				name,
				used_fraction: window.utilization ?? null,
				resets_at: iso(window.resets_at_ms),
				window_seconds: null
			});
		}
		return {
			windows,
			banked_resets: observation.data.reset_credits ?? null,
			quota_observed_at: iso(observation.data.observed_at_ms)
		};
	}
	return { windows: [], banked_resets: null, quota_observed_at: null };
}

/**
 * Map the four upstream payloads to the console view.
 * @param raw Parsed JSON bodies, keyed by route.
 * @throws UnderclassError `unknown` when a payload does not have the expected shape.
 */
export function toPoolSnapshot(raw: Record<UnderclassRoute, unknown>): ModelPoolSnapshot {
	const monitor = monitor_schema.safeParse(raw.monitor);
	const state = state_schema.safeParse(raw.state);
	const usage = usage_schema.safeParse(raw.usage);
	const stats = stats_schema.safeParse(raw.stats);
	if (!monitor.success || !state.success || !usage.success || !stats.success) {
		throw new UnderclassError('unknown');
	}
	const now = monitor.data.now_ms;
	const accounts: ModelPoolAccount[] = monitor.data.accounts.map((account) => ({
		id: account.id,
		label: account.label,
		backend: account.backend,
		plan: account.plan ?? null,
		status: account.status,
		cooling_until:
			account.status === 'cooling' && account.reset_at > now ? iso(account.reset_at) : null,
		in_flight: account.inflight,
		sticky_sessions: account.sticky_sessions,
		month: counters(account.month),
		...quota(account)
	}));
	const recent: ModelPoolRequest[] = state.data.requests.slice(0, RECENT_LIMIT).map((entry) => ({
		at: new Date(entry.ts).toISOString(),
		model: entry.model,
		backend: entry.backend ?? null,
		account_label: entry.label ?? null,
		status: entry.status,
		duration_ms: entry.duration_ms,
		outcome: entry.stream_outcome ?? null,
		error_code: entry.error_code ?? null
	}));
	const day = stats.data;
	return {
		observed_at: new Date(now).toISOString(),
		month_start: new Date(monitor.data.month_start_ms).toISOString(),
		accounts,
		in_flight: accounts.reduce((sum, account) => sum + account.in_flight, 0),
		month: counters(monitor.data.month),
		last_minute: counters(monitor.data.last_minute),
		minute_bins: monitor.data.minute_bins,
		month_by_model: usage.data.groups.map((group) => ({
			model: group.model ?? null,
			requests: group.requests,
			unmeasured: group.unknown_requests,
			input_tokens: group.input_tokens,
			output_tokens: group.output_tokens
		})),
		day: {
			from: new Date(day.from_ms).toISOString(),
			to: new Date(day.to_ms).toISOString(),
			requests: day.totals.requests,
			attempts: day.totals.attempts,
			input_tokens: day.totals.input_tokens,
			output_tokens: day.totals.output_tokens,
			peak_concurrency: day.totals.peak_concurrency,
			outcomes: day.totals.outcomes,
			events: day.totals.events,
			hours: day.buckets.map((bucket) => ({
				start: new Date(bucket.start_ms).toISOString(),
				requests: bucket.requests,
				attempts: bucket.attempts,
				input_tokens: bucket.input_tokens,
				output_tokens: bucket.output_tokens
			}))
		},
		recent
	};
}

/**
 * Map Underclass's answer to an account action. Its refusal messages can
 * carry upstream error text, so only the code is read.
 * @throws UnderclassError for credential, transport and unreadable answers.
 * @throws UnderclassAccountNotFound for a 404.
 */
export async function toActionResponse(
	response: Response,
	account_id: string,
	action: ModelPoolAction
): Promise<ModelPoolActionResponse> {
	if (response.status === 401 || response.status === 403) {
		throw new UnderclassError('authentication_rejected');
	}
	if (response.status === 404) {
		throw new UnderclassAccountNotFound();
	}
	if (response.status === 204) {
		return { outcome: 'done', action, account_id, status: null, banked_resets: null };
	}
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		body = undefined;
	}
	if (response.status === 200) {
		const result = action_result_schema.safeParse(body);
		if (!result.success) throw new UnderclassError('unknown');
		const status = account_status_schema.safeParse(result.data.status);
		return {
			outcome: 'done',
			action,
			account_id,
			status: status.success ? status.data : null,
			banked_resets: result.data.available_resets ?? null
		};
	}
	const refusal = refusal_schema.safeParse(body);
	const code = refusal.success ? REFUSALS[refusal.data.error] : undefined;
	if (code !== undefined && [400, 409, 502].includes(response.status)) {
		return {
			outcome: 'refused',
			action,
			account_id,
			refusal: code,
			can_force: action === 'reset' && FORCEABLE.has(code)
		};
	}
	if (response.status === 502 || response.status === 503 || response.status === 504) {
		throw new UnderclassError('unreachable');
	}
	throw new UnderclassError('unknown');
}

/** Strip one trailing line ending, as the Dolt password reader does. */
function tokenFromFile(contents: string): string {
	return contents.replace(/\r?\n$/, '');
}

/**
 * Create a client for one Underclass origin.
 * @param settings Origin and token file from `readEnv` (never the token itself).
 * @param deps Injectable fetch, token reader and timeout for tests.
 */
export function createUnderclassClient(
	settings: UnderclassSettings,
	deps: UnderclassClientDeps = {}
): UnderclassClient {
	const fetch_impl = deps.fetch ?? fetch;
	const read_token = deps.readToken ?? readTokenFile;
	const timeout_ms = deps.timeout_ms ?? REQUEST_TIMEOUT_MS;

	async function token(): Promise<string> {
		let value: string;
		try {
			value = tokenFromFile(await read_token(settings.ui_token_file));
		} catch {
			throw new UnderclassError('credential_unavailable');
		}
		// A header value cannot carry control characters; an empty token is no token.
		if (value.length === 0 || [...value].some((char) => char < ' ' || char === '\x7f')) {
			throw new UnderclassError('credential_unavailable');
		}
		return value;
	}

	async function get(route: UnderclassRoute, bearer: string): Promise<unknown> {
		let response: Response;
		try {
			response = await fetch_impl(`${settings.origin}${UNDERCLASS_READ_ROUTES[route]}`, {
				method: 'GET',
				headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' },
				// A redirect would carry the token to wherever Underclass points; refuse it.
				redirect: 'manual',
				signal: AbortSignal.timeout(timeout_ms)
			});
		} catch {
			throw new UnderclassError('unreachable');
		}
		if (response.status === 401 || response.status === 403) {
			throw new UnderclassError('authentication_rejected');
		}
		if (response.status === 502 || response.status === 503 || response.status === 504) {
			throw new UnderclassError('unreachable');
		}
		if (response.status !== 200) {
			throw new UnderclassError('unknown');
		}
		try {
			return await response.json();
		} catch {
			throw new UnderclassError('unknown');
		}
	}

	return {
		async act(account_id, action, options = {}) {
			// The route validates too; this keeps the client safe on its own.
			if (!UNDERCLASS_ACCOUNT_ID.test(account_id) || !UNDERCLASS_ACTIONS.includes(action)) {
				throw new UnderclassAccountNotFound();
			}
			const bearer = await token();
			const force = action === 'reset' && options.force === true ? '?force=true' : '';
			let response: Response;
			try {
				response = await fetch_impl(
					`${settings.origin}/admin/api/accounts/${encodeURIComponent(account_id)}/${action}${force}`,
					{
						method: 'POST',
						headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' },
						redirect: 'manual',
						signal: AbortSignal.timeout(timeout_ms)
					}
				);
			} catch {
				throw new UnderclassError('unreachable');
			}
			return toActionResponse(response, account_id, action);
		},
		async snapshot() {
			const bearer = await token();
			const routes = Object.keys(UNDERCLASS_READ_ROUTES) as UnderclassRoute[];
			const bodies = await Promise.all(routes.map((route) => get(route, bearer)));
			return toPoolSnapshot(
				Object.fromEntries(routes.map((route, i) => [route, bodies[i]])) as Record<
					UnderclassRoute,
					unknown
				>
			);
		}
	};
}

let client_override: UnderclassClient | undefined;

/** Replace the client the console routes use (tests only). */
export function setUnderclassClient(client: UnderclassClient | undefined): void {
	client_override = client;
}

/**
 * The client for the configured origin. Built per call: it holds no
 * connection and re-reads the token file each time, so a rotated token
 * takes effect without a restart.
 * @param settings Underclass settings from `getEnv()`.
 */
export function getUnderclassClient(settings: UnderclassSettings): UnderclassClient {
	return client_override ?? createUnderclassClient(settings);
}
