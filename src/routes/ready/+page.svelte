<script lang="ts">
	/** Cross-project Ready deck: control-plane equivalent of `bd ready`. */
	import { invalidateAll } from '$app/navigation';
	import BotIcon from '@lucide/svelte/icons/bot';
	import EmptyState from '$lib/components/empty-state.svelte';
	import IssueId from '$lib/components/issue-id.svelte';
	import PageHeader from '$lib/components/page-header.svelte';
	import PriorityChip from '$lib/components/priority-chip.svelte';
	import TypeChip from '$lib/components/type-chip.svelte';
	import { agentAvailability } from '$lib/client/agent';
	import { relativeShort } from '$lib/client/format';
	import { useHotkeys } from '$lib/client/hotkeys.svelte';
	import { stepFocus } from '$lib/client/list-focus';
	import { projectList, statusSnapshot } from '$lib/client/projects.svelte';
	import { app_state } from '$lib/client/stores.svelte';
	import { PRODUCT_NAME } from '$lib/product';
	import type { ReadyIssue } from '$lib/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let list_el = $state<HTMLUListElement | null>(null);
	let refreshing = $state(false);

	const agent_visible = $derived(agentAvailability(statusSnapshot()).visible);
	const project_allow = $derived(
		new Map(projectList().map((project) => [project.id, project.allow]))
	);

	async function refresh() {
		refreshing = true;
		try {
			await invalidateAll();
		} finally {
			refreshing = false;
		}
	}

	function ask(issue: ReadyIssue, intent?: 'tackle') {
		app_state.openAgent({
			project_id: issue.project_id,
			issue_id: issue.id,
			issue_title: issue.title,
			...(intent === undefined ? {} : { intent })
		});
	}

	/** The row that holds keyboard focus. */
	function focusedIssue(): ReadyIssue | undefined {
		const key = document.activeElement?.closest('[data-ready]')?.getAttribute('data-ready');
		return data.issues.find((issue) => `${issue.project_id}:${issue.id}` === key);
	}

	useHotkeys(() => [
		{
			keys: ['j', 'ArrowDown'],
			label: 'Next issue',
			group: 'Lists',
			run: () => stepFocus(list_el, 'a.rd-ti', 1)
		},
		{
			keys: ['k', 'ArrowUp'],
			label: 'Previous issue',
			group: 'Lists',
			run: () => stepFocus(list_el, 'a.rd-ti', -1)
		},
		{
			keys: ['a'],
			label: 'Ask an agent about the focused issue',
			group: 'Agent',
			when: () => agent_visible,
			run: () => {
				const issue = focusedIssue();
				if (issue === undefined) {
					return false;
				}
				ask(issue);
			}
		},
		{
			keys: ['t'],
			label: 'Tackle the focused issue',
			group: 'Agent',
			when: () => agent_visible,
			run: () => {
				const issue = focusedIssue();
				if (issue === undefined || project_allow.get(issue.project_id)?.tackle === false) {
					return false;
				}
				ask(issue, 'tackle');
			}
		}
	]);
</script>

<svelte:head><title>Ready · {PRODUCT_NAME}</title></svelte:head>

<div class="wrap is-wide ready">
	<PageHeader
		title="Ready"
		meta={String(data.issues.length)}
		meta_label="{data.issues.length} unblocked issues across all projects"
		onrefresh={refresh}
		{refreshing}
	/>

	{#if data.error}
		<div class="banner banner-err" role="alert">
			<i class="dot dot-blocked" style="margin-top:5px" aria-hidden="true"></i>
			<div class="banner-bd">
				<b>The Ready deck could not be loaded.</b>
				<div class="mt-2">{data.error}</div>
			</div>
			<div class="banner-acts">
				<button class="btn btn-sm" type="button" onclick={refresh}>Retry now</button>
			</div>
		</div>
	{:else if data.issues.length === 0}
		<EmptyState
			title="Nothing is ready"
			description="Unblocked open issues from every project show up here."
		>
			{#snippet actions()}
				<a class="btn btn-sm" href="/">Open projects</a>
			{/snippet}
		</EmptyState>
	{:else}
		<ul class="rd panel" bind:this={list_el} aria-label="Ready issues">
			{#each data.issues as issue (`${issue.project_id}:${issue.id}`)}
				<li class="rd-row" data-ready="{issue.project_id}:{issue.id}">
					<PriorityChip priority={issue.priority} />
					<IssueId id={issue.id} href="/p/{issue.project_id}/i/{issue.id}" abbreviate />
					<a class="rd-ti" href="/p/{issue.project_id}/i/{issue.id}" title={issue.title}
						>{issue.title}</a
					>
					<a class="rd-proj" href="/p/{issue.project_id}" title="Project {issue.project_name}"
						>{issue.project_name}</a
					>
					<span class="rd-ty"><TypeChip type={issue.issue_type} /></span>
					<span class="rd-when mono-num" title={issue.updated_at}
						>{relativeShort(issue.updated_at)}</span
					>
					{#if agent_visible}
						<button
							class="btn btn-sm btn-ghost btn-icon rd-act"
							type="button"
							aria-label="Ask an agent about {issue.id}"
							title="Agent (a)"
							onclick={() => ask(issue)}
						>
							<BotIcon size={14} strokeWidth={1.4} />
						</button>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.ready {
		max-width: 1480px;
	}
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
		color: var(--tx-faint);
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
