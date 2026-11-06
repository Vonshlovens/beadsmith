<script lang="ts">
	/**
	 * The project catalogue, as a table: the question here is "how do my
	 * projects compare?" (docs/design-standards.md §1), so each project is a
	 * row with the same columns, counts right-aligned and sortable. Recent
	 * changes moved to the top bar's drawer.
	 */
	import CaretUpDownIcon from 'phosphor-svelte/lib/CaretUpDownIcon';
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';
	import CaretUpIcon from 'phosphor-svelte/lib/CaretUpIcon';
	import { goto, refreshAll } from '$app/navigation';
	import { navigating, page } from '$app/state';
	import EmptyState from '#lib/components/empty-state.svelte';
	import PageHeader from '#lib/components/page-header.svelte';
	import SkeletonRows from '#lib/components/skeleton-rows.svelte';
	import { api, errorMessage } from '#lib/client/api.js';
	import { absoluteStamp, meterSegments, relativeLong } from '#lib/client/format.js';
	import { useHotkeys } from '#lib/client/hotkeys.svelte.js';
	import { stepFocus } from '#lib/client/list-focus.js';
	import { projectList } from '#lib/client/projects.svelte.js';
	import { sortProjects, type ProjectSortKey } from '#lib/client/project-sort.js';
	import { tip } from '#lib/client/tooltip.js';
	import { PRODUCT_NAME } from '#lib/product.js';
	import { toast } from 'svelte-sonner';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const projects = $derived(projectList());
	const total_issues = $derived(
		projects.reduce((sum, project) => sum + (project.counts?.total ?? 0), 0)
	);
	const loading = $derived(navigating.to?.route.id === page.route.id);
	let refreshing = $state(false);
	let table_el = $state<HTMLTableElement | null>(null);

	let sort_key = $state<ProjectSortKey>('last_activity');
	let sort_desc = $state(true);
	const rows = $derived(sortProjects(projects, sort_key, sort_desc));

	interface Column {
		key: ProjectSortKey;
		label: string;
		num: boolean;
		/** Column a phone drops: the row keeps its name, open and blocked counts, and recency. */
		wide?: boolean;
	}

	const COLUMNS: Column[] = [
		{ key: 'name', label: 'Project', num: false },
		{ key: 'open', label: 'Open', num: true },
		{ key: 'in_progress', label: 'In progress', num: true, wide: true },
		{ key: 'blocked', label: 'Blocked', num: true },
		{ key: 'closed', label: 'Closed', num: true, wide: true },
		{ key: 'total', label: 'Total', num: true, wide: true },
		{ key: 'last_activity', label: 'Last activity', num: false }
	];

	function sortBy(key: ProjectSortKey) {
		if (sort_key === key) {
			sort_desc = !sort_desc;
			return;
		}
		sort_key = key;
		// Names read A→Z; counts and recency read biggest or newest first.
		sort_desc = key !== 'name';
	}

	function ariaSort(key: ProjectSortKey): 'ascending' | 'descending' | 'none' {
		if (sort_key !== key) return 'none';
		return sort_desc ? 'descending' : 'ascending';
	}

	useHotkeys(() => [
		{
			keys: ['j', 'ArrowDown'],
			label: 'Next project',
			group: 'Lists',
			run: () => stepFocus(table_el, 'a.p-link', 1)
		},
		{
			keys: ['k', 'ArrowUp'],
			label: 'Previous project',
			group: 'Lists',
			run: () => stepFocus(table_el, 'a.p-link', -1)
		}
	]);

	/** The whole row opens the project; the name link stays the keyboard target. */
	function openRow(event: MouseEvent, id: string) {
		const target = event.target as HTMLElement;
		if (target.closest('a, button') || window.getSelection()?.toString()) return;
		if (event.metaKey || event.ctrlKey) {
			window.open(`/p/${id}`, '_blank', 'noopener');
			return;
		}
		void goto(`/p/${id}`);
	}

	async function refreshProjects(): Promise<void> {
		if (refreshing) {
			return;
		}
		refreshing = true;
		try {
			await api.refreshProjects();
			await refreshAll();
		} catch (error) {
			toast.error('Could not refresh projects', { description: errorMessage(error) });
		} finally {
			refreshing = false;
		}
	}
</script>

<svelte:head><title>Projects · {PRODUCT_NAME}</title></svelte:head>

