import { describe, expect, it } from 'vitest';
import { toPoolSnapshot } from '#lib/server/underclass/client.js';
import {
	monitorFixture,
	NOW_MS,
	stateFixture,
	statsFixture,
	usageFixture
} from '#lib/server/underclass/fixtures.js';
import type { ModelPoolAccount, ModelPoolSnapshot, ModelPoolWindow } from '#lib/types.js';
import {
	accountKind,
	accountState,
	compactCount,
	CONFIG_ERROR_COPY,
	durationMs,
	durationShort,
	failureCopy,
	hourBars,
	meterLevel,
	meterWidth,
	poolView,
	requestFailed,
	requestResult,
	resetPhrase,
	rotationCount,
	tallyRows,
	toFailure,
	usedPercent,
	windowName
} from './model-pool.js';

/** The page's data, built the way the server builds it from Underclass payloads. */
function snapshot(): ModelPoolSnapshot {
	return toPoolSnapshot({
		monitor: monitorFixture(),
		state: stateFixture(),
		usage: usageFixture(),
		stats: statsFixture()
	});
}

function account(patch: Partial<ModelPoolAccount>): ModelPoolAccount {
	return { ...snapshot().accounts[1], ...patch };
}

function window(patch: Partial<ModelPoolWindow>): ModelPoolWindow {
	return { name: 'five_hour', used_fraction: 0.5, resets_at: null, window_seconds: null, ...patch };
}

describe('poolView', () => {
	const pool = snapshot();
	const unreachable = { failure_kind: 'unreachable' as const, message: 'x' };

	it('is loading before the first answer', () => {
		expect(poolView(null, null, null)).toEqual({ kind: 'loading' });
	});

	it('is off when Underclass is not configured', () => {
		expect(poolView({ configured: false }, null, null)).toEqual({ kind: 'off' });
	});

	it('names the configuration problem when only one setting is present', () => {
		expect(poolView({ configured: false, config_error: 'url_missing' }, null, null)).toEqual({
			kind: 'misconfigured',
			config_error: 'url_missing'
		});
	});

	it('shows accounts from the fixtures', () => {
		const view = poolView({ configured: true, pool }, null, null);
		expect(view.kind).toBe('ready');
		expect(view.kind === 'ready' && view.pool.accounts).toHaveLength(2);
		expect(view.kind === 'ready' && view.stale).toBeNull();
	});

	it('distinguishes an empty pool from a failed read', () => {
		const empty = { ...pool, accounts: [] };
		expect(poolView({ configured: true, pool: empty }, null, null).kind).toBe('empty');
		expect(poolView(null, unreachable, null)).toEqual({ kind: 'failed', failure: unreachable });
	});

	it('keeps the last snapshot on screen, marked stale, when a refresh fails', () => {
		expect(poolView({ configured: true, pool }, unreachable, pool)).toEqual({
			kind: 'ready',
			pool,
			stale: unreachable
		});
		const empty = { ...pool, accounts: [] };
		expect(poolView(null, unreachable, empty)).toEqual({
			kind: 'empty',
			pool: empty,
			stale: unreachable
		});
	});
});

describe('failure and configuration copy', () => {
	it('has a recovery for every failure class and configuration error', () => {
		for (const kind of [
			'credential_unavailable',
			'authentication_rejected',
			'unreachable',
			'unknown'
		] as const) {
			const copy = failureCopy({ failure_kind: kind, message: 'ignored' });
			expect(copy.title).not.toBe('');
			expect(copy.recovery).not.toBe('');
		}
		expect(Object.keys(CONFIG_ERROR_COPY).sort()).toEqual(
			['token_file_missing', 'url_invalid', 'url_missing'].sort()
		);
	});

	it('keeps the failure class from a thrown API error', () => {
		const thrown = Object.assign(new Error('Underclass could not be reached.'), {
			failure_kind: 'unreachable'
		});
		expect(toFailure(thrown)).toEqual({
			failure_kind: 'unreachable',
			message: 'Underclass could not be reached.'
		});
		expect(toFailure(new Error('offline'))).toEqual({ message: 'offline' });
		expect(toFailure(Object.assign(new Error('x'), { failure_kind: 'bogus' }))).toEqual({
			message: 'x'
		});
	});

	it('falls back to the server message for a non-upstream failure', () => {
		expect(failureCopy({ message: 'The console is for admins.' })).toEqual({
			title: 'The model pool could not be loaded.',
			recovery: 'The console is for admins.'
		});
	});
});

