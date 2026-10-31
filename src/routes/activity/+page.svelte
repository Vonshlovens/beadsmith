<script lang="ts">
	/** Activity log: the same thread as the home rail, at full length. */
	import { invalidateAll } from '$app/navigation';
	import ActivityFeed from '$lib/components/activity-feed.svelte';
	import EmptyState from '$lib/components/empty-state.svelte';
	import PageHeader from '$lib/components/page-header.svelte';
	import { PRODUCT_NAME } from '$lib/product';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let refreshing = $state(false);
	/** Project filter; null shows every project. */
	let only = $state<string | null>(null);

	const projects = $derived.by(() => {
		const counts = new Map<string, { name: string; count: number }>();
		for (const event of data.events) {
			const entry = counts.get(event.project_id) ?? { name: event.project_name, count: 0 };
			entry.count += 1;
			counts.set(event.project_id, entry);
		}
		return [...counts.entries()].map(([id, entry]) => ({ id, ...entry }));
	});
	const shown = $derived(
		only === null ? data.events : data.events.filter((event) => event.project_id === only)
	);

	async function refresh() {
		refreshing = true;
		try {
			await invalidateAll();
		} finally {
			refreshing = false;
		}
	}
</script>

<svelte:head><title>Activity · {PRODUCT_NAME}</title></svelte:head>

<div class="wrap activity">
	<PageHeader
		title="Activity log"
		meta={String(shown.length)}
		meta_label="{shown.length} events"
		onrefresh={refresh}
		{refreshing}
	>
		{#snippet actions()}
			{#if projects.length > 1}
				<div class="only" role="radiogroup" aria-label="Project">
					<button
						type="button"
						role="radio"
						aria-checked={only === null}
						class:is-on={only === null}
						onclick={() => (only = null)}>All</button
					>
					{#each projects as project (project.id)}
						<button
							type="button"
							role="radio"
							aria-checked={only === project.id}
							class:is-on={only === project.id}
							title="{project.count} events"
							onclick={() => (only = project.id)}>{project.name}</button
						>
					{/each}
				</div>
			{/if}
		{/snippet}
	</PageHeader>

	{#if data.error}
		<div class="banner banner-err" role="alert">
			<i class="dot dot-blocked" style="margin-top:5px" aria-hidden="true"></i>
			<div class="banner-bd">
				<b>The activity log could not be loaded.</b>
				<div class="mt-2">{data.error}</div>
			</div>
			<div class="banner-acts">
				<button class="btn btn-sm" type="button" onclick={refresh}>Retry now</button>
			</div>
		</div>
	{:else if data.events.length === 0}
		<EmptyState
			title="Nothing has happened yet"
			description="Creates, closes, status changes and comments from every project land here."
		>
			{#snippet actions()}
				<a class="btn btn-sm" href="/">Open projects</a>
			{/snippet}
		</EmptyState>
	{:else}
		<div class="panel log">
			<ActivityFeed events={shown} show_project={only === null} />
		</div>
	{/if}
</div>

<style>
	.activity {
		max-width: 1080px;
	}
	.log {
		padding: var(--s-3) var(--s-4);
	}
	.only {
		display: flex;
		flex-wrap: wrap;
		gap: 2px;
		padding: 2px;
		border: 1px solid var(--line);
		border-radius: var(--r-1);
		background: var(--s2);
	}
	.only button {
		height: 22px;
		padding: 0 8px;
		border: 0;
		border-radius: 2px;
		background: none;
		color: var(--tx-dim);
		font: inherit;
		font-size: var(--t-xs);
		cursor: pointer;
	}
	.only button:hover {
		color: var(--tx-hi);
	}
	.only button.is-on {
		background: var(--em-wash);
		color: var(--em-300);
	}
</style>
