<script lang="ts">
	/**
	 * Issues from any project as compact rows: priority, id, title, project,
	 * type, last update and an Ask button. Ready and saved views both list
	 * cross-project issues this way, so a row reads the same on either page.
	 * Each row carries `data-ready="project:id"` and its title is `a.rd-ti`,
	 * the targets of the pages' j/k and agent hotkeys.
	 */
	import { tip } from '#lib/client/tooltip.js';
	import RobotIcon from 'phosphor-svelte/lib/RobotIcon';
	import IssueId from '#lib/components/issue-id.svelte';
	import PriorityChip from '#lib/components/priority-chip.svelte';
	import TypeChip from '#lib/components/type-chip.svelte';
	import { relativeShort } from '#lib/client/format.js';
	import type { ReadyIssue } from '#lib/types.js';

	interface Props {
		issues: ReadyIssue[];
		/** The list's accessible name. */
		label: string;
		/** Show the Ask button; the caller decides from agent availability. */
		agent_visible?: boolean;
		onask?: (issue: ReadyIssue) => void;
		list_el?: HTMLUListElement | null;
	}

	let { issues, label, agent_visible = false, onask, list_el = $bindable(null) }: Props = $props();
</script>

<ul class="rd panel" bind:this={list_el} aria-label={label}>
	{#each issues as issue (`${issue.project_id}:${issue.id}`)}
		<li class="rd-row" data-ready="{issue.project_id}:{issue.id}">
			<PriorityChip priority={issue.priority} />
			<IssueId id={issue.id} href="/p/{issue.project_id}/i/{issue.id}" abbreviate />
			<a class="rd-ti" href="/p/{issue.project_id}/i/{issue.id}" {@attach tip(issue.title)}
				>{issue.title}</a
			>
			<a class="rd-proj" href="/p/{issue.project_id}" {@attach tip(`Project ${issue.project_name}`)}
				>{issue.project_name}</a
			>
			<span class="rd-ty"><TypeChip type={issue.issue_type} /></span>
			<span class="rd-when mono-num" {@attach tip(issue.updated_at)}
				>{relativeShort(issue.updated_at)}</span
			>
			{#if agent_visible}
				<button
					class="btn btn-sm btn-ghost btn-icon rd-act"
					type="button"
					aria-label="Ask an agent about {issue.id}"
					{@attach tip('Agent (a)')}
					onclick={() => onask?.(issue)}
				>
					<RobotIcon size={14} />
				</button>
			{/if}
		</li>
	{/each}
</ul>

<style>
	.rd {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.rd-row {
		display: grid;
		grid-template-columns: auto 5.2em minmax(0, 1fr) minmax(0, 12em) 6.5em 3em 28px;
		align-items: center;
		gap: var(--s-3);
		min-height: 34px;
		padding: 3px var(--s-3) 3px var(--s-4);
		border-bottom: 1px solid var(--line);
		font-size: var(--t-sm);
	}
	.rd-row:last-child {
		border-bottom: 0;
	}
	.rd-row:hover,
	.rd-row:focus-within {
		background: var(--s3);
	}
	.rd-row:focus-within {
		box-shadow: inset 2px 0 0 var(--em-500);
	}
	.rd-ti {
		color: var(--tx-hi);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		outline: none;
	}
	.rd-ti:hover {
		text-decoration: none;
		color: var(--em-400);
	}
	.rd-proj {
		font-size: var(--t-xs);
		color: var(--tx-dim);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.rd-ty {
		justify-self: start;
	}
	.rd-when {
		font-size: var(--t-xs);
		color: var(--tx-dim);
		text-align: right;
	}
	/* Phone: id, project and priority on one line, the title under them. */
	@media (max-width: 720px) {
		.rd-row {
			grid-template-columns: auto auto minmax(0, 1fr) auto 28px;
			grid-template-areas:
				'pr id proj when act'
				'ti ti ti ti act';
			row-gap: 2px;
			padding: 6px var(--s-3);
		}
		.rd-row > :global(.prio) {
			grid-area: pr;
		}
		.rd-row > :global(.id) {
			grid-area: id;
		}
		.rd-proj {
			grid-area: proj;
		}
		.rd-when {
			grid-area: when;
		}
		.rd-ti {
			grid-area: ti;
			white-space: normal;
		}
		.rd-act {
			grid-area: act;
		}
		.rd-ty {
			display: none;
		}
	}
</style>
