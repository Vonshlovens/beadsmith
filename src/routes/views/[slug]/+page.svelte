<script lang="ts">
	/**
	 * One saved view (ADR-0025 rules 1, 5, 7 and 9), run as the viewer: its
	 * rows through the project read path, as a list (optionally grouped) or a
	 * board per project. Its owner also sees the history, newest first, and
	 * reverts (a new revision copying an old one forward), publishes a
	 * revision, or deletes it. Any admin may unpublish a view members see.
	 */
	import { goto, refreshAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import ArrowCounterClockwiseIcon from 'phosphor-svelte/lib/ArrowCounterClockwiseIcon';
	import EyeIcon from 'phosphor-svelte/lib/EyeIcon';
	import EyeSlashIcon from 'phosphor-svelte/lib/EyeSlashIcon';
	import FunnelSimpleIcon from 'phosphor-svelte/lib/FunnelSimpleIcon';
	import RobotIcon from 'phosphor-svelte/lib/RobotIcon';
	import TrashIcon from 'phosphor-svelte/lib/TrashIcon';
	import ConfirmDialog from '#lib/components/confirm-dialog.svelte';
	import EmptyState from '#lib/components/empty-state.svelte';
	import IssueRows from '#lib/components/issue-rows.svelte';
	import IssuesBoard from '#lib/components/issues-board.svelte';
	import PageHeader from '#lib/components/page-header.svelte';
	import ViewStateBadge from '#lib/components/view-state-badge.svelte';
	import { agentAvailability } from '#lib/client/agent.js';
	import { api, errorMessage } from '#lib/client/api.js';
	import { absoluteStamp, relativeShort } from '#lib/client/format.js';
	import { useHotkeys } from '#lib/client/hotkeys.svelte.js';
	import { stepFocus } from '#lib/client/list-focus.js';
	import { currentViewer, projectList, statusSnapshot } from '#lib/client/projects.svelte.js';
	import { app_state } from '#lib/client/stores.svelte.js';
	import { tip } from '#lib/client/tooltip.js';
	import {
		describeViewSpec,
		groupViewIssues,
		projectPageHref,
		viewBoardProjects
	} from '#lib/client/views.js';
	import { PRODUCT_NAME } from '#lib/product.js';
	import type { ReadyIssue } from '#lib/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let rows_el = $state<HTMLElement | null>(null);
	let refreshing = $state(false);
	let busy = $state(false);
	let confirm_delete = $state(false);
	let confirm_unpublish = $state(false);

	const view = $derived(data.view);
	const result = $derived(data.result);
	const is_admin = $derived(currentViewer()?.role === 'admin');
	const names = $derived(new Map(projectList().map((p) => [p.id, p.name])));
	const projectName = (id: string) => names.get(id) ?? id;
	const facts = $derived(view === null ? [] : describeViewSpec(view.spec, projectName));
	const groups = $derived(
		view === null || result === null ? [] : groupViewIssues(result.issues, view.spec.group_by)
	);
	const boards = $derived(result === null ? [] : viewBoardProjects(result.issues));
	const agent_visible = $derived(agentAvailability(statusSnapshot()).visible);
	const latest = $derived(data.revisions[0]?.number);
	const can_unpublish = $derived(is_admin && view?.published === true);
	/** The project page with this view's filters, when that page can show them. */
	const project_href = $derived(view === null ? null : projectPageHref(view.slug, view.spec));
	const meta = $derived(
		result === null
			? undefined
			: `${result.issues.length}${result.limit_reached ? '+' : ''} · r${view?.revision}`
	);

	async function refresh() {
		refreshing = true;
		try {
			await refreshAll();
		} finally {
			refreshing = false;
		}
	}

	/** Run one change, report it, and reload the page's data. */
	async function act(action: () => Promise<unknown>, done: string, failed: string) {
		if (busy) return;
		busy = true;
		try {
			await action();
			toast.success(done);
			await refreshAll();
		} catch (error) {
			toast.error(failed, { description: errorMessage(error) });
		} finally {
			busy = false;
		}
	}

	function revert(number: number) {
		void act(() => api.revertView(data.slug, number), `Reverted to r${number}`, 'Could not revert');
	}

	function publish(number?: number) {
		void act(
			() => api.publishView(data.slug, number),
			number === undefined ? 'Published: members see it now' : `Published r${number}`,
			'Could not publish'
		);
	}

	async function unpublish() {
		if (busy || view === null) return;
		busy = true;
		try {
			const { view: after } = await api.unpublishView(data.slug);
			toast.success(`${view.name} is hidden from members`);
			if (after === null) {
				// Another admin's view: nobody but its owner can see it now.
				await goto('/views');
			} else {
				await refreshAll();
			}
		} catch (error) {
			toast.error('Could not unpublish', { description: errorMessage(error) });
		} finally {
			busy = false;
		}
	}

	async function remove() {
		if (busy || view === null) return;
		busy = true;
		try {
			await api.deleteView(data.slug);
			toast.success(`${view.name} deleted`);
			await goto('/views');
		} catch (error) {
			toast.error('Could not delete it', { description: errorMessage(error) });
		} finally {
			busy = false;
		}
	}

	function ask(issue: ReadyIssue) {
		app_state.openAgent({
			project_id: issue.project_id,
			issue_id: issue.id,
			issue_title: issue.title
		});
	}

	useHotkeys(() =>
		view?.spec.presentation === 'board'
			? []
			: [
					{
						keys: ['j', 'ArrowDown'],
						label: 'Next issue',
						group: 'Lists',
						run: () => stepFocus(rows_el, 'a.rd-ti', 1)
					},
					{
						keys: ['k', 'ArrowUp'],
						label: 'Previous issue',
						group: 'Lists',
						run: () => stepFocus(rows_el, 'a.rd-ti', -1)
					}
				]
	);
</script>

<svelte:head><title>{view?.name ?? 'View'} · Views · {PRODUCT_NAME}</title></svelte:head>

<div class="wrap is-wide view-page">
	{#if view === null}
		<div class="banner banner-err" role="alert">
			<i class="dot dot-blocked" style="margin-top:5px" aria-hidden="true"></i>
			<div class="banner-bd">
				<b>This view could not be loaded.</b>
				<div class="mt-2">{data.error ?? 'It may have been deleted or unpublished.'}</div>
			</div>
			<div class="banner-acts">
				<button class="btn btn-sm" type="button" onclick={refresh}>Retry now</button>
				<a class="btn btn-sm btn-ghost" href="/views">All views</a>
			</div>
		</div>
	{:else}
		<PageHeader
			title={view.name}
			{meta}
			meta_label={result === null
				? undefined
				: `${result.issues.length} issues${result.limit_reached ? ' (row limit reached)' : ''}, revision ${view.revision}`}
			onrefresh={refresh}
			{refreshing}
		>
			{#snippet actions()}
				<ViewStateBadge {view} />
				{#if project_href !== null}
					<a
						class="btn btn-sm btn-ghost"
						href={project_href}
						{@attach tip(
							view.mine && is_admin
								? 'Open on the project page, change the filters there and save them as a new revision'
								: 'Open on the project page with these filters'
						)}
					>
						<FunnelSimpleIcon size={13} aria-hidden="true" />Open in project
					</a>
				{/if}
				{#if view.mine && (!view.published || view.unpublished_changes)}
					<button
						class="btn btn-sm btn-primary"
						type="button"
						disabled={busy}
						onclick={() => publish()}
					>
						<EyeIcon size={13} aria-hidden="true" />Publish
					</button>
				{/if}
				{#if can_unpublish}
					<button
						class="btn btn-sm"
						type="button"
						disabled={busy}
						onclick={() => (confirm_unpublish = true)}
					>
						<EyeSlashIcon size={13} aria-hidden="true" />Unpublish
					</button>
				{/if}
				{#if view.mine}
					<button
						class="btn btn-sm btn-ghost btn-icon"
						type="button"
						disabled={busy}
						aria-label="Delete {view.name}"
						{@attach tip('Delete')}
						onclick={() => (confirm_delete = true)}
					>
						<TrashIcon size={13} />
					</button>
				{/if}
			{/snippet}
		</PageHeader>

		{#if view.description}
			<p class="v-desc">{view.description}</p>
		{/if}
		<ul class="v-facts" aria-label="What this view shows">
			{#each facts as fact (fact)}
				<li>{fact}</li>
			{/each}
		</ul>

		{#if data.run_error}
			<div class="banner banner-err" role="alert">
				<i class="dot dot-blocked" style="margin-top:5px" aria-hidden="true"></i>
				<div class="banner-bd">
					<b>This view could not run.</b>
					<div class="mt-2">{data.run_error}</div>
				</div>
				<div class="banner-acts">
					<button class="btn btn-sm" type="button" onclick={refresh}>Retry now</button>
				</div>
			</div>
		{:else if result !== null}
			{#if result.skipped.length > 0}
				<div class="banner banner-warn" role="status">
					<div class="banner-bd">
						<b>Some projects could not be read.</b>
						{result.skipped.map((s) => `${projectName(s.project_id)}: ${s.message}`).join(' · ')}
					</div>
				</div>
			{/if}
			{#if result.limit_reached}
				<p class="hint">
					Showing the most recently updated issues up to the view's row limit; there may be more.
				</p>
			{/if}

			{#if result.issues.length === 0}
				<EmptyState
					title="Nothing matches"
					description="No issue fits this view's filters right now."
				/>
			{:else if view.spec.presentation === 'board'}
				{#each boards as board (board.project_id)}
					<section class="sec">
						{#if boards.length > 1 || view.spec.scope === 'all'}
							<div class="sec-hd">
								<a class="lbl" href="/p/{board.project_id}">{board.project_name}</a><span
									class="rule"
								></span>
								<span class="meta mono-num">{board.issues.length}</span>
							</div>
						{/if}
						<IssuesBoard
							issues={board.issues}
							project_id={board.project_id}
							status_filter={view.spec.filters.status ?? []}
							include_closed={view.spec.filters.include_closed === true}
						/>
					</section>
				{/each}
			{:else}
				<div bind:this={rows_el}>
					{#each groups as group (group.key)}
						<section class="sec">
							{#if group.label}
								<div class="sec-hd">
									<h2 class="lbl">{group.label}</h2>
									<span class="rule"></span>
									<span class="meta mono-num">{group.issues.length}</span>
								</div>
							{/if}
							<IssueRows
								issues={group.issues}
								label={group.label ? `${view.name}: ${group.label}` : view.name}
								{agent_visible}
								onask={ask}
							/>
						</section>
					{/each}
				</div>
			{/if}
		{/if}

		{#if view.mine}
			<section class="sec" aria-labelledby="view-history">
				<div class="sec-hd">
					<h2 class="lbl" id="view-history">History</h2>
					<span class="rule"></span>
					<span class="meta">newest first</span>
				</div>
				{#if data.revisions.length === 0}
					<p class="hint">The history could not be loaded. Refresh to try again.</p>
				{:else}
					<ol class="panel revs">
						{#each data.revisions as rev (rev.number)}
							<li class="rev">
								<span class="rev-n mono-num">r{rev.number}</span>
								<span class="rev-what">
									<span class="rev-name">{rev.name}</span>
									<span class="rev-how">
										{#if rev.author_kind === 'first_mate'}
											<span class="v-mate"
												><RobotIcon size={12} aria-hidden="true" />First Mate</span
											>
										{:else}
											You
										{/if}
										{#if rev.reverted_from !== undefined}
											· reverted to r{rev.reverted_from}
										{/if}
									</span>
								</span>
								<span class="rev-when mono-num" {@attach tip(absoluteStamp(rev.created_at))}
									>{relativeShort(rev.created_at)}</span
								>
								<span class="rev-tags">
									{#if rev.number === latest}
										<span class="badge badge-closed">Current</span>
									{/if}
									{#if rev.published}
										<span class="badge badge-open"
											><i class="dot dot-open" aria-hidden="true"></i>Published</span
										>
									{/if}
								</span>
								<span class="rev-acts">
									{#if !rev.published}
										<button
											class="btn btn-sm btn-ghost"
											type="button"
											disabled={busy}
											aria-label="Publish r{rev.number}"
											onclick={() => publish(rev.number)}
										>
											<EyeIcon size={13} aria-hidden="true" />Publish
										</button>
									{/if}
									{#if rev.number !== latest}
										<button
											class="btn btn-sm btn-ghost"
											type="button"
											disabled={busy}
											aria-label="Revert to r{rev.number}"
											{@attach tip(
												'Adds a new revision with this one’s name, description and filters'
											)}
											onclick={() => revert(rev.number)}
										>
											<ArrowCounterClockwiseIcon size={13} aria-hidden="true" />Revert
										</button>
									{/if}
								</span>
							</li>
						{/each}
					</ol>
				{/if}
			</section>
		{/if}

		<ConfirmDialog
			bind:open={confirm_delete}
			title="Delete {view.name}?"
			description="The view and its whole history are removed, for you and for any member it was published to. Issues are not touched."
			confirm_label="Delete view"
			destructive
			onconfirm={remove}
		/>
		<ConfirmDialog
			bind:open={confirm_unpublish}
			title="Unpublish {view.name}?"
			description={view.mine
				? 'Members stop seeing it. You can publish it again from here.'
				: 'Members stop seeing it, and so do you: only its owner can publish it again.'}
			confirm_label="Unpublish"
			onconfirm={unpublish}
		/>
	{/if}
</div>

<style>
	.view-page {
		max-width: 1480px;
	}
	.v-desc {
		margin: 0 0 var(--s-2);
		color: var(--tx-mid);
		font-size: var(--t-sm);
		max-width: 70ch;
	}
	.v-facts {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-2);
		list-style: none;
		margin: 0 0 var(--s-4);
		padding: 0;
	}
	.v-facts li {
		padding: 1px 8px;
		border: 1px solid var(--line-2);
		border-radius: var(--r-1);
		color: var(--tx-mid);
		font-size: var(--t-xs);
	}
	.sec-hd h2.lbl {
		margin: 0;
	}
	.sec-hd a.lbl {
		color: inherit;
	}
	.v-mate {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		color: var(--violet-tx);
	}
	.revs {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.rev {
		display: grid;
		grid-template-columns: 3em minmax(0, 1fr) 4em auto auto;
		align-items: center;
		gap: var(--s-3);
		min-height: 44px;
		padding: 4px var(--s-3) 4px var(--s-4);
		border-bottom: 1px solid var(--line);
		font-size: var(--t-xs);
	}
	.rev:last-child {
		border-bottom: 0;
	}
	.rev:hover,
	.rev:focus-within {
		background: var(--s3);
	}
	.rev-n {
		color: var(--tx-dim);
	}
	.rev-what {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
	}
	.rev-name {
		color: var(--tx-hi);
		font-size: var(--t-sm);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.rev-how,
	.rev-when {
		color: var(--tx-dim);
	}
	.rev-when {
		text-align: right;
	}
	.rev-tags,
	.rev-acts {
		display: inline-flex;
		gap: var(--s-2);
		justify-content: flex-end;
	}
	@media (max-width: 720px) {
		.rev {
			grid-template-columns: 3em minmax(0, 1fr) auto;
			row-gap: 4px;
			padding: 8px var(--s-3);
		}
		.rev-tags {
			grid-column: 2;
			justify-content: flex-start;
		}
		.rev-acts {
			grid-column: 2 / -1;
			justify-content: flex-start;
		}
	}
</style>
