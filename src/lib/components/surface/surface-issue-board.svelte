<script lang="ts">
	/**
	 * The catalog's IssueBoard: a binding's issues on the project board
	 * (`issues-board.svelte`), one board per project, since a board's columns
	 * are one project's statuses. Read-only here: the board's dispatch and
	 * create controls stay off, because a surface's writes go through its
	 * buttons and the host confirmation (ADR-0025 rule 6).
	 */
	import IssuesBoard from '#lib/components/issues-board.svelte';
	import { projectList } from '#lib/client/projects.svelte.js';
	import { surfaceIssues } from '#lib/client/surfaces.js';
	import { viewBoardProjects } from '#lib/client/views.js';
	import type { SurfaceBindingResult } from '#lib/surfaces.js';
	import SurfaceBindingError from './surface-binding-error.svelte';

	interface Props {
		label: string;
		result: SurfaceBindingResult | undefined;
	}

	let { label, result }: Props = $props();

	const names = $derived(new Map(projectList().map((p) => [p.id, p.name])));
	const read = $derived(surfaceIssues(result, (id) => names.get(id) ?? id));
	const boards = $derived(read.ok ? viewBoardProjects(read.value.issues) : []);
	const include_closed = $derived(
		read.ok && read.value.issues.some((issue) => issue.status === 'closed')
	);
</script>

{#if !read.ok}
	<SurfaceBindingError what={label} message={read.message} />
{:else if boards.length === 0}
	<p class="sf-empty panel">No issues match right now.</p>
{:else}
	<div class="sf-boards" role="group" aria-label={label}>
		{#each boards as board (board.project_id)}
			<section class="sf-board">
				{#if boards.length > 1}
					<div class="sec-hd">
						<a class="lbl" href="/p/{board.project_id}">{board.project_name}</a><span class="rule"
						></span>
						<span class="meta mono-num">{board.issues.length}</span>
					</div>
				{/if}
				<IssuesBoard
					issues={board.issues}
					project_id={board.project_id}
					status_filter={[]}
					{include_closed}
				/>
			</section>
		{/each}
		{#if read.value.dropped > 0}
			<p class="hint">
				{read.value.dropped} more issues did not fit the surface's result size and are not on the board.
			</p>
		{:else if read.value.more}
			<p class="hint">
				The read stopped at its limit; there may be more issues than the board shows.
			</p>
		{/if}
	</div>
{/if}

<style>
	.sf-boards {
		display: flex;
		flex-direction: column;
		gap: var(--s-4);
		min-width: 0;
	}
	.sf-board {
		min-width: 0;
	}
	.sf-board a.lbl {
		color: inherit;
	}
	.sf-empty {
		margin: 0;
		padding: var(--s-3) var(--s-4);
		color: var(--tx-dim);
		font-size: var(--t-sm);
	}
</style>
