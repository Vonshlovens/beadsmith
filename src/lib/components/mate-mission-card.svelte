<script lang="ts">
	/**
	 * A mission First Mate started from this chat, shown under the message it
	 * was started from (ADR-0020 rule 6: a launch is visible). It says what
	 * runs (operation, issue, project), how it is doing, and where to follow
	 * it: the mission's thread, its pull request, and Stop while the runner
	 * can cancel it. Status changes arrive by polling and crew notices; the
	 * transcript's live region announces them.
	 *
	 * Once the run ends the card says what it produced: the pull request as
	 * the main action, else the start of the run's summary or its error, cut
	 * to a few lines (the thread has the full text). Same status words and
	 * badge as the thread and the Missions page (mission-status.svelte).
	 */
	import { tip } from '#lib/client/tooltip.js';
	import ArrowRightIcon from 'phosphor-svelte/lib/ArrowRightIcon';
	import GitPullRequestIcon from 'phosphor-svelte/lib/GitPullRequestIcon';
	import SquareIcon from 'phosphor-svelte/lib/SquareIcon';
	import IssueId from '#lib/components/issue-id.svelte';
	import MissionStatus from '#lib/components/mission-status.svelte';
	import {
		formatElapsed,
		isBusyStatus,
		isFollowedMission,
		missionCardState,
		missionVerb
	} from '#lib/client/agent.js';
	import { threadHref } from '#lib/client/first-mate.js';
	import { absoluteStamp, relativeShort } from '#lib/client/format.js';
	import { statusSnapshot } from '#lib/client/projects.svelte.js';
	import type { Mission } from '#lib/types.js';

	interface Props {
		mission: Mission;
		cancelling?: boolean;
		cancel_error?: string;
		oncancel: () => void;
	}

	let { mission, cancelling = false, cancel_error, oncancel }: Props = $props();

	// As the thread's Stop: only while the launching runner can cancel this run.
	const dispatch = $derived(statusSnapshot()?.dispatch ?? null);
	const card = $derived(missionCardState(mission, dispatch));
	const busy = $derived(card.busy);
	const can_cancel = $derived(card.can_cancel);
	const pr_url = $derived(card.pr_url);
	const verb = $derived(missionVerb(mission));
	const ended = $derived(!isBusyStatus(mission.status));
	const needs_person = $derived(ended && mission.loop?.needs_person === true);
	/** The outcome in words, when there is no pull request to point at. */
	const outcome = $derived(
		!ended || pr_url
			? undefined
			: mission.status === 'failed'
				? mission.error_message
				: mission.result_summary?.trim() || undefined
	);
</script>

<article
	class="mcard"
	class:is-busy={busy}
	class:is-failed={mission.status === 'failed'}
	aria-label="{verb} mission{mission.issue_id ? ` on ${mission.issue_id}` : ''}"
>
	<div class="mc-top">
		<span class="mc-verb">{verb}</span>
		<MissionStatus status={mission.status} live={isFollowedMission(mission, dispatch)} />
		{#if needs_person}
			<span
				class="badge badge-blocked"
				{@attach tip('ralph asks a person to look before this loop runs again')}
				><i class="dot dot-blocked" aria-hidden="true"></i>Needs a person</span
			>
		{/if}
		{#if mission.duration_ms !== undefined && !busy}
			<span class="mc-dim mono-num" {@attach tip('Run time')}
				>{formatElapsed(mission.duration_ms)}</span
			>
		{/if}
	</div>
	<p class="mc-what">
		{#if mission.issue_id}<IssueId id={mission.issue_id} />{/if}
		{#if mission.title}<span class="mc-title">{mission.title}</span>{/if}
	</p>
	<p class="mc-meta">
		<a class="mc-proj" href="/p/{encodeURIComponent(mission.project_id)}">{mission.project_name}</a>
		<span aria-hidden="true">·</span>
		<span>started</span>
		<time datetime={mission.created_at} {@attach tip(absoluteStamp(mission.created_at))}
			>{relativeShort(mission.created_at)}</time
		>
	</p>
	{#if outcome}
		<p class="mc-out" class:mc-err={mission.status === 'failed'}>{outcome}</p>
	{/if}
	<div class="mc-actions">
		{#if pr_url}
			<a class="btn btn-sm mc-pr" href={pr_url} target="_blank" rel="noopener noreferrer"
				><GitPullRequestIcon size={13} aria-hidden="true" />Pull request</a
			>
		{/if}
		<a class="btn btn-sm btn-ghost" href={threadHref(mission)}
			>Open thread <ArrowRightIcon size={12} aria-hidden="true" /></a
		>
		{#if can_cancel}
			<button
				class="btn btn-sm btn-ghost mc-stop"
				type="button"
				disabled={cancelling}
				onclick={oncancel}
				{@attach tip('Stop this mission’s run')}
			>
				<SquareIcon size={12} aria-hidden="true" />{cancelling ? 'Stopping…' : 'Stop'}
			</button>
		{/if}
	</div>
	{#if cancel_error}
		<p class="mc-err" role="alert">{cancel_error}</p>
	{/if}
</article>

<style>
	.mcard {
		display: grid;
		gap: 4px;
		max-width: 60ch;
		padding: var(--s-2) var(--s-3);
		border: 1px solid var(--line);
		border-radius: var(--r-2);
		background: var(--bg);
		font-size: var(--t-sm);
	}
	.mcard.is-busy {
		border-color: var(--line-3);
	}
	.mcard.is-failed {
		border-color: var(--danger-line);
	}
	.mc-top {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-2);
	}
	.mc-verb {
		font-weight: 600;
		color: var(--tx-hi);
	}
	.mc-dim {
		font-size: var(--t-xs);
		color: var(--tx-dim);
	}
	.mc-what {
		display: flex;
		align-items: baseline;
		gap: var(--s-2);
		min-width: 0;
		margin: 0;
		color: var(--tx-hi);
	}
	.mc-title {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.mc-meta {
		display: flex;
		flex-wrap: wrap;
		gap: 0 6px;
		margin: 0;
		font-size: var(--t-xs);
		color: var(--tx-dim);
		font-variant-numeric: tabular-nums;
	}
	.mc-proj {
		color: var(--tx-mid);
		text-decoration: none;
	}
	.mc-proj:hover,
	.mc-proj:focus-visible {
		color: var(--tx-hi);
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	/* A few lines of the outcome; Open thread has the rest. */
	.mc-out {
		display: -webkit-box;
		margin: 0;
		overflow: hidden;
		font-size: var(--t-xs);
		color: var(--tx-mid);
		white-space: pre-line;
		overflow-wrap: anywhere;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 3;
		line-clamp: 3;
	}
	.mc-err {
		margin: 0;
		font-size: var(--t-xs);
		color: var(--danger-tx);
		overflow-wrap: anywhere;
	}
	.mc-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 2px;
		margin: 2px 0 0 -8px;
	}
	/* A pull request is the run's product: the filled button leads, flush. */
	.mc-actions:has(.mc-pr) {
		gap: var(--s-1);
		margin-left: 0;
	}
	.mc-actions .btn {
		gap: 5px;
	}
	.mc-stop {
		color: var(--danger-tx);
	}
	@media (pointer: coarse) {
		.mc-actions .btn {
			min-height: 44px;
		}
	}
</style>
