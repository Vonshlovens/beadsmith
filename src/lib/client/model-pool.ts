/**
 * Presentation helpers for the console's model pool page
 * (`/console/model-pool`, ADR-0022). The page answers "can the pool take
 * work, and which account is the limit?", so these helpers turn the
 * snapshot into words first and colours second: an account's state is a
 * sentence with a badge class beside it, a quota window is a label, a
 * share and a reset time, and an unreported value stays distinct from zero
 * (docs/design-standards.md §2).
 *
 * Kept free of Svelte so every state the page can show is tested from the
 * same fixtures the Underclass client is tested with.
 */
import type {
	DoltFailureKind,
	ModelPoolAccount,
	ModelPoolResponse,
	ModelPoolSnapshot,
	ModelPoolWindow,
	UnderclassConfigError
} from '#lib/types.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How often the open page re-reads the pool while it is visible. */
export const MODEL_POOL_POLL_MS = 15_000;

/**
 * Everything the page can be showing, decided in one place so the template
 * is a switch over it rather than a tangle of null checks.
 *
 * - `loading`: the first read has not answered yet.
 * - `off`: neither Underclass setting is present; the pool is not in use.
 * - `misconfigured`: one setting is present or the URL is unusable.
 * - `failed`: Underclass could not be read and nothing was read before.
 * - `empty`: Underclass answered with no accounts.
 * - `ready`: accounts to show.
 *
 * A failure after a good read stays `ready` with `stale` set, so the last
 * snapshot stays on screen marked as old instead of vanishing (§7: never
 * present a failed read as an empty dataset, retain content on refresh).
 */
export type ModelPoolView =
	| { kind: 'loading' }
	| { kind: 'off' }
	| { kind: 'misconfigured'; config_error: UnderclassConfigError }
	| { kind: 'failed'; failure: PoolFailure }
	| { kind: 'empty'; pool: ModelPoolSnapshot; stale: PoolFailure | null }
	| { kind: 'ready'; pool: ModelPoolSnapshot; stale: PoolFailure | null };

export interface PoolFailure {
	/** One of the four fixed classes, or undefined for a non-upstream error (403, network). */
	failure_kind?: DoltFailureKind;
	message: string;
}

/**
 * Decide the view from the latest response, the latest failure, and the
 * last good snapshot.
 *
 * @param response - The latest successful response, if any.
 * @param failure - The latest failed read, cleared by a later success.
 * @param last_pool - The last snapshot shown, kept across a failed refresh.
 */
export function poolView(
	response: ModelPoolResponse | null,
	failure: PoolFailure | null,
	last_pool: ModelPoolSnapshot | null
): ModelPoolView {
	if (failure) {
		if (last_pool) {
			return last_pool.accounts.length === 0
				? { kind: 'empty', pool: last_pool, stale: failure }
				: { kind: 'ready', pool: last_pool, stale: failure };
		}
		return { kind: 'failed', failure };
	}
	if (!response) {
		return { kind: 'loading' };
	}
	if (!response.configured) {
		return response.config_error === undefined
			? { kind: 'off' }
			: { kind: 'misconfigured', config_error: response.config_error };
	}
	return response.pool.accounts.length === 0
		? { kind: 'empty', pool: response.pool, stale: null }
		: { kind: 'ready', pool: response.pool, stale: null };
}

const FAILURE_KINDS: readonly DoltFailureKind[] = [
	'credential_unavailable',
	'authentication_rejected',
	'unreachable',
	'unknown'
];

/**
 * A thrown read failure as the page keeps it: the fixed failure class when
 * the server named one (an `ApiError` from `#lib/client/api.js`), and the
 * server's already-scrubbed message.
 */
export function toFailure(thrown: unknown): PoolFailure {
	const message = thrown instanceof Error ? thrown.message : 'Something went wrong.';
	const kind =
		thrown !== null && typeof thrown === 'object' && 'failure_kind' in thrown
			? (thrown as { failure_kind?: unknown }).failure_kind
			: undefined;
	return FAILURE_KINDS.includes(kind as DoltFailureKind)
		? { failure_kind: kind as DoltFailureKind, message }
		: { message };
}

/** What to fix, per configuration problem. Names settings, never values. */
export const CONFIG_ERROR_COPY: Record<UnderclassConfigError, string> = {
	url_missing: 'BDX_UNDERCLASS_UI_TOKEN_FILE is set but BDX_UNDERCLASS_URL is not. Set both.',
	token_file_missing:
		'BDX_UNDERCLASS_URL is set but BDX_UNDERCLASS_UI_TOKEN_FILE is not. Set both.',
	url_invalid:
		'BDX_UNDERCLASS_URL must be an https origin with no path (plain http only on loopback).'
};

