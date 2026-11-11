<script lang="ts">
	/**
	 * The Underclass model pool (ADR-0022): which subscriptions are serving
	 * agent work, how close each is to its quota, and what the pool has done
	 * lately. Read-only; account actions belong to Underclass until the
	 * console grows them. Re-reads every 15 s while the tab is visible and
	 * keeps the last good read on screen, marked stale, if a refresh fails.
	 */
	import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeftIcon';
	import EmptyState from '#lib/components/empty-state.svelte';
	import SkeletonRows from '#lib/components/skeleton-rows.svelte';
	import { api } from '#lib/client/api.js';
	import { tip } from '#lib/client/tooltip.js';
	import { relativeLong } from '#lib/client/format.js';
	import {
		accountKind,
		accountState,
		clockTime,
		compactCount,
		CONFIG_ERROR_COPY,
		durationMs,
		failureCopy,
		hourBars,
		meterLevel,
		meterWidth,
		MODEL_POOL_POLL_MS,
		poolView,
		requestFailed,
		requestResult,
		resetPhrase,
		rotationCount,
		tallyRows,
		toFailure,
		usedPercent,
		windowName,
		type PoolFailure
	} from '#lib/client/model-pool.js';
	import { PRODUCT_NAME } from '#lib/product.js';
	import type { ModelPoolResponse, ModelPoolSnapshot } from '#lib/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/** The latest read once this page has made one; until then, the load's. */
	let latest = $state<{ response: ModelPoolResponse | null; failure: PoolFailure | null } | null>(
		null
	);
	/** The last good snapshot read on this page, kept across a failed refresh. */
	let kept = $state<ModelPoolSnapshot | null>(null);
	let reading = $state(false);
	let manual = $state(false);
	let now = $state(Date.now());
	/** The hour the chart readout describes; null shows the busiest hour. */
	let active_hour = $state<number | null>(null);

	const current = $derived(latest ?? { response: data.response, failure: data.failure });
	const last_pool = $derived(
		kept ?? (data.response?.configured === true ? data.response.pool : null)
	);
	const view = $derived(poolView(current.response, current.failure, last_pool));
	const pool = $derived(view.kind === 'ready' || view.kind === 'empty' ? view.pool : null);
	const stale = $derived(view.kind === 'ready' || view.kind === 'empty' ? view.stale : null);
	/** Settings are read at server start, so polling an unconfigured pool cannot change anything. */
	const polling = $derived(view.kind !== 'off' && view.kind !== 'misconfigured');

	const bars = $derived(pool ? hourBars(pool.day) : []);
	const busiest = $derived(
		bars.length === 0
			? null
			: bars.reduce((best, bar, index) => (bar.requests > bars[best].requests ? index : best), 0)
	);
	const shown_hour = $derived(active_hour ?? busiest);

	async function read(by_hand = false): Promise<void> {
		if (reading) return;
		reading = true;
		manual = by_hand;
		try {
			const response = await api.modelPool();
			latest = { response, failure: null };
			if (response.configured) kept = response.pool;
		} catch (thrown) {
			latest = { response: current.response, failure: toFailure(thrown) };
		} finally {
			now = Date.now();
			reading = false;
			manual = false;
		}
	}

	$effect(() => {
		if (!polling) return;
		const tick = () => {
			if (document.visibilityState === 'visible') void read();
		};
		const timer = setInterval(tick, MODEL_POOL_POLL_MS);
		document.addEventListener('visibilitychange', tick);
		return () => {
			clearInterval(timer);
			document.removeEventListener('visibilitychange', tick);
		};
	});

	function chartKey(event: KeyboardEvent): void {
		if (bars.length === 0) return;
		const at = shown_hour ?? 0;
		const next =
			event.key === 'ArrowLeft'
				? Math.max(0, at - 1)
				: event.key === 'ArrowRight'
					? Math.min(bars.length - 1, at + 1)
					: event.key === 'Home'
						? 0
						: event.key === 'End'
							? bars.length - 1
							: null;
		if (next === null) return;
		event.preventDefault();
		active_hour = next;
	}

	/** Hover picks the hour under the pointer; the whole slot is the target, not just the bar. */
	function chartPointer(event: PointerEvent): void {
		if (bars.length === 0) return;
		const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
		if (box.width <= 0) return;
		const index = Math.floor(((event.clientX - box.left) / box.width) * bars.length);
		active_hour = Math.min(bars.length - 1, Math.max(0, index));
	}

	function plural(n: number, one: string, many = `${one}s`): string {
		return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
	}

	/** Chart geometry, in viewBox units: one 10-wide slot per hour with a 2-unit gap. */
	const SLOT = 10;
	const GAP = 2;
	const CHART_H = 64;
