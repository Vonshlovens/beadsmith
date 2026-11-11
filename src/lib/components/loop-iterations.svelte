<script lang="ts">
	/**
	 * A ralph loop at a glance, above its mission thread (ADR-0019 rule 5):
	 * the flags it runs with, why it ended and whether a person should look,
	 * and one row per finished iteration. A restarted loop is a new run; its
	 * iterations get their own group so iteration 1 of each run stays apart.
	 * Numbers and a commit range only: the agent's words stay in the thread.
	 */
	import { tip } from '#lib/client/tooltip.js';
	import IssueId from '#lib/components/issue-id.svelte';
	import { formatElapsed } from '#lib/client/agent.js';
	import { absoluteStamp } from '#lib/client/format.js';
	import {
		commitRange,
		formatCost,
		ITERATION_OUTCOME_LABEL,
		loopFlagsLine,
		loopRuns,
		loopStopText,
		outcomeBadgeKey,
		totalCost,
		validateText
	} from '#lib/client/loop.js';
	import { compactCount } from '#lib/client/model-pool.js';
	import type { DispatchLoop, LoopIteration } from '#lib/types.js';

	interface Props {
		loop: DispatchLoop;
		iterations: LoopIteration[];
		/** The first read has landed (or failed). */
		loaded: boolean;
		/** The last read failed; rows already shown stay. */
		error?: string | null;
		/** The loop is running: the next iteration is in flight. */
		busy: boolean;
		onretry?: () => void;
	}

	let { loop, iterations, loaded, error = null, busy, onretry }: Props = $props();

	const runs = $derived(loopRuns(iterations));
	const cost = $derived(totalCost(runs));
	const stop = $derived(busy ? undefined : loopStopText(loop));
	const needs_person = $derived(!busy && loop.needs_person === true);
	const restarted = $derived(runs.length > 1);
	const next_iteration = $derived((runs.at(-1)?.iterations.at(-1)?.iteration ?? 0) + 1);

	function tokensTip(it: Pick<LoopIteration, 'input_tokens' | 'output_tokens'>): string {
		return `${it.input_tokens.toLocaleString('en-US')} in · ${it.output_tokens.toLocaleString('en-US')} out`;
	}
</script>

