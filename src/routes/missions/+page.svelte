<script lang="ts">
	/** Fleet view of agent missions across projects; each row opens its thread. */
	import { invalidateAll } from '$app/navigation';
	import EmptyState from '$lib/components/empty-state.svelte';
	import MissionsList from '$lib/components/missions-list.svelte';
	import PageHeader from '$lib/components/page-header.svelte';
	import { isBusyStatus } from '$lib/client/agent';
	import { useHotkeys } from '$lib/client/hotkeys.svelte';
	import { stepFocus } from '$lib/client/list-focus';
	import { PRODUCT_NAME } from '$lib/product';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let list_el = $state<HTMLDivElement | null>(null);
	let refreshing = $state(false);
	const working = $derived(data.missions.filter((mission) => isBusyStatus(mission.status)).length);

	async function refresh() {
		refreshing = true;
		try {
			await invalidateAll();
		} finally {
			refreshing = false;
		}
	}

	useHotkeys(() => [
		{
			keys: ['j', 'ArrowDown'],
			label: 'Next mission',
			group: 'Lists',
			run: () => stepFocus(list_el, 'a.f-main', 1)
		},
		{
			keys: ['k', 'ArrowUp'],
			label: 'Previous mission',
			group: 'Lists',
			run: () => stepFocus(list_el, 'a.f-main', -1)
		}
	]);
</script>

<svelte:head><title>Missions · {PRODUCT_NAME}</title></svelte:head>

<div class="wrap is-wide missions">
	<PageHeader
		title="Missions"
		meta={working > 0
			? `${data.missions.length} · ${working} working`
			: String(data.missions.length)}
		meta_label="{data.missions.length} runs across all projects, {working} working"
		onrefresh={refresh}
		{refreshing}
	/>

	{#if data.error}
		<div class="banner banner-err" role="alert">
			<i class="dot dot-blocked" style="margin-top:5px" aria-hidden="true"></i>
			<div class="banner-bd">
				<b>Missions could not be loaded.</b>
				<div class="mt-2">{data.error}</div>
			</div>
			<div class="banner-acts">
				<button class="btn btn-sm" type="button" onclick={refresh}>Retry now</button>
			</div>
		</div>
	{:else if data.missions.length === 0}
		<EmptyState
			title="No agent runs yet"
			description="File, Tackle and agent threads land here, one row per run."
		>
			{#snippet actions()}
				<a class="btn btn-sm" href="/">Open projects</a>
			{/snippet}
		</EmptyState>
	{:else}
		<div bind:this={list_el}>
			<MissionsList missions={data.missions} show_project />
		</div>
	{/if}
</div>

<style>
	.missions {
		max-width: 1480px;
	}
</style>
