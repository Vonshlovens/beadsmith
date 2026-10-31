<script lang="ts">
	/**
	 * Issue detail (specs/03). The layout lives in IssueDetailView so the
	 * parade's reading pane renders the same thing; this route adds the
	 * breadcrumb and the streamed-load plumbing.
	 */
	import { goto } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import IssueAgentPanel from '$lib/components/issue-agent-panel.svelte';
	import IssueDetailView from '$lib/components/issue-detail-view.svelte';
	import { agentAvailability } from '$lib/client/agent';
	import { useHotkeys } from '$lib/client/hotkeys.svelte';
	import {
		issueViewStorageKey,
		parseStoredIssueView,
		projectIssuesHref
	} from '$lib/client/issue-view';
	import { app_state } from '$lib/client/stores.svelte';
	import { currentProject, statusSnapshot } from '$lib/client/projects.svelte';
	import { takeIssueSummaryHint } from '$lib/client/issue-summary-hint.js';
	import type { IssueDetail, IssueSummary } from '$lib/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let hint = $state<IssueSummary | undefined>(undefined);
	let detail = $state<IssueDetail | undefined>(undefined);
	let last_id = '';

	/**
	 * True when `load` is still streaming this issue. A fulfilled Promise still
	 * has `.then`, so this stays true until SvelteKit unwraps it to a plain
	 * object. SSR awaits first, so a hard load is already an `IssueDetail`.
	 */
	function isPendingIssue(value: unknown): value is Promise<IssueDetail> {
		return (
			typeof value === 'object' &&
			value !== null &&
			'then' in value &&
			typeof (value as Promise<IssueDetail>).then === 'function'
		);
	}

	$effect.pre(() => {
		const issue_id = data.issue_id;
		if (issue_id !== last_id) {
			last_id = issue_id;
			hint = takeIssueSummaryHint(issue_id);
			detail = undefined;
		}
		const pending = data.issue;
		if (!isPendingIssue(pending)) {
			hint = undefined;
			detail = pending;
			return;
		}
		const token = issue_id;
		void pending.then((full) => {
			if (data.issue_id !== token) {
				return;
			}
			hint = undefined;
			detail = full;
		});
	});

	const from_load = $derived(isPendingIssue(data.issue) ? undefined : data.issue);
	const issue = $derived(from_load ?? detail);
	const header = $derived(issue ?? hint);
	const project = $derived(currentProject());
	const dispatch_enabled = $derived(statusSnapshot()?.dispatch.enabled === true);
	const tackle_enabled = $derived(dispatch_enabled && project?.allow?.tackle !== false);
	const comment_enabled = $derived(
		dispatch_enabled && (project?.allow?.file !== false || project?.allow?.tackle !== false)
	);
	const agent_visible = $derived(agentAvailability(statusSnapshot(), project?.allow).visible);

	/** Wide screens put the agent beside the issue instead of in a dialog. */
	const SIDE_AGENT_MIN_WIDTH = 1680;
	let viewport = $state(0);
	const side_agent = $derived(agent_visible && viewport >= SIDE_AGENT_MIN_WIDTH);

	/** The list this issue was opened from, in the view the reader left it in. */
	const back_href = $derived.by(() => {
		let stored: string | null = null;
		try {
			stored =
				typeof window === 'undefined'
					? null
					: window.localStorage.getItem(issueViewStorageKey(data.project_id));
		} catch {
			stored = null;
		}
		const view = parseStoredIssueView(stored);
		const params = new URLSearchParams();
		if (view === null || view === 'parade') {
			params.set('issue', data.issue_id);
		}
		return projectIssuesHref(data.project_id, view ?? 'parade', params);
	});

	function askAgent(intent?: 'tackle') {
		if (!header) {
			return false;
		}
		app_state.openAgent({
			project_id: data.project_id,
			issue_id: header.id,
			issue_title: header.title,
			...(intent === undefined ? {} : { intent })
		});
	}

	useHotkeys(() => [
		{
			keys: ['Escape'],
			label: 'Back to the list',
			group: 'Issue',
			run: () => void goto(back_href)
		},
		{
			keys: ['a'],
			label: 'Ask an agent about this issue',
			group: 'Agent',
			when: () => agent_visible,
			run: () => askAgent()
		},
		{
			keys: ['t'],
			label: 'Tackle this issue',
			group: 'Agent',
			when: () => agent_visible && tackle_enabled,
			run: () => askAgent('tackle')
		},
		{
			keys: ['c'],
			label: 'Write a comment',
			group: 'Issue',
			when: () => comment_enabled,
			run: () => {
				const box = document.getElementById('cmt-new');
				if (box === null) {
					return false;
				}
				box.scrollIntoView({ block: 'center' });
				box.focus();
			}
		},
		{
			keys: ['y'],
			label: 'Copy the issue id',
			group: 'Issue',
			run: () => {
				if (!header) {
					return false;
				}
				const id = header.id;
				navigator.clipboard.writeText(id).then(
					() => toast.success('Copied the id', { description: id }),
					() => toast.error('Could not copy the id')
				);
			}
		}
	]);
</script>

<svelte:head>
	<title>{header ? `${header.id} · ${header.title}` : data.issue_id}</title>
</svelte:head>

<svelte:window bind:innerWidth={viewport} />

{#if header}
	<div class="wrap is-detail" class:has-agent={side_agent}>
		<IssueDetailView
			project_id={data.project_id}
			{header}
			{issue}
			missions={data.missions}
			{tackle_enabled}
			{comment_enabled}
		>
			{#snippet lead()}
				<nav class="crumb" aria-label="Breadcrumb">
					<a href={back_href} title="Back to the list (esc)">← {project?.name ?? 'Issues'}</a>
				</nav>
			{/snippet}
		</IssueDetailView>
		{#if side_agent}
			<IssueAgentPanel project_id={data.project_id} issue={header} missions={data.missions} />
		{/if}
	</div>
{/if}

<style>
	.is-detail {
		max-width: 1320px;
	}
	.is-detail.has-agent {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(380px, 460px);
		gap: var(--s-5);
		align-items: start;
		max-width: 1840px;
	}
	.crumb {
		font-size: var(--t-xs);
		margin-right: var(--s-2);
	}
	.crumb a {
		color: var(--tx-dim);
	}
	.crumb a:hover {
		color: var(--tx-hi);
		text-decoration: none;
	}
</style>
