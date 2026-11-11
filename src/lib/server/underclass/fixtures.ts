/**
 * Admin API payloads in the shapes Underclass serialises them (its
 * `monitor.rs`, `ui.rs` `state`/`usage_summary` and `stats_api.rs`), with
 * the fields Beadsmith must drop (request ids, sticky keys, raw account ids
 * in logs, the catalog) left in so tests prove they never pass through.
 */
export const NOW_MS = Date.UTC(2026, 10, 11, 14, 0, 0);
const MONTH_START_MS = Date.UTC(2026, 10, 1);
const HOUR_MS = 3_600_000;

export const CLAUDE_EMAIL = 'pool-one@example.com';
export const CODEX_EMAIL = 'pool-two@example.com';
export const STICKY_KEY = 'sticky-cache-key-should-not-appear';

export function monitorFixture() {
	return {
		now_ms: NOW_MS,
		month_start_ms: MONTH_START_MS,
		accounts: [
			{
				id: 'acct-claude',
				label: CLAUDE_EMAIL,
				backend: 'claude',
				plan: 'max',
				status: 'cooling',
				reset_at: NOW_MS + 30 * 60_000,
				inflight: 2,
				sticky_sessions: 3,
				month: { attempts: 120, unknown: 1, input_tokens: 50_000, output_tokens: 9_000 },
				quota: null,
				observation: {
					plan: 'max',
					five_hour: { utilization: 1.0, resets_at_ms: NOW_MS + 30 * 60_000 },
					seven_day: { utilization: 0.42, resets_at_ms: NOW_MS + 3 * 24 * HOUR_MS },
					seven_day_fable: { utilization: null, resets_at_ms: null },
					reset_credits: 2,
					observed_at_ms: NOW_MS - 60_000
				}
			},
			{
				id: 'acct-codex',
				label: CODEX_EMAIL,
				backend: 'codex',
				plan: 'pro',
				status: 'healthy',
				reset_at: 0,
				inflight: 1,
				sticky_sessions: 0,
				month: { attempts: 10, unknown: 0, input_tokens: 4_000, output_tokens: 800 },
				quota: {
					rate_limit: {
						allowed: true,
						limit_reached: false,
						primary_window: {
							used_percent: 25,
							reset_at: Math.floor((NOW_MS + HOUR_MS) / 1000),
							limit_window_seconds: 18_000
						},
						secondary_window: null
					},
					available_resets: 1,
					credit_expirations: [null],
					fetched_at_ms: NOW_MS - 120_000
				},
				observation: null
			}
		],
		month: { attempts: 130, unknown: 1, input_tokens: 54_000, output_tokens: 9_800 },
		last_minute: { attempts: 3, unknown: 0, input_tokens: 900, output_tokens: 100 },
		minute_bins: [0, 1, 2, 3],
		recent: [
			{
				ts: NOW_MS - 1_000,
				model: 'claude-opus',
				backend: 'claude',
				label: CLAUDE_EMAIL,
				status: 200,
				duration_ms: 900
			}
		]
	};
}

export function stateFixture() {
	return {
		accounts: [],
		requests: [
			{
				ts: NOW_MS - 1_000,
				request_id: 'req-should-not-appear',
				model: 'claude-opus',
				backend: 'claude',
				account: 'acct-claude',
				label: CLAUDE_EMAIL,
				sticky: STICKY_KEY,
				status: 200,
				duration_ms: 900,
				stream_outcome: 'completed',
				error_code: null
			},
			{
				ts: NOW_MS - 5_000,
				request_id: 'req-2',
				model: 'gpt-5',
				backend: null,
				account: null,
				label: null,
				sticky: 'none',
				status: 503,
				duration_ms: 12,
				stream_outcome: null,
				error_code: 'pool_saturated'
			}
		],
		catalog: { claude: [{ id: 'catalog-entry-should-not-appear' }] },
		now_ms: NOW_MS
	};
}

export function usageFixture() {
	return {
		groups: [
			{
				model: 'claude-opus',
				account_id: null,
				account_label: null,
				cache_key: null,
				requests: 120,
				measured_requests: 119,
				unknown_requests: 1,
				input_tokens: 50_000,
				output_tokens: 9_000
			}
		],
		totals: {
			model: null,
			account_id: null,
			account_label: null,
			cache_key: null,
			requests: 130,
			measured_requests: 129,
			unknown_requests: 1,
			input_tokens: 54_000,
			output_tokens: 9_800
		},
		from_ms: MONTH_START_MS,
		to_ms: null
	};
}

function totals(requests: number) {
	return {
		requests,
		attempts: requests + 1,
		sessions: 2,
		input_tokens: requests * 100,
		output_tokens: requests * 10,
		unmeasured: 0,
		peak_concurrency: 3,
		mean_concurrency_milli: 1200,
		outcomes: { completed: requests, http_429: 1 },
		events: { overloaded: 1 }
	};
}

export function statsFixture() {
	const from_ms = NOW_MS - 24 * HOUR_MS;
	return {
		from_ms,
		to_ms: NOW_MS,
		bucket: 'hour',
		bucket_ms: HOUR_MS,
		by: 'total',
		retention_days: 400,
		live_inflight: 3,
		totals: totals(40),
		buckets: [
			{ start_ms: from_ms, ...totals(15) },
			{ start_ms: from_ms + HOUR_MS, ...totals(25) }
		],
		series: []
	};
}