<div class="wrap projects">
	<PageHeader
		title="Projects"
		meta="{projects.length} · {total_issues} issues"
		meta_label="{projects.length} projects, {total_issues} issues tracked"
		onrefresh={refreshProjects}
		{refreshing}
	/>

	{#if data.projects_error}
		<div class="banner banner-err mb-5" role="alert">
			<i class="dot dot-blocked" style="margin-top:5px" aria-hidden="true"></i>
			<div class="banner-bd">
				<b>The project list could not be loaded.</b>
				<div class="mt-2">{data.projects_error}</div>
			</div>
			<div class="banner-acts">
				<button class="btn btn-sm" type="button" disabled={refreshing} onclick={refreshProjects}
					>{refreshing ? 'Retrying…' : 'Retry now'}</button
				>
			</div>
		</div>
	{/if}

	{#if loading}
		<SkeletonRows rows={4} label="Loading projects" />
	{:else if data.projects_error}
		<p class="hint">Project discovery is unavailable until the Dolt connection is restored.</p>
	{:else if projects.length === 0}
		<EmptyState
			title="No projects yet"
			description="No Beads databases are reachable from the configured Dolt server. A database appears here after `bd init` creates it; refresh to look again."
		/>
	{:else}
		<div class="tbl-scroll">
			<table class="tbl ptbl" bind:this={table_el}>
				<caption class="sr-only">Projects, sorted by {sort_key.replace('_', ' ')}</caption>
				<thead>
					<tr>
						{#each COLUMNS as column (column.key)}
							<th
								scope="col"
								class:t-num={column.num}
								class:is-wide={column.wide}
								class:t-name={column.key === 'name'}
								aria-sort={ariaSort(column.key)}
							>
								<button
									class="ph-sort"
									type="button"
									onclick={() => sortBy(column.key)}
									{@attach tip(`Sort by ${column.label.toLowerCase()}`)}
								>
									<span>{column.label}</span>
									<span class="ph-arrow" aria-hidden="true"
										>{#if sort_key !== column.key}<CaretUpDownIcon
												size={10}
											/>{:else if sort_desc}<CaretDownIcon
												size={10}
												weight="bold"
											/>{:else}<CaretUpIcon size={10} weight="bold" />{/if}</span
									>
								</button>
							</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each rows as project (project.id)}
						{@const counts = project.counts}
						{@const segments = meterSegments(counts)}
						<tr class="p-row" onclick={(event) => openRow(event, project.id)}>
							<td class="t-name">
								<a class="p-link" href="/p/{project.id}">{project.name}</a>
								{#if project.dolt_database && project.dolt_database !== project.name}
									<span class="p-db">{project.dolt_database}</span>
								{/if}
								{#if segments.length > 0 && counts}
									<span
										class="p-meter"
										role="img"
										aria-label="{counts.open} open, {counts.in_progress} in progress, {counts.blocked} blocked, {counts.closed} closed"
									>
										{#each segments as segment (segment.key)}
											<span style="width:{segment.pct}%;background:{segment.color}"></span>
										{/each}
									</span>
								{/if}
							</td>
							{#if counts}
								<td class="t-num" class:is-zero={counts.open === 0}>{counts.open}</td>
								<td class="t-num is-wide" class:is-zero={counts.in_progress === 0}
									>{counts.in_progress}</td
								>
								<td
									class="t-num"
									class:is-zero={counts.blocked === 0}
									class:is-blocked={counts.blocked > 0}>{counts.blocked}</td
								>
								<td class="t-num is-wide" class:is-zero={counts.closed === 0}>{counts.closed}</td>
								<td class="t-num is-wide t-total">{counts.total}</td>
							{:else}
								<td class="t-missing" colspan="5"
									>Counts unavailable: this database could not be read.</td
								>
							{/if}
							<td class="t-when">
								{#if project.last_activity}
									<time
										datetime={project.last_activity}
										{@attach tip(absoluteStamp(project.last_activity))}
										>{relativeLong(project.last_activity)}</time
									>
								{:else}
									<span class="faint">No activity yet</span>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>

<style>
	.projects {
		max-width: 1100px;
	}
	.tbl-scroll {
		overflow-x: auto;
		overscroll-behavior-x: contain;
	}
	.ptbl {
		min-width: 560px;
	}
	.ptbl thead th {
		padding: 0 0 var(--s-2);
		border-bottom: 2px solid var(--rule);
	}
	.ptbl thead th.t-num {
		text-align: right;
	}
	.ph-sort {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		height: 28px;
		padding: 0 var(--s-3);
		border: 0;
		border-radius: var(--r-1);
		background: none;
		font: inherit;
		color: var(--tx-dim);
		cursor: pointer;
		white-space: nowrap;
	}
	th.t-num .ph-sort {
		justify-content: flex-end;
	}
	.ph-sort:hover,
	.ph-sort:focus-visible {
		color: var(--tx-hi);
		background: var(--s2);
	}
	.ph-arrow {
		font-size: 9px;
		color: var(--tx-faint);
	}
	th[aria-sort='ascending'] .ph-sort,
	th[aria-sort='descending'] .ph-sort {
		color: var(--tx-hi);
	}
	th[aria-sort='ascending'] .ph-arrow,
	th[aria-sort='descending'] .ph-arrow {
		color: var(--em-500);
	}

	.p-row {
		cursor: pointer;
	}
	.ptbl tbody td {
		height: 52px;
	}
	.t-name {
		width: 40%;
	}
	.p-link {
		display: block;
		color: var(--tx-hi);
		font-weight: 600;
		font-size: var(--t-base);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.p-link:hover {
		text-decoration: underline;
		text-decoration-color: var(--em-500);
	}
	.p-db {
		display: block;
		font-size: var(--t-xs);
		color: var(--tx-dim);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	/* Composition at a glance: the same order and colours as the columns. */
	.p-meter {
		display: flex;
		gap: 1px;
		height: 3px;
		max-width: 220px;
		margin-top: 6px;
		overflow: hidden;
		border-radius: 1px;
		background: var(--s4);
	}
	.p-meter span {
		display: block;
	}
	.ptbl td.t-num {
		color: var(--tx);
		font-size: var(--t-base);
	}
	.ptbl td.t-num.is-zero {
		color: var(--tx-faint);
	}
	.ptbl td.t-num.is-blocked {
		color: var(--danger-tx);
		font-weight: 600;
	}
	.ptbl .t-total {
		color: var(--tx-hi);
	}
	.t-missing {
		color: var(--tx-dim);
		font-size: var(--t-sm);
	}
	.t-when {
		white-space: nowrap;
		color: var(--tx-mid);
		font-size: var(--t-sm);
	}
	.faint {
		color: var(--tx-dim);
	}
	@media (max-width: 640px) {
		.ptbl {
			min-width: 0;
		}
		.ptbl .is-wide {
			display: none;
		}
		.ph-sort {
			padding: 0 var(--s-2);
		}
		.ptbl tbody td {
			padding: 0 var(--s-2);
		}
	}
</style>
