<script lang="ts">
	/**
	 * One grown thing (ADR-0025 rules 1, 2, 5, 7 and 9), read as the viewer.
	 * A view shows its rows through the project read path, as a list
	 * (optionally grouped) or a board per project; a catalog surface is drawn
	 * natively from its component tree with its bindings resolved as the
	 * viewer; a sandboxed app runs in its frame, reading through the bridge as
	 * the viewer. The owner also sees the history, newest first, and reverts (a
	 * new revision copying an old one forward), publishes a revision, or
	 * deletes it. Any admin may unpublish one members see.
	 */
	import { goto, refreshAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import EyeIcon from 'phosphor-svelte/lib/EyeIcon';
	import EyeSlashIcon from 'phosphor-svelte/lib/EyeSlashIcon';
	import FunnelSimpleIcon from 'phosphor-svelte/lib/FunnelSimpleIcon';
	import TrashIcon from 'phosphor-svelte/lib/TrashIcon';
	import AppFrame from '#lib/components/app/app-frame.svelte';
	import ConfirmDialog from '#lib/components/confirm-dialog.svelte';
	import EmptyState from '#lib/components/empty-state.svelte';
	import GrownHistory from '#lib/components/grown-history.svelte';
	import IssueRows from '#lib/components/issue-rows.svelte';
	import IssuesBoard from '#lib/components/issues-board.svelte';
	import PageHeader from '#lib/components/page-header.svelte';
	import SurfaceTree from '#lib/components/surface/surface-tree.svelte';
	import ViewStateBadge from '#lib/components/view-state-badge.svelte';
	import { agentAvailability } from '#lib/client/agent.js';
	import { api, errorMessage } from '#lib/client/api.js';
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
	const surface = $derived(data.surface);
	const app = $derived(data.app);
	/** Whichever kind this slug is; the header, history and dialogs treat every kind alike. */
	const thing = $derived(view ?? surface ?? app);
	const kind_word = $derived(view !== null ? 'view' : surface !== null ? 'surface' : 'app');
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
	const can_unpublish = $derived(is_admin && thing?.published === true);
	/** The project page with this view's filters, when that page can show them. */
	const project_href = $derived(view === null ? null : projectPageHref(view.slug, view.spec));
	const meta = $derived(
		thing === null
			? undefined
			: result !== null
				? `${result.issues.length}${result.limit_reached ? '+' : ''} · r${thing.revision}`
				: `r${thing.revision}`
	);
	const meta_label = $derived(
		thing === null
			? undefined
			: result !== null
				? `${result.issues.length} issues${result.limit_reached ? ' (row limit reached)' : ''}, revision ${thing.revision}`
				: `Revision ${thing.revision}`
	);
	/** j/k step through issue rows; a board brings its own keys. */
	const has_rows = $derived(
		view !== null
			? view.spec.presentation !== 'board'
			: surface !== null &&
					surface.spec.components.some((c) => c.component === 'IssueList') &&
					!surface.spec.components.some((c) => c.component === 'IssueBoard')
	);

	/** The owner's and admins' operations, for whichever kind this is. */
	const ops = $derived(
		view !== null
			? {
					revert: (n: number) => api.revertView(data.slug, n),
					publish: (n?: number) => api.publishView(data.slug, n),
					unpublish: async () => (await api.unpublishView(data.slug)).view,
					remove: () => api.deleteView(data.slug)
				}
			: surface !== null
				? {
						revert: (n: number) => api.revertSurface(data.slug, n),
						publish: (n?: number) => api.publishSurface(data.slug, n),
						unpublish: async () => (await api.unpublishSurface(data.slug)).surface,
						remove: () => api.deleteSurface(data.slug)
					}
				: {
						revert: (n: number) => api.revertApp(data.slug, n),
						publish: (n?: number) => api.publishApp(data.slug, n),
						unpublish: async () => (await api.unpublishApp(data.slug)).app,
						remove: () => api.deleteApp(data.slug)
					}
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
		void act(() => ops.revert(number), `Reverted to r${number}`, 'Could not revert');
	}

	function publish(number?: number) {
		void act(
			() => ops.publish(number),
			number === undefined ? 'Published: members see it now' : `Published r${number}`,
			'Could not publish'
		);
	}

	async function unpublish() {
		if (busy || thing === null) return;
		busy = true;
		try {
			const after = await ops.unpublish();
			toast.success(`${thing.name} is hidden from members`);
			if (after === null) {
				// Another admin's: nobody but its owner can see it now.
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
		if (busy || thing === null) return;
		busy = true;
		try {
			await ops.remove();
			toast.success(`${thing.name} deleted`);
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
		!has_rows
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

<svelte:head><title>{thing?.name ?? 'View'} · Views · {PRODUCT_NAME}</title></svelte:head>

<div class="wrap is-wide view-page">
	{#if thing === null}
		<div class="banner banner-err" role="alert">
			<i class="dot dot-blocked" style="margin-top:5px" aria-hidden="true"></i>
			<div class="banner-bd">
				<b>This could not be loaded.</b>
				<div class="mt-2">{data.error ?? 'It may have been deleted or unpublished.'}</div>
			</div>
			<div class="banner-acts">
				<button class="btn btn-sm" type="button" onclick={refresh}>Retry now</button>
				<a class="btn btn-sm btn-ghost" href="/views">All views</a>
			</div>
		</div>
	{:else}
		<PageHeader title={thing.name} {meta} {meta_label} onrefresh={refresh} {refreshing}>
			{#snippet actions()}
				<ViewStateBadge view={thing} />
				{#if view !== null && project_href !== null}
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
				{#if thing.mine && (!thing.published || thing.unpublished_changes)}
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
				{#if thing.mine}
					<button
						class="btn btn-sm btn-ghost btn-icon"
						type="button"
						disabled={busy}
						aria-label="Delete {thing.name}"
						{@attach tip('Delete')}
						onclick={() => (confirm_delete = true)}
					>
						<TrashIcon size={13} />
					</button>
				{/if}
			{/snippet}
		</PageHeader>

		{#if thing.description}
			<p class="v-desc">{thing.description}</p>
		{/if}
		{#if view !== null}
			<ul class="v-facts" aria-label="What this view shows">
				{#each facts as fact (fact)}
					<li>{fact}</li>
				{/each}
			</ul>
		{/if}

		{#if data.run_error}
			<div class="banner banner-err" role="alert">
				<i class="dot dot-blocked" style="margin-top:5px" aria-hidden="true"></i>
				<div class="banner-bd">
					<b>This {kind_word}'s data could not be read.</b>
					<div class="mt-2">{data.run_error}</div>
				</div>
				<div class="banner-acts">
					<button class="btn btn-sm" type="button" onclick={refresh}>Retry now</button>
				</div>
			</div>
		{/if}

		{#if surface !== null}
			<div class="sf-body" bind:this={rows_el}>
				<SurfaceTree
					spec={surface.spec}
					bindings={data.surface_data?.bindings ?? null}
					name={surface.name}
					slug={surface.slug}
					revision={surface.revision}
					can_act={is_admin}
				/>
			</div>
		{:else if app !== null}
			<div class="sf-body">
				<AppFrame
					slug={app.slug}
					name={app.name}
					revision={app.revision}
					theme={app_state.resolved_theme}
					role={currentViewer()?.role ?? 'member'}
				/>
			</div>
		{:else if view !== null && result !== null}
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

		{#if thing.mine}
			<GrownHistory
				revisions={data.revisions}
				{busy}
				revert_help={view !== null
					? 'Adds a new revision with this one’s name, description and filters'
					: surface !== null
						? 'Adds a new revision with this one’s name, description and layout'
						: 'Adds a new revision with this one’s name, description and code'}
				onrevert={revert}
				onpublish={publish}
			/>
		{/if}

		<ConfirmDialog
			bind:open={confirm_delete}
			title="Delete {thing.name}?"
			description="The {kind_word} and its whole history are removed, for you and for any member it was published to. Issues are not touched."
			confirm_label="Delete {kind_word}"
			destructive
			onconfirm={remove}
		/>
		<ConfirmDialog
			bind:open={confirm_unpublish}
			title="Unpublish {thing.name}?"
			description={thing.mine
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
	.sf-body {
		margin: var(--s-4) 0 var(--s-6);
	}
	.sec-hd h2.lbl {
		margin: 0;
	}
	.sec-hd a.lbl {
		color: inherit;
	}
</style>