<section class="loop" aria-label="Loop iterations">
	<div class="lp-hd">
		<span class="lp-flags" {@attach tip('Mode · harness · model · effort · limits')}
			>{loopFlagsLine(loop)}</span
		>
		<span class="lp-scope">
			{#if loop.issue_id}<IssueId id={loop.issue_id} />{:else}whole plan{/if}
		</span>
		<span class="spacer"></span>
		<span class="lp-total mono-num">
			{iterations.length}
			{iterations.length === 1 ? 'iteration' : 'iterations'}
			{#if cost !== null}<span class="sep" aria-hidden="true">·</span><span
					{@attach tip('Total cost reported by the harness')}>{formatCost(cost)}</span
				>{/if}
		</span>
	</div>

	{#if stop || needs_person}
		<p class="lp-stop" role="status">
			{#if needs_person}
				<span
					class="badge badge-blocked"
					{@attach tip('ralph asks a person to look before this loop runs again')}
					><i class="dot dot-blocked" aria-hidden="true"></i>Needs a person</span
				>
			{/if}
			{#if stop}<span>{stop}</span>{/if}
		</p>
	{/if}

	{#if error}
		<p class="lp-err" role="alert">
			Iterations could not be loaded: {error}
			{#if onretry}<button class="btn btn-sm btn-ghost" type="button" onclick={onretry}
					>Retry</button
				>{/if}
		</p>
	{/if}

	{#if !loaded && iterations.length === 0}
		<p class="lp-note">Loading iterations…</p>
	{:else if iterations.length === 0}
		{#if busy}
			<p class="lp-note">
				<span class="chat-dots" aria-hidden="true"><i></i><i></i><i></i></span>Iteration 1 is
				running. Each row appears when its iteration finishes.
			</p>
		{:else if loaded && !error}
			<p class="lp-note">No iteration finished.</p>
		{/if}
	{:else}
		<!-- Focusable so a keyboard can scroll a long loop's rows. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div class="lp-scroll panel tbl-scroll" role="region" aria-label="Iterations" tabindex="0">
			<table class="tbl lp-tbl">
				<thead>
					<tr>
						<th scope="col" class="t-num">#</th>
						<th scope="col">Outcome</th>
						<th scope="col" class="t-num">Time</th>
						<th scope="col" class="t-num">Tokens</th>
						<th scope="col" class="t-num">Cost</th>
						<th scope="col">Commits</th>
						<th scope="col">Validate</th>
						<th scope="col" class="t-num" {@attach tip('Open plan items after the iteration')}
							>Open</th
						>
					</tr>
				</thead>
				{#each runs as run, index (run.run_id)}
					<tbody>
						{#if restarted}
							<tr class="lp-run">
								<th scope="rowgroup" colspan="8">
									Run {run.number}{index > 0 ? ' · restarted' : ''}
									<span class="faint mono-num"
										>· {run.iterations.length}
										{run.iterations.length === 1 ? 'iteration' : 'iterations'}
										{#if run.cost_usd !== null}· {formatCost(run.cost_usd)}{/if}</span
									>
								</th>
							</tr>
						{/if}
						{#each run.iterations as it (it.iteration)}
							{@const range = commitRange(it)}
							{@const validate = validateText(it.validate_ok)}
							<tr>
								<td class="t-num">{it.iteration}</td>
								<td>
									<span class="badge badge-{outcomeBadgeKey(it.outcome)}"
										><i class="dot dot-{outcomeBadgeKey(it.outcome)}" aria-hidden="true"
										></i>{ITERATION_OUTCOME_LABEL[it.outcome]}</span
									>
								</td>
								<td
									class="t-num"
									{@attach tip(
										`${absoluteStamp(it.started_at)} – ${absoluteStamp(it.finished_at)}`
									)}>{formatElapsed(it.duration_ms)}</td
								>
								<td class="t-num" {@attach tip(tokensTip(it))}
									>{compactCount(it.input_tokens + it.output_tokens)}</td
								>
								<td class="t-num">{formatCost(it.cost_usd)}</td>
								<td>
									{#if range === undefined}
										<span class="faint" {@attach tip('ralph recorded no commit range')}>—</span>
									{:else if range === 'no commits'}
										<span class="faint">no commits</span>
									{:else}
										<code class="lp-sha" {@attach tip(`${it.head_before} → ${it.head_after}`)}
											>{range}</code
										>
									{/if}
								</td>
								<td>
									{#if validate === undefined}
										<span class="faint" {@attach tip('No validation ran')}>—</span>
									{:else}
										<span class:lp-fail={validate === 'failed'}>{validate}</span>
									{/if}
								</td>
								<td class="t-num">
									{#if it.plan_open === null}<span class="faint" {@attach tip('No plan')}>—</span
										>{:else}{it.plan_open}{/if}
								</td>
							</tr>
						{/each}
						{#if busy && index === runs.length - 1}
							<tr class="lp-live">
								<td class="t-num">{next_iteration}</td>
								<td colspan="7">
									<span class="chat-dots" aria-hidden="true"><i></i><i></i><i></i></span>running
								</td>
							</tr>
						{/if}
					</tbody>
				{/each}
			</table>
		</div>
	{/if}
</section>

<style>
	.loop {
		display: flex;
		flex-direction: column;
		gap: var(--s-2);
		min-width: 0;
	}
	.lp-hd {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-1) var(--s-3);
		font-size: var(--t-xs);
		color: var(--tx-mid);
	}
	.lp-flags {
		color: var(--tx);
		overflow-wrap: anywhere;
	}
	.lp-scope {
		color: var(--tx-dim);
	}
	.spacer {
		flex: 1;
	}
	.lp-total {
		color: var(--tx-mid);
		white-space: nowrap;
	}
	.sep {
		margin: 0 6px;
		color: var(--tx-dim);
	}
	.lp-stop {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-2);
		margin: 0;
		font-size: var(--t-sm);
		color: var(--tx-hi);
	}
	.lp-err {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		margin: 0;
		font-size: var(--t-xs);
		color: var(--danger-tx);
	}
	.lp-note {
		margin: 0;
		font-size: var(--t-xs);
		color: var(--tx-dim);
	}
	.lp-scroll {
		/* The thread below keeps most of the height; long loops scroll here. */
		max-height: min(40vh, 360px);
		overflow-y: auto;
	}
	.lp-scroll:focus-visible {
		outline: 2px solid var(--em-500);
		outline-offset: 2px;
	}
	.lp-tbl {
		font-size: var(--t-xs);
	}
	.lp-tbl thead th {
		position: sticky;
		top: 0;
		z-index: 1;
		padding-top: var(--s-2);
		background: var(--s2);
	}
	.lp-tbl thead th.t-num {
		text-align: right;
	}
	.lp-tbl tbody td {
		height: 32px;
		white-space: nowrap;
	}
	.lp-run th {
		padding: var(--s-2) var(--s-3) var(--s-1);
		border-bottom: 1px solid var(--line-2);
		text-align: left;
		font-weight: 600;
		color: var(--tx-hi);
		background: var(--s1);
	}
	.lp-sha {
		font-size: var(--t-xs);
		color: var(--tx-mid);
	}
	.lp-fail {
		color: var(--danger-tx);
	}
	.lp-live td {
		color: var(--tx-dim);
	}
</style>