/** What failed and what to check, per failure class. */
export const FAILURE_COPY: Record<DoltFailureKind, { title: string; recovery: string }> = {
	credential_unavailable: {
		title: 'Beadsmith could not read its Underclass token file.',
		recovery: 'Check that BDX_UNDERCLASS_UI_TOKEN_FILE exists and the service can read it.'
	},
	authentication_rejected: {
		title: 'Underclass rejected the configured token.',
		recovery: 'Check the token file holds the current Underclass UI token.'
	},
	unreachable: {
		title: 'Underclass could not be reached.',
		recovery: 'Check that Underclass is running and its admin API answers at BDX_UNDERCLASS_URL.'
	},
	unknown: {
		title: 'Underclass answered with something Beadsmith could not read.',
		recovery: 'Check that the Underclass version matches the one Beadsmith expects.'
	}
};

/** Heading and recovery copy for a failure, with a generic fallback. */
export function failureCopy(failure: PoolFailure): { title: string; recovery: string } {
	return failure.failure_kind === undefined
		? { title: 'The model pool could not be loaded.', recovery: failure.message }
		: FAILURE_COPY[failure.failure_kind];
}

export interface AccountState {
	/** The state in words, shown in the badge. */
	word: string;
	/** A `.badge-*` modifier from app.css. */
	badge: 'open' | 'in_progress' | 'blocked' | 'closed';
	/** The consequence, shown beside the badge; null when there is nothing to add. */
	detail: string | null;
	/** Whether the account is taking requests now. */
	in_rotation: boolean;
}

/**
 * An account's state in words. Cooling says when it returns; a sign-in
 * failure says what fixes it, since it will not recover by waiting.
 *
 * @param account - The pooled account.
 * @param now - Reference time.
 */
export function accountState(account: ModelPoolAccount, now: number): AccountState {
	switch (account.status) {
		case 'healthy':
			return { word: 'healthy', badge: 'open', detail: null, in_rotation: true };
		case 'cooling':
			return {
				word: 'cooling',
				badge: 'in_progress',
				detail: account.cooling_until
					? `back ${untilPhrase(account.cooling_until, now)}`
					: 'back when Underclass next checks',
				in_rotation: false
			};
		case 'auth_error':
			return {
				word: 'sign-in failed',
				badge: 'blocked',
				detail: 'sign in again in Underclass',
				in_rotation: false
			};
		case 'disabled':
			return {
				word: 'disabled',
				badge: 'closed',
				detail: 'turned off in Underclass',
				in_rotation: false
			};
	}
}

/** The backend and plan as one short line under the account's label. */
export function accountKind(account: ModelPoolAccount): string {
	const backend = { claude: 'Claude', codex: 'Codex', copilot: 'Copilot' }[account.backend];
	return account.plan ? `${backend} · ${account.plan}` : backend;
}

/** Accounts in rotation, of all accounts. */
export function rotationCount(accounts: ModelPoolAccount[], now: number): number {
	return accounts.filter((account) => accountState(account, now).in_rotation).length;
}

/**
 * A quota window's short name. Codex reports `primary`/`secondary` with a
 * length, so name those by their length when it is known.
 *
 * @param window - The quota window.
 */
export function windowName(window: ModelPoolWindow): string {
	switch (window.name) {
		case 'five_hour':
			return '5h';
		case 'seven_day':
			return '7d';
		case 'seven_day_fable':
			return '7d Fable';
		default:
			return window.window_seconds ? durationShort(window.window_seconds * 1000) : window.name;
	}
}

export type MeterLevel = 'low' | 'high' | 'full' | 'unknown';

/**
 * How full a window is: `full` at the limit, `high` from 80 %, `unknown`
 * when Underclass did not report a share (shown as a dash, never as 0 %).
 */
export function meterLevel(window: ModelPoolWindow): MeterLevel {
	if (window.used_fraction === null) return 'unknown';
	if (window.used_fraction >= 1) return 'full';
	if (window.used_fraction >= 0.8) return 'high';
	return 'low';
}

/** Share used as a whole percent; a dash when unreported. */
export function usedPercent(window: ModelPoolWindow): string {
	return window.used_fraction === null ? '—' : `${Math.round(window.used_fraction * 100)}%`;
}

