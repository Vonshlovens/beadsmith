<script lang="ts">
	/**
	 * The catalog's IssueList: a binding's issues as the Ready page's rows
	 * (`issue-rows.svelte`), up to the component's limit. It says when it
	 * shows fewer than the binding read, or when the read itself stopped at
	 * its limit.
	 */
	import IssueRows from '#lib/components/issue-rows.svelte';
	import { agentAvailability } from '#lib/client/agent.js';
	import { projectList, statusSnapshot } from '#lib/client/projects.svelte.js';
	import { app_state } from '#lib/client/stores.svelte.js';
	import { surfaceIssues } from '#lib/client/surfaces.js';
	import type { SurfaceBindingResult } from '#lib/surfaces.js';
	import type { ReadyIssue } from '#lib/types.js';
	import SurfaceBindingError from './surface-binding-error.svelte';

	interface Props {
		/** The list's accessible name. */
		label: string;
		limit: number;
		empty?: string;
		result: SurfaceBindingResult | undefined;
	}

	let { label, limit, empty, result }: Props = $props();

	const names = $derived(new Map(projectList().map((p) => [p.id, p.name])));
	const read = $derived(surfaceIssues(result, (id) => names.get(id) ?? id));
	const shown = $derived(read.ok ? read.value.issues.slice(0, limit) : []);
	const total = $derived(read.ok ? read.value.issues.length + read.value.dropped : 0);
	const agent_visible = $derived(agentAvailability(statusSnapshot()).visible);

	function ask(issue: ReadyIssue) {
		app_state.openAgent({
			project_id: issue.project_id,
			issue_id: issue.id,
			issue_title: issue.title
		});
	}
</script>

{#if !read.ok}
	<SurfaceBindingError what={label} message={read.message} />
{:else if shown.length === 0}
	<p class="sf-empty panel">{empty ?? 'No issues match right now.'}</p>
{:else}
	<div class="sf-list">
		<IssueRows issues={shown} {label} {agent_visible} onask={ask} />
		{#if shown.length < total || read.value.more}
			<p class="hint">
				Showing {shown.length} of {total}{read.value.more ? '+' : ''} issues{read.value.more
					? '; the read stopped at its limit'
					: ''}.
			</p>
		{/if}
	</div>
{/if}

<style>
	.sf-list {
		display: flex;
		flex-direction: column;
		gap: var(--s-2);
		min-width: 0;
	}
	.sf-empty {
		margin: 0;
		padding: var(--s-3) var(--s-4);
		color: var(--tx-dim);
		font-size: var(--t-sm);
	}
</style>