</script>

<svelte:head><title>Model pool · Console · {PRODUCT_NAME}</title></svelte:head>

<div class="wrap">
	<nav class="crumbs" aria-label="Breadcrumb">
		<a href="/console"><ArrowLeftIcon size={12} weight="bold" aria-hidden="true" />Console</a>
	</nav>
	<div class="page-hd">
		<h1 class="h1">Model pool</h1>
		<div class="meta" aria-live="polite">
			{#if pool}
				Underclass · read {relativeLong(pool.observed_at, now)}{polling
					? ' · refreshes every 15 s'
					: ''}
			{:else if view.kind === 'off'}
				not connected
			{/if}
		</div>
		{#if polling}
			<div class="acts">
				<button class="btn" type="button" disabled={reading} onclick={() => read(true)}>
					{reading && manual ? 'Refreshing…' : 'Refresh'}
				</button>
			</div>
		{/if}
	</div>

	{#if view.kind === 'loading'}
		<SkeletonRows rows={3} label="Reading the model pool" />
	{:else if view.kind === 'off'}
		<EmptyState
			title="The model pool is not connected"
			description="Set BDX_UNDERCLASS_URL and BDX_UNDERCLASS_UI_TOKEN_FILE, then restart Beadsmith, to see the Underclass accounts that serve agent work. docs/model-pool.md explains both."
		/>
	{:else if view.kind === 'misconfigured'}
		<div class="banner banner-warn" role="status">
			<i class="dot dot-in_progress" style="margin-top:5px" aria-hidden="true"></i>
			<div class="banner-bd">
				<b>The Underclass settings are incomplete.</b>
				<div class="mt-2">{CONFIG_ERROR_COPY[view.config_error]} Then restart Beadsmith.</div>
			</div>
		</div>
	{:else if view.kind === 'failed'}
		{@const copy = failureCopy(view.failure)}
		<div class="banner banner-err" role="alert">
			<i class="dot dot-blocked" style="margin-top:5px" aria-hidden="true"></i>
			<div class="banner-bd">
				<b>{copy.title}</b>
				<div class="mt-2">{copy.recovery}</div>
			</div>
			<div class="banner-acts">
				<button class="btn btn-sm" type="button" disabled={reading} onclick={() => read(true)}>
					{reading ? 'Retrying…' : 'Retry now'}
				</button>
			</div>
		</div>
	{:else if pool}
		{#if stale}
			{@const copy = failureCopy(stale)}
			<div class="banner banner-warn mb-5" role="status">
				<i class="dot dot-in_progress" style="margin-top:5px" aria-hidden="true"></i>
				<div class="banner-bd">
					<b>Showing the pool as it was {relativeLong(pool.observed_at, now)}.</b>
					<div class="mt-2">{copy.title} {copy.recovery}</div>
				</div>
				<div class="banner-acts">
					<button class="btn btn-sm" type="button" disabled={reading} onclick={() => read(true)}>
						{reading ? 'Retrying…' : 'Retry now'}
					</button>
				</div>
			</div>
		{/if}

		<dl class="summary" class:is-stale={stale}>
			<div>
				<dt>In rotation</dt>
				<dd>
					<b>{rotationCount(pool.accounts, now)}</b> of {plural(pool.accounts.length, 'account')}
				</dd>
			</div>
			<div>
				<dt>In flight</dt>
				<dd><b>{pool.in_flight}</b> {pool.in_flight === 1 ? 'request' : 'requests'}</dd>
			</div>
			<div>
				<dt>Last minute</dt>
				<dd>
					<b>{pool.last_minute.attempts}</b>
					{pool.last_minute.attempts === 1 ? 'attempt' : 'attempts'}
				</dd>
			</div>
			<div>
				<dt>Last 24 hours</dt>
				<dd>
					<b>{compactCount(pool.day.requests)}</b>
					{pool.day.requests === 1 ? 'request' : 'requests'} · peak {pool.day.peak_concurrency} at once
				</dd>
			</div>
			<div>
				<dt>Month to date</dt>
				<dd
					{@attach tip(
						`${pool.month.input_tokens.toLocaleString('en-US')} input and ${pool.month.output_tokens.toLocaleString('en-US')} output tokens`
					)}
				>
					<b>{compactCount(pool.month.attempts)}</b> attempts · {compactCount(
						pool.month.input_tokens
					)} in / {compactCount(pool.month.output_tokens)} out
				</dd>
			</div>
		</dl>

		<section class="sec" aria-labelledby="pool-accounts">
			<div class="sec-hd">
				<h2 class="lbl" id="pool-accounts">Accounts</h2>
				<span class="rule"></span>
			</div>
			{#if pool.accounts.length === 0}
				<EmptyState
					title="No accounts in the pool"
					description="Add a subscription in Underclass. It appears here on the next refresh."
				/>
			{:else}
				<div class="panel tbl-scroll" role="region" aria-labelledby="pool-accounts" tabindex="-1">
					<table class="tbl accounts">
						<thead>
							<tr>
								<th scope="col">Account</th>
								<th scope="col">State</th>
								<th scope="col">Quota</th>
								<th scope="col" class="num">In flight</th>
								<th scope="col" class="num">Sessions</th>
								<th scope="col" class="num">Month</th>
								<th scope="col" class="num">Tokens in / out</th>
								<th scope="col" class="num">Banked</th>
							</tr>
						</thead>
						<tbody>
							{#each pool.accounts as account (account.id)}
								{@const state = accountState(account, now)}
								<tr class:is-out={!state.in_rotation}>
									<td class="who">
										<div class="label">{account.label}</div>
										<div class="kind">{accountKind(account)}</div>
									</td>
									<td class="state">
										<span class="badge badge-{state.badge}">
											<i class="dot dot-{state.badge}" aria-hidden="true"></i>{state.word}
										</span>
										{#if state.detail}<div class="detail">{state.detail}</div>{/if}
									</td>
									<td class="quota">
										{#if account.windows.length === 0}
											<span class="faint">not reported</span>
										{:else}
											<ul class="windows">
												{#each account.windows as window (window.name)}
													{@const level = meterLevel(window)}
													<li>
														<span class="w-name">{windowName(window)}</span>
														<span
															class="meter meter-{level}"
															role="meter"
															aria-label="{windowName(window)} window used"
															aria-valuemin={0}
															aria-valuemax={100}
															aria-valuenow={window.used_fraction === null
																? undefined
																: Math.round(window.used_fraction * 100)}
															aria-valuetext={window.used_fraction === null
																? 'not reported'
																: usedPercent(window)}
														>
															<span class="fill" style="width:{meterWidth(window)}%"></span>
														</span>
														<span class="w-pct">{usedPercent(window)}</span>
														<span class="w-reset">{resetPhrase(window, now)}</span>
													</li>
												{/each}
											</ul>
											{#if account.quota_observed_at}
												<div class="observed">
													checked {relativeLong(account.quota_observed_at, now)}
												</div>
											{/if}
										{/if}
									</td>
									<td class="num" data-label="In flight">{account.in_flight}</td>
									<td class="num" data-label="Sessions">{account.sticky_sessions}</td>
									<td
										class="num"
										data-label="Month"
										{@attach tip(
											account.month.unmeasured > 0
												? `${account.month.attempts.toLocaleString('en-US')} attempts, ${account.month.unmeasured} without reported usage`
												: undefined
										)}
									>
										{compactCount(account.month.attempts)}
									</td>
									<td class="num" data-label="Tokens in / out">
										{compactCount(account.month.input_tokens)} / {compactCount(
											account.month.output_tokens
										)}
									</td>
									<td class="num" data-label="Banked resets">
										{#if account.banked_resets === null}
											<span class="faint">—</span>
										{:else}
											{account.banked_resets}
										{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				<p class="note">
					Sessions are conversations pinned to an account so its prompt cache stays warm. Banked
					resets are rate-limit resets the subscription can spend; a dash means the backend does not
					report them.
				</p>
			{/if}
		</section>

		<section class="sec" aria-labelledby="pool-day">
			<div class="sec-hd">
				<h2 class="lbl" id="pool-day">Last 24 hours</h2>
				<span class="rule"></span>
				<span class="meta"
					>{plural(pool.day.attempts, 'attempt')} for {plural(pool.day.requests, 'request')}</span
				>
			</div>
			<div class="day">
				<figure class="chart">
					<figcaption class="chart-cap">Requests per hour</figcaption>
					{#if bars.length > 0 && shown_hour !== null}
						{@const bar = bars[shown_hour]}
						<p class="readout">
							{#if busiest !== null && bars[busiest].requests === 0}
								No requests in the last 24 hours.
							{:else}
								<b>{bar.label}</b>
								{plural(bar.requests, 'request')}{#if active_hour === null}<span class="faint"
										>{' · busiest hour'}</span
									>{/if}
							{/if}
						</p>
						<div
							class="plot"
							role="slider"
							aria-label="Requests per hour, last 24 hours"
							aria-valuemin={0}
							aria-valuemax={bars.length - 1}
							aria-valuenow={shown_hour}
							aria-valuetext="{bar.label}, {plural(bar.requests, 'request')}"
							tabindex="0"
							onkeydown={chartKey}
							onpointermove={chartPointer}
							onpointerleave={() => (active_hour = null)}
							onblur={() => (active_hour = null)}
						>
							<svg
								viewBox="0 0 {bars.length * SLOT} {CHART_H}"
								preserveAspectRatio="none"
								aria-hidden="true"
							>
								{#each bars as hour, index (hour.start)}
									{@const h = hour.requests === 0 ? 0 : Math.max(2, hour.share * (CHART_H - 2))}
									<rect
										class="bar"
										class:is-active={index === shown_hour}
										x={index * SLOT + GAP / 2}
										y={CHART_H - h}
										width={SLOT - GAP}
										height={h}
										rx="1.5"
									/>
								{/each}
								<line class="base" x1="0" x2={bars.length * SLOT} y1={CHART_H} y2={CHART_H} />
							</svg>
						</div>
						<div class="axis" aria-hidden="true">
							<span>{bars[0].label}</span><span>now</span>
						</div>
						<details class="as-table">
							<summary>Show as a table</summary>
							<table class="tbl">
								<thead>
									<tr
										><th scope="col">Hour starting</th><th scope="col" class="num">Requests</th></tr
									>
								</thead>
								<tbody>
									{#each bars as hour (hour.start)}
										<tr><td>{hour.label}</td><td class="num">{hour.requests}</td></tr>
									{/each}
								</tbody>
							</table>
						</details>
					{:else}
						<p class="note">Underclass reported no hourly figures for this window.</p>
					{/if}
				</figure>
				<div class="tallies">
					<div>
						<h3 class="tally-hd">Outcomes</h3>
						{#if tallyRows(pool.day.outcomes).length === 0}
							<p class="note">No requests finished in this window.</p>
						{:else}
							<dl class="tally">
								{#each tallyRows(pool.day.outcomes) as row (row.name)}
									<dt>{row.name}</dt>
									<dd>{row.count.toLocaleString('en-US')}</dd>
								{/each}
							</dl>
						{/if}
					</div>
					<div>
						<h3 class="tally-hd">Upstream events</h3>
						{#if tallyRows(pool.day.events).length === 0}
							<p class="note">No overloads, rate limits or sign-in failures.</p>
						{:else}
							<dl class="tally">
								{#each tallyRows(pool.day.events) as row (row.name)}
									<dt>{row.name}</dt>
									<dd>{row.count.toLocaleString('en-US')}</dd>
								{/each}
							</dl>
						{/if}
					</div>
				</div>
			</div>
		</section>

		<section class="sec" aria-labelledby="pool-models">
			<div class="sec-hd">
				<h2 class="lbl" id="pool-models">By model, month to date</h2>
				<span class="rule"></span>
			</div>
			{#if pool.month_by_model.length === 0}
				<p class="note">No requests this month.</p>
			{:else}
				<div class="panel tbl-scroll" role="region" aria-labelledby="pool-models" tabindex="-1">
					<table class="tbl models">
						<thead>
							<tr>
								<th scope="col">Model</th>
								<th scope="col" class="num">Requests</th>
								<th scope="col" class="num">Without usage</th>
								<th scope="col" class="num">Input tokens</th>
								<th scope="col" class="num">Output tokens</th>
							</tr>
						</thead>
						<tbody>
							{#each pool.month_by_model as row, index (row.model ?? `unknown-${index}`)}
								<tr>
									<td
										>{#if row.model}{row.model}{:else}<span class="faint">unknown model</span
											>{/if}</td
									>
									<td class="num">{row.requests.toLocaleString('en-US')}</td>
									<td class="num">{row.unmeasured.toLocaleString('en-US')}</td>
									<td class="num">{row.input_tokens.toLocaleString('en-US')}</td>
									<td class="num">{row.output_tokens.toLocaleString('en-US')}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>

		<section class="sec" aria-labelledby="pool-recent">
			<div class="sec-hd">
				<h2 class="lbl" id="pool-recent">Recent attempts</h2>
				<span class="rule"></span>
				<span class="meta">newest first</span>
			</div>
			{#if pool.recent.length === 0}
				<p class="note">No attempts since Underclass started.</p>
			{:else}
				<div class="panel tbl-scroll" role="region" aria-labelledby="pool-recent" tabindex="-1">
					<table class="tbl recent">
						<thead>
							<tr>
								<th scope="col">Time</th>
								<th scope="col">Model</th>
								<th scope="col">Account</th>
								<th scope="col">Result</th>
								<th scope="col" class="num">Duration</th>
							</tr>
						</thead>
						<tbody>
							{#each pool.recent as entry, index (`${entry.at}-${index}`)}
								<tr>
									<td class="mono-num">{clockTime(entry.at)}</td>
									<td>{entry.model}</td>
									<td>
										{#if entry.account_label}{entry.account_label}{:else}<span class="faint"
												>no account assigned</span
											>{/if}
									</td>
									<td class:failed={requestFailed(entry)}>{requestResult(entry)}</td>
									<td class="num">{durationMs(entry.duration_ms)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>
	{/if}
</div>

<style>
	.crumbs {
		margin-bottom: var(--s-2);
		font-size: var(--t-xs);
	}
	.crumbs a {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		color: var(--tx-dim);
	}
	.crumbs a:hover {
		color: var(--tx-hi);
	}
	.page-hd {
		display: flex;
		align-items: flex-end;
		gap: var(--s-4);
		flex-wrap: wrap;
		margin-bottom: var(--s-5);
	}
	.page-hd .meta {
		font-size: var(--t-xs);
		color: var(--tx-dim);
		padding-bottom: 4px;
		font-variant-numeric: tabular-nums;
	}
	.page-hd .acts {
		margin-left: auto;
	}

	/* The pool at a glance: five figures read as one line of text, not a row of
	   cards. Wraps to a column on narrow screens. */
	.summary {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-3) var(--s-6);
		margin: 0 0 var(--s-6);
		font-size: var(--t-sm);
		color: var(--tx-mid);
		font-variant-numeric: tabular-nums;
	}
	.summary dt {
		font-size: var(--t-xs);
		color: var(--tx-dim);
		margin-bottom: 2px;
	}
	.summary dd {
		margin: 0;
	}
	.summary b {
		color: var(--tx-hi);
		font-weight: 600;
		font-size: var(--t-md);
	}
	.summary.is-stale b {
		color: var(--tx-mid);
	}

	.sec-hd h2.lbl {
		margin: 0;
		font-size: inherit;
	}
	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.tbl thead th.num {
		text-align: right;
	}
	.note {
		margin: var(--s-3) 0 0;
		font-size: var(--t-xs);
		color: var(--tx-dim);
		max-width: 70ch;
	}

	/* Accounts: one dense row each. The label is the identifying field, so
	   it never truncates; the table scrolls sideways instead. */
	.accounts {
		min-width: 900px;
	}
	.accounts tbody td {
		height: auto;
		padding-top: var(--s-3);
		padding-bottom: var(--s-3);
		vertical-align: top;
	}
	/* The label is the identifying field: it wraps at any character rather
	   than truncating, so a long address stays whole. */
	.who {
		min-width: 22ch;
	}
	.who .label {
		color: var(--tx-hi);
		overflow-wrap: anywhere;
	}
	.who .kind,
	.state .detail,
	.observed {
		margin-top: 4px;
		font-size: var(--t-xs);
		color: var(--tx-dim);
	}
	.state .badge {
		gap: 6px;
	}
	/* Out of rotation reads quieter, but stays legible and keeps its state word. */
	tr.is-out .who .label {
		color: var(--tx-mid);
	}

	.windows {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: 8ch 96px 4ch auto;
		gap: 6px var(--s-2);
		align-items: center;
		font-size: var(--t-xs);
	}
	.windows li {
		display: contents;
	}
	.w-name {
		color: var(--tx-mid);
		white-space: nowrap;
	}
	.w-pct {
		text-align: right;
		color: var(--tx-hi);
		font-variant-numeric: tabular-nums;
	}
	.w-reset {
		color: var(--tx-dim);
		white-space: nowrap;
	}
	.meter {
		position: relative;
		display: block;
		height: 6px;
		border-radius: var(--r-1);
		background: var(--s4);
		overflow: hidden;
	}
	.meter .fill {
		position: absolute;
		inset: 0 auto 0 0;
		border-radius: var(--r-1);
		background: var(--tx-faint);
	}
	.meter-high .fill {
		background: var(--amber);
	}
	.meter-full .fill {
		background: var(--danger);
	}
	.meter-full + .w-pct {
		color: var(--danger-tx);
		font-weight: 600;
	}
	.meter-unknown {
		background: transparent;
		box-shadow: inset 0 0 0 1px var(--line-2);
	}

	/* Last 24 hours: the chart takes the width, the tallies sit beside it and
	   drop below on narrow screens. */
	.day {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(200px, 260px);
		gap: var(--s-6);
		align-items: start;
	}
	.chart {
		margin: 0;
	}
	.chart-cap {
		font-size: var(--t-xs);
		color: var(--tx-dim);
	}
	.readout {
		margin: 2px 0 var(--s-2);
		font-size: var(--t-sm);
		color: var(--tx-mid);
		font-variant-numeric: tabular-nums;
		min-height: 1.5em;
	}
	.readout b {
		color: var(--tx-hi);
		font-weight: 600;
	}
	.plot {
		border-radius: var(--r-1);
		outline-offset: 4px;
	}
	.plot:focus-visible {
		outline: 2px solid var(--ring);
	}
	.plot svg {
		display: block;
		width: 100%;
		height: 96px;
	}
	.bar {
		fill: var(--cyan);
		opacity: 0.55;
		transition: opacity 120ms ease-out;
	}
	.bar.is-active {
		opacity: 1;
	}
	.base {
		stroke: var(--line-2);
		stroke-width: 1;
		vector-effect: non-scaling-stroke;
	}
	.axis {
		display: flex;
		justify-content: space-between;
		margin-top: 4px;
		font-size: var(--t-micro);
		color: var(--tx-dim);
		font-variant-numeric: tabular-nums;
	}
	.as-table {
		margin-top: var(--s-3);
		font-size: var(--t-xs);
	}
	.as-table summary {
		cursor: pointer;
		color: var(--tx-dim);
		width: fit-content;
	}
	.as-table summary:hover {
		color: var(--tx-hi);
	}
	.as-table .tbl {
		max-width: 320px;
		margin-top: var(--s-2);
	}
	.tallies {
		display: grid;
		gap: var(--s-5);
	}
	.tally-hd {
		margin: 0 0 var(--s-2);
		font-size: var(--t-xs);
		font-weight: 500;
		color: var(--tx-dim);
	}
	.tally {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 4px var(--s-4);
		margin: 0;
		font-size: var(--t-sm);
	}
	.tally dt {
		color: var(--tx);
	}
	.tally dd {
		margin: 0;
		text-align: right;
		color: var(--tx-hi);
		font-variant-numeric: tabular-nums;
	}

	.models {
		min-width: 620px;
	}
	.recent {
		min-width: 720px;
	}
	.recent td {
		white-space: nowrap;
	}
	.recent td.failed {
		color: var(--danger-tx);
		font-weight: 500;
	}

	/* Narrow screens: each account becomes a stacked block so its state and
	   quota stay in view instead of behind a sideways scroll; the counts
	   carry their column name with them. */
	@media (max-width: 760px) {
		.day {
			grid-template-columns: minmax(0, 1fr);
		}
		.summary {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.accounts {
			min-width: 0;
		}
		.accounts thead {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip-path: inset(50%);
		}
		.accounts tbody tr {
			display: flex;
			flex-wrap: wrap;
			column-gap: var(--s-5);
			padding: var(--s-3) var(--s-4);
			border-bottom: 1px solid var(--line);
		}
		.accounts tbody td {
			display: block;
			border: 0;
			padding: 0 0 var(--s-2);
		}
		.accounts tbody td.who,
		.accounts tbody td.quota {
			width: 100%;
		}
		.accounts tbody td.state {
			width: 100%;
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			gap: var(--s-2);
		}
		.accounts tbody td.state .detail {
			margin: 0;
		}
		.accounts tbody td.num {
			text-align: left;
		}
		.accounts tbody td.num::before {
			content: attr(data-label);
			display: block;
			font-size: var(--t-xs);
			color: var(--tx-dim);
		}
		.accounts tbody tr:hover td {
			background: none;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.bar {
			transition: none;
		}
	}
</style>
