<script lang="ts">
	/** Cross-project Ready deck: control-plane equivalent of `bd ready`. */
	import { refreshAll } from '$app/navigation';
	import EmptyState from '#lib/components/empty-state.svelte';
	import IssueRows from '#lib/components/issue-rows.svelte';
	import PageHeader from '#lib/components/page-header.svelte';
	import { agentAvailability } from '#lib/client/agent.js';
	import { useHotkeys } from '#lib/client/hotkeys.svelte.js';
	import { stepFocus } from '#lib/client/list-focus.js';
	import { projectList, statusSnapshot } from '#lib/client/projects.svelte.js';
	import { app_state } from '#lib/client/stores.svelte.js';
	import { PRODUCT_NAME } from '#lib/product.js';
	import type { ReadyIssue } from '#lib/types.js';
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
			await refreshAll();
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
				<a class="btn btn-sm" href="/projects">Open projects</a>
			{/snippet}
		</EmptyState>
	{:else}
		<IssueRows
			issues={data.issues}
			label="Ready issues"
			{agent_visible}
			onask={(issue) => ask(issue)}
			bind:list_el
		/>
	{/if}
</div>

<style>
	.ready {
		max-width: 1480px;
	}
</style>
