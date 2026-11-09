<script lang="ts">
	/**
	 * A mission First Mate started from this chat, shown under the message it
	 * was started from (ADR-0020 rule 6: a launch is visible). It says what
	 * runs (operation, issue, project), how it is doing, and where to follow
	 * it: the mission's thread, its pull request, and Stop while the runner
	 * can cancel it. Status changes arrive by polling and crew notices; the
	 * transcript's live region announces them.
	 */
	import { tip } from '#lib/client/tooltip.js';
	import ArrowRightIcon from 'phosphor-svelte/lib/ArrowRightIcon';
	import GitPullRequestIcon from 'phosphor-svelte/lib/GitPullRequestIcon';
	import SquareIcon from 'phosphor-svelte/lib/SquareIcon';
	import IssueId from '#lib/components/issue-id.svelte';
	import MissionStatus from '#lib/components/mission-status.svelte';
	import { formatElapsed, missionCardState, missionVerb } from '#lib/client/agent.js';
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
	const card = $derived(missionCardState(mission, statusSnapshot()?.dispatch ?? null));
	const busy = $derived(card.busy);
	const can_cancel = $derived(card.can_cancel);
	const pr_url = $derived(card.pr_url);
	const verb = $derived(missionVerb(mission));
</script>

<article class="mcard" class:is-busy={busy} aria-label="{verb} mission">
	<div class="mc-top">
		<span class="mc-verb">{verb}</span>
		<MissionStatus status={mission.status} />
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
	{#if mission.status === 'failed' && mission.error_message}
		<p class="mc-err">{mission.error_message}</p>
	{/if}
	<div class="mc-actions">
		<a class="btn btn-sm btn-ghost" href={threadHref(mission)}
			>Open thread <ArrowRightIcon size={12} aria-hidden="true" /></a
		>
		{#if pr_url}
			<a class="btn btn-sm btn-ghost" href={pr_url} target="_blank" rel="noopener noreferrer"
				><GitPullRequestIcon size={13} aria-hidden="true" />Pull request</a
			>
		{/if}
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
