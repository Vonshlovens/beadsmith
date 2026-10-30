<script lang="ts">
	/** Beads projects and their recent activity. */
	import { invalidateAll } from '$app/navigation';
	import { navigating, page } from '$app/state';
	import ActivityFeed from '$lib/components/activity-feed.svelte';
	import EmptyState from '$lib/components/empty-state.svelte';
	import PageHeader from '$lib/components/page-header.svelte';
	import SkeletonCards from '$lib/components/skeleton-cards.svelte';
	import { api, errorMessage } from '$lib/client/api';
	import { meterSegments, projectHealth, relativeLong } from '$lib/client/format';
	import { useHotkeys } from '$lib/client/hotkeys.svelte';
	import { stepFocus } from '$lib/client/list-focus';
	import { projectList } from '$lib/client/projects.svelte';
	import { PRODUCT_NAME } from '$lib/product';
	import { toast } from 'svelte-sonner';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const projects = $derived(projectList());
	const total_issues = $derived(
		projects.reduce((sum, project) => sum + (project.counts?.total ?? 0), 0)
	);
	const loading = $derived(navigating.to?.route.id === page.route.id);
	let refreshing = $state(false);
	let grid_el = $state<HTMLDivElement | null>(null);

	useHotkeys(() => [
		{
			keys: ['j', 'ArrowDown'],
			label: 'Next project',
			group: 'Lists',
			run: () => stepFocus(grid_el, 'a.pcard', 1)
		},
		{
			keys: ['k', 'ArrowUp'],
			label: 'Previous project',
			group: 'Lists',
			run: () => stepFocus(grid_el, 'a.pcard', -1)
		}
	]);

	async function refreshProjects(): Promise<void> {
		if (refreshing) {
			return;
		}
		refreshing = true;
		try {
			await api.refreshProjects();
			await invalidateAll();
		} catch (error) {
			toast.error('Could not refresh projects', { description: errorMessage(error) });
		} finally {
			refreshing = false;
		}
	}
</script>

<svelte:head><title>Projects · {PRODUCT_NAME}</title></svelte:head>

<div class="wrap is-wide home">
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

	<div class="cols">
		<div>
			{#if loading}
				<SkeletonCards count={3} />
			{:else if data.projects_error}
				<p class="hint">Project discovery is unavailable until the Dolt connection is restored.</p>
			{:else if projects.length === 0}
				<EmptyState
					title="No projects yet"
					description="No Beads databases are reachable from the configured Dolt server."
				/>
			{:else}
				<div class="pgrid mb-6" bind:this={grid_el}>
					{#each projects as project (project.id)}
						{@const health = projectHealth(project)}
						{@const segments = meterSegments(project.counts)}
						{@const counts = project.counts}
						<a class="pcard" href="/p/{project.id}">
							<div class="pcard-hd">
								<div style="min-width:0">
									<div class="h3">{project.name}</div>
									{#if project.dolt_database && project.dolt_database !== project.name}
										<div class="dbline" title="Dolt database">{project.dolt_database}</div>
									{/if}
								</div>
								{#if health}
									<span class="health {health.cls}">
										<i class="dot {health.dot}" aria-hidden="true"></i>{health.label}
									</span>
								{/if}
							</div>

							{#if counts}
								{#if segments.length > 0}
									<div
										class="meter"
										role="img"
										aria-label="{counts.open} open, {counts.in_progress} in progress, {counts.blocked} blocked, {counts.closed} closed"
									>
										{#each segments as segment (segment.key)}
											<span style="width:{segment.pct}%;background:{segment.color}"></span>
										{/each}
									</div>
								{/if}
								<div class="cts">
									<span class="ct" title="{counts.open} open"
										><i class="dot dot-open" aria-hidden="true"></i><b>{counts.open}</b><span
											class="ct-w">open</span
										></span
									>
									<span class="ct" title="{counts.in_progress} in progress"
										><i class="dot dot-in_progress" aria-hidden="true"></i><b
											>{counts.in_progress}</b
										><span class="ct-w">active</span></span
									>
									<span class="ct" title="{counts.blocked} blocked"
										><i class="dot dot-blocked" aria-hidden="true"></i><b>{counts.blocked}</b><span
											class="ct-w">blocked</span
										></span
									>
									<span class="ct" title="{counts.closed} closed"
										><i class="dot dot-closed" aria-hidden="true"></i><b>{counts.closed}</b><span
											class="ct-w">closed</span
										></span
									>
									<span class="ct ct-when" title={project.last_activity}
										>{relativeLong(project.last_activity)}</span
									>
								</div>
							{:else}
								<p class="hint">Issue counts could not be loaded for this project.</p>
							{/if}
						</a>
					{/each}
				</div>
			{/if}
		</div>

		<div class="sticky">
			<div class="sec-hd">
				<span class="lbl">Recent changes</span><span class="rule"></span>
				<a class="meta" href="/activity" title="Activity log (g a)">all ›</a>
			</div>
			{#if data.activity_error}
				<p class="hint">{data.activity_error}</p>
			{:else if data.events.length === 0}
				<p class="hint">Nothing has changed yet. Activity appears here as soon as it does.</p>
			{:else}
				<ActivityFeed events={data.events} show_project />
			{/if}
		</div>
	</div>
</div>

<style>
	.home {
		max-width: 1720px;
	}
	.cols {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 340px;
		gap: var(--s-5);
		align-items: start;
	}
	@media (min-width: 1600px) {
		.cols {
			grid-template-columns: minmax(0, 1fr) 420px;
		}
	}
	@media (max-width: 1120px) {
		.cols {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.pgrid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
		gap: var(--s-3);
	}
	.pcard {
		background: var(--s2);
		border: 1px solid var(--line);
		border-left-width: 2px;
		border-left-color: var(--line);
		border-radius: var(--r-2);
		padding: var(--s-3) var(--s-4);
		display: flex;
		flex-direction: column;
		gap: 10px;
		color: inherit;
		transition:
			border-color 0.12s ease,
			background 0.12s ease;
	}
	a.pcard:hover {
		text-decoration: none;
		background: var(--s3);
		border-color: var(--line-2);
		border-left-color: var(--line-2);
	}
	.pcard-hd {
		display: flex;
		align-items: flex-start;
		gap: var(--s-3);
	}
	.pcard-hd :global(.h3) {
		letter-spacing: -0.015em;
	}
	.dbline {
		font-size: var(--t-micro);
		color: var(--tx-faint);
		letter-spacing: 0.06em;
		margin-top: 3px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.pcard :global(.health) {
		margin-left: auto;
		flex: none;
		padding-top: 2px;
	}

	.meter {
		display: flex;
		height: 3px;
		border-radius: 2px;
		overflow: hidden;
		background: var(--s4);
		gap: 1px;
	}
	.meter span {
		display: block;
	}
	.cts {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-3);
		font-size: var(--t-xs);
		color: var(--tx-mid);
	}
	.ct {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-variant-numeric: tabular-nums;
	}
	.ct b {
		color: var(--tx-hi);
		font-weight: 500;
	}
	.ct-w {
		color: var(--tx-dim);
	}
	.ct-when {
		margin-left: auto;
		color: var(--tx-faint);
		font-size: var(--t-micro);
	}
	/* Narrow cards keep the beads and numbers; the words live in the title. */
	@container (max-width: 300px) {
		.ct-w {
			display: none;
		}
	}
	.pgrid > .pcard {
		container-type: inline-size;
	}

	.sticky {
		position: sticky;
		top: calc(var(--topbar-h) + var(--s-4));
	}
	@media (max-width: 1120px) {
		.sticky {
			position: static;
		}
	}
</style>