describe('accountState', () => {
	it('says when a cooling account returns', () => {
		const [claude] = snapshot().accounts;
		expect(accountState(claude, NOW_MS)).toEqual({
			word: 'cooling',
			badge: 'in_progress',
			detail: 'back in 30m',
			in_rotation: false
		});
	});

	it('covers every status in words', () => {
		expect(accountState(account({ status: 'healthy' }), NOW_MS).word).toBe('healthy');
		expect(accountState(account({ status: 'auth_error' }), NOW_MS)).toMatchObject({
			word: 'sign-in failed',
			badge: 'blocked',
			detail: 'sign in again in Underclass'
		});
		expect(accountState(account({ status: 'disabled' }), NOW_MS).badge).toBe('closed');
		expect(accountState(account({ status: 'cooling', cooling_until: null }), NOW_MS).detail).toBe(
			'back when Underclass next checks'
		);
	});

	it('counts accounts in rotation', () => {
		expect(rotationCount(snapshot().accounts, NOW_MS)).toBe(1);
	});

	it('names backend and plan', () => {
		const [claude, codex] = snapshot().accounts;
		expect(accountKind(claude)).toBe('Claude · max');
		expect(accountKind(codex)).toBe('Codex · pro');
		expect(accountKind(account({ backend: 'copilot', plan: null }))).toBe('Copilot');
	});
});

describe('quota windows', () => {
	it('labels Claude windows and Codex windows by their length', () => {
		const [claude, codex] = snapshot().accounts;
		expect(claude.windows.map(windowName)).toEqual(['5h', '7d']);
		expect(codex.windows.map(windowName)).toEqual(['5h']);
		expect(windowName(window({ name: 'secondary', window_seconds: null }))).toBe('secondary');
	});

	it('marks levels and keeps an unreported share distinct from zero', () => {
		const [claude, codex] = snapshot().accounts;
		expect(meterLevel(claude.windows[0])).toBe('full');
		expect(meterLevel(codex.windows[0])).toBe('low');
		expect(meterLevel(window({ used_fraction: 0.85 }))).toBe('high');
		const unreported = window({ used_fraction: null });
		expect(meterLevel(unreported)).toBe('unknown');
		expect(usedPercent(unreported)).toBe('—');
		expect(usedPercent(window({ used_fraction: 0 }))).toBe('0%');
	});

	it('clamps the meter to its track', () => {
		expect(meterWidth(window({ used_fraction: 1.3 }))).toBe(100);
		expect(meterWidth(window({ used_fraction: 0.25 }))).toBe(25);
	});

	it('says when a window resets', () => {
		const [claude] = snapshot().accounts;
		expect(resetPhrase(claude.windows[0], NOW_MS)).toBe('resets in 30m');
		expect(resetPhrase(claude.windows[1], NOW_MS)).toBe('resets in 3d');
		expect(resetPhrase(window({ resets_at: null }), NOW_MS)).toBe('reset time not reported');
	});
});

describe('formatting', () => {
	it('formats durations and counts compactly', () => {
		expect(durationShort(30 * 60_000)).toBe('30m');
		expect(durationShort(90 * 60_000)).toBe('1h 30m');
		expect(durationShort(26 * 3_600_000)).toBe('1d 2h');
		// Rounding up to a whole unit carries over instead of printing 60m or 24h.
		expect(durationShort(2 * 3_600_000 - 10_000)).toBe('2h');
		expect(durationShort(3 * 86_400_000 - 60_000)).toBe('3d');
		expect(durationShort(59 * 60_000 + 50_000)).toBe('1h');
		expect(compactCount(9_800)).toBe('9,800');
		expect(compactCount(54_000)).toBe('54k');
		expect(compactCount(1_250_000)).toBe('1.3M');
		expect(durationMs(900)).toBe('900 ms');
		expect(durationMs(1_400)).toBe('1.4 s');
	});

	it('describes recent requests, failures included', () => {
		const [ok, saturated] = snapshot().recent;
		expect(requestFailed(ok)).toBe(false);
		expect(requestResult(ok)).toBe('200');
		expect(requestFailed(saturated)).toBe(true);
		expect(requestResult(saturated)).toBe('503 · pool saturated');
		expect(requestResult({ status: 200, outcome: 'failed', error_code: null })).toBe(
			'200 · failed'
		);
	});

	it('orders outcomes and events largest first', () => {
		expect(tallyRows(snapshot().day.outcomes)).toEqual([
			{ name: 'completed', count: 40 },
			{ name: 'http 429', count: 1 }
		]);
		expect(tallyRows({ none: 0 })).toEqual([]);
	});
});

describe('hourBars', () => {
	it('scales each reported hour to the busiest one', () => {
		const bars = hourBars(snapshot().day);
		expect(bars.map((bar) => bar.requests)).toEqual([15, 25]);
		expect(bars[1].share).toBe(1);
		expect(bars[0].share).toBeCloseTo(0.6);
	});

	it('draws a quiet day as flat, not as missing', () => {
		const day = snapshot().day;
		const quiet = { ...day, hours: day.hours.map((hour) => ({ ...hour, requests: 0 })) };
		expect(hourBars(quiet).every((bar) => bar.share === 0)).toBe(true);
	});
});