/** Meter fill width, clamped to the track. */
export function meterWidth(window: ModelPoolWindow): number {
	return window.used_fraction === null ? 0 : Math.min(100, Math.max(0, window.used_fraction * 100));
}

/** `resets in 30m`, `reset time not reported`. */
export function resetPhrase(window: ModelPoolWindow, now: number): string {
	return window.resets_at
		? `resets ${untilPhrase(window.resets_at, now)}`
		: 'reset time not reported';
}

/** `5h`, `30m`, `3d`, `2d 4h`: a compact duration, rounded to its smallest unit. */
export function durationShort(ms: number): string {
	if (ms < MINUTE) return `${Math.max(0, Math.round(ms / 1000))}s`;
	const minutes = Math.round(ms / MINUTE);
	if (minutes < 60) return `${minutes}m`;
	if (ms < DAY) {
		const hours = Math.floor(minutes / 60);
		const rest = minutes % 60;
		return rest === 0 || hours >= 6 ? `${Math.round(ms / HOUR)}h` : `${hours}h ${rest}m`;
	}
	const hours = Math.round(ms / HOUR);
	const days = Math.floor(hours / 24);
	return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}

/** `in 30m`, or `now` once the time has passed. */
export function untilPhrase(iso: string, now: number): string {
	const at = Date.parse(iso);
	if (Number.isNaN(at)) return 'at an unknown time';
	const delta = at - now;
	return delta <= 0 ? 'now' : `in ${durationShort(delta)}`;
}

/**
 * A count for a dense row: exact below ten thousand, then `54k`, `1.2M`.
 * Exact values stay available in the row's tooltip.
 */
export function compactCount(n: number): string {
	if (n < 10_000) return n.toLocaleString('en-US');
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	return `${Math.round(n / 1_000_000)}M`;
}

/** `900 ms`, `1.4 s`, `2m 5s`. */
export function durationMs(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)} ms`;
	if (ms < MINUTE) return `${(ms / 1000).toFixed(1)} s`;
	const minutes = Math.floor(ms / MINUTE);
	return `${minutes}m ${Math.round((ms - minutes * MINUTE) / 1000)}s`;
}

/** A clock time for a row stamp in the viewer's zone: `14:05:09`. */
export function clockTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return '—';
	return date.toLocaleTimeString(undefined, {
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false
	});
}

/** An hour bucket's start as `14:00` in the viewer's zone. */
export function hourLabel(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return '—';
	return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** Whether an upstream attempt failed, for the recent-requests row treatment. */
export function requestFailed(entry: { status: number; outcome: string | null }): boolean {
	return entry.status >= 400 || (entry.outcome !== null && entry.outcome !== 'completed');
}

/**
 * A request row's result in words: the HTTP status, plus the stream
 * outcome or error code when they add something.
 */
export function requestResult(entry: {
	status: number;
	outcome: string | null;
	error_code: string | null;
}): string {
	const parts = [String(entry.status)];
	if (entry.error_code) parts.push(entry.error_code.replaceAll('_', ' '));
	else if (entry.outcome && entry.outcome !== 'completed')
		parts.push(entry.outcome.replaceAll('_', ' '));
	return parts.join(' · ');
}

/**
 * A `Record<string, number>` of outcomes or events as rows, largest first,
 * with names made readable (`http_429` stays a code; underscores become
 * spaces elsewhere).
 */
export function tallyRows(tally: Record<string, number>): { name: string; count: number }[] {
	return Object.entries(tally)
		.filter(([, count]) => count > 0)
		.map(([name, count]) => ({
			name: /^http_\d+$/.test(name) ? name.replace('_', ' ') : name.replaceAll('_', ' '),
			count
		}))
		.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export interface HourBar {
	start: string;
	label: string;
	requests: number;
	/** Bar height as a share of the busiest hour, 0 to 1. */
	share: number;
}

/**
 * The last day's hourly buckets as bars, scaled to the busiest hour.
 * Underclass reports every bucket in the window, empty ones included, so
 * each bar is a measured value and a zero is a real zero.
 *
 * @param day - The snapshot's last-day stats.
 */
export function hourBars(day: ModelPoolSnapshot['day']): HourBar[] {
	const peak = Math.max(0, ...day.hours.map((hour) => hour.requests));
	return day.hours.map((hour) => ({
		start: hour.start,
		label: hourLabel(hour.start),
		requests: hour.requests,
		share: peak === 0 ? 0 : hour.requests / peak
	}));
}
