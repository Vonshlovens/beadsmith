<script lang="ts">
	/**
	 * Agent missions as rows. Compact mode is the issue page's thread list
	 * (rows open the thread in the agent dialog); the full list is the
	 * cross-project Missions page (rows open the thread in First Mate). The
	 * conversation itself lives in agent-thread.svelte.
	 */
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import GitPullRequestIcon from '@lucide/svelte/icons/git-pull-request';
	import IssueId from '$lib/components/issue-id.svelte';
	import MissionStatus from '$lib/components/mission-status.svelte';
	import { formatElapsed, isSafeRunUrl, missionVerb } from '$lib/client/agent';
	import { threadHref } from '$lib/client/first-mate';
	import { relativeShort } from '$lib/client/format';
	import { app_state } from '$lib/client/stores.svelte';
	import type { Mission } from '$lib/types';

	interface Props {
		missions: Mission[];
		show_project?: boolean;
		compact?: boolean;
	}

	let { missions, show_project = false, compact = false }: Props = $props();

	function openInDialog(mission: Mission) {
		if (mission.issue_id === undefined) {
			return;
		}
		app_state.openAgent({
			project_id: mission.project_id,
			issue_id: mission.issue_id,
			issue_title: mission.title ?? mission.issue_id,
			request_id: mission.id
		});
	}
</script>

{#if compact}
	<ul class="compact">
		{#each missions as mission (mission.id)}
			<li>
				<button class="c-row" type="button" onclick={() => openInDialog(mission)}>
					<span class="verb">{missionVerb(mission)}</span>
					<MissionStatus status={mission.status} />
					<span class="spacer"></span>
					<span class="faint">{mission.actor}</span>
					<span class="faint mono-num">{relativeShort(mission.updated_at)}</span>
				</button>
				{#if mission.error_message}
					<p class="err">{mission.error_message}</p>
				{/if}
			</li>
		{/each}
	</ul>
{:else}
	<ul class="fleet panel" aria-label="Missions">
		{#each missions as mission (mission.id)}
			<li class="f-row">
				<a class="f-main" href={threadHref(mission)}>
					<span class="verb">{missionVerb(mission)}</span>
					<span class="f-st"><MissionStatus status={mission.status} /></span>
					<span class="f-ti">
						{#if mission.issue_id}<IssueId id={mission.issue_id} abbreviate />{/if}
						<span class="f-title">{mission.title ?? ''}</span>
					</span>
				</a>
				{#if show_project}
					<a class="f-proj" href="/p/{mission.project_id}">{mission.project_name}</a>
				{/if}
				<span class="f-actor" title={mission.actor}>{mission.actor}</span>
				<span class="f-dur mono-num" title="Run time"
					>{mission.duration_ms === undefined ? '' : formatElapsed(mission.duration_ms)}</span
				>
				<span class="f-when mono-num" title={mission.updated_at}
					>{relativeShort(mission.updated_at)}</span
				>
				<span class="f-links">
					{#if mission.git_pr_url}
						<a
							class="btn btn-sm btn-ghost btn-icon"
							href={mission.git_pr_url}
							target="_blank"
							rel="noopener noreferrer"
							aria-label="Pull request for this mission"
							title="Pull request"><GitPullRequestIcon size={13} strokeWidth={1.4} /></a
						>
					{/if}
					{#if isSafeRunUrl(mission.agent_url)}
						<a
							class="btn btn-sm btn-ghost btn-icon"
							href={mission.agent_url}
							target="_blank"
							rel="noopener noreferrer"
							aria-label="Open the run on the agent runner"
							title="Open the run"><ExternalLinkIcon size={13} strokeWidth={1.4} /></a
						>
					{/if}
				</span>
				{#if mission.error_message}
					<p class="err f-err">{mission.error_message}</p>
				{/if}
			</li>
		{/each}
	</ul>
{/if}

<style>
	.compact {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}
	.c-row {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		width: 100%;
		min-height: 32px;
		padding: 0 var(--s-2);
		background: none;
		border: 1px solid transparent;
		border-radius: var(--r-1);
		color: var(--tx);
		font: inherit;
		font-size: var(--t-xs);
		cursor: pointer;
		text-align: left;
	}
	.c-row:hover {
		background: var(--s3);
		border-color: var(--line);
	}
	.verb {
		color: var(--tx-hi);
		font-weight: 600;
		font-size: var(--t-xs);
	}
	.spacer {
		flex: 1;
	}
	.err {
		margin: 2px 0 4px;
		padding: 0 var(--s-2);
		font-size: var(--t-xs);
		color: var(--danger-tx);
	}

	.fleet {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.f-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 10em) minmax(0, 12em) 4em 3em auto;
		align-items: center;
		gap: var(--s-3);
		min-height: 36px;
		padding: 3px var(--s-3) 3px var(--s-4);
		border-bottom: 1px solid var(--line);
		font-size: var(--t-xs);
	}
	.f-row:last-child {
		border-bottom: 0;
	}
	.f-row:hover,
	.f-row:focus-within {
		background: var(--s3);
	}
	.f-main {
		display: grid;
		grid-template-columns: 5.5em auto minmax(0, 1fr);
		align-items: center;
		gap: var(--s-3);
		min-width: 0;
		color: inherit;
		outline: none;
	}
	.f-main:hover {
		text-decoration: none;
	}
	.f-main:focus-visible {
		box-shadow: -2px 0 0 var(--em-500);
	}
	.f-ti {
		display: flex;
		align-items: baseline;
		gap: var(--s-2);
		min-width: 0;
	}
	.f-title {
		color: var(--tx-hi);
		font-size: var(--t-sm);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.f-proj,
	.f-actor {
		color: var(--tx-dim);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.f-dur,
	.f-when {
		color: var(--tx-faint);
		text-align: right;
	}
	.f-links {
		display: inline-flex;
		justify-content: flex-end;
		min-width: 52px;
	}
	.f-err {
		grid-column: 1 / -1;
		margin: 0;
		padding: 0;
	}
	.fleet:not(:has(.f-proj)) .f-row {
		grid-template-columns: minmax(0, 1fr) minmax(0, 12em) 4em 3em auto;
	}
	@media (max-width: 760px) {
		.f-row,
		.fleet:not(:has(.f-proj)) .f-row {
			grid-template-columns: minmax(0, 1fr) auto auto;
			padding: 6px var(--s-3);
		}
		.f-main {
			grid-template-columns: auto minmax(0, 1fr);
			grid-column: 1 / -1;
		}
		.f-st {
			justify-self: start;
		}
		.f-ti {
			grid-column: 1 / -1;
		}
		.f-actor,
		.f-dur {
			display: none;
		}
	}
</style>
