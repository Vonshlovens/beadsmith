<script lang="ts">
	/**
	 * Fleet view of agent missions across projects; each row opens its thread.
	 * A kind filter separates ralph loops from one-shot runs. While any run
	 * is working the list re-reads itself, so statuses move without a manual
	 * refresh; it pauses in a background tab.
	 */
	import { invalidate, refreshAll } from '$app/navigation';
	import EmptyState from '#lib/components/empty-state.svelte';
	import MissionsList from '#lib/components/missions-list.svelte';
	import PageHeader from '#lib/components/page-header.svelte';
	import { isBusyStatus } from '#lib/client/agent.js';
	import {
		filterMissions,
		MISSION_KIND_LABEL,
		MISSION_KINDS,
		missionKind,
		type MissionKind
	} from '#lib/client/loop.js';
	import { tip } from '#lib/client/tooltip.js';
	import { useHotkeys } from '#lib/client/hotkeys.svelte.js';
	import { stepFocus } from '#lib/client/list-focus.js';
	import { PRODUCT_NAME } from '#lib/product.js';
	import type { Mission } from '#lib/types.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let list_el = $state<HTMLDivElement | null>(null);
	let refreshing = $state(false);
	let kind = $state<MissionKind>('all');
	/**
	 * The last list that loaded. A background re-read that fails keeps it on
	 * screen, marked as not refreshed, instead of swapping it for an error.
	 */
	let kept = $state<Mission[] | null>(null);
	$effect.pre(() => {
		if (!data.error) kept = data.missions;
	});
	const stale = $derived(data.error !== null && kept !== null && kept.length > 0);
	const missions = $derived(stale && kept ? kept : data.missions);
	const working = $derived(missions.filter((mission) => isBusyStatus(mission.status)).length);
	const loops_running = $derived(
		missions.filter((mission) => missionKind(mission) === 'loop' && isBusyStatus(mission.status))
			.length
	);
	const has_loops = $derived(missions.some((mission) => missionKind(mission) === 'loop'));
	const shown = $derived(filterMissions(missions, kind));
	const meta = $derived(
		[
			kind === 'all' ? String(missions.length) : `${shown.length} of ${missions.length}`,
			working > 0 ? `${working} working` : '',
			loops_running > 0 ? `${loops_running} ${loops_running === 1 ? 'loop' : 'loops'}` : ''
		]
			.filter(Boolean)
			.join(' · ')
	);

	function kindCount(value: MissionKind): number {
		return filterMissions(missions, value).length;
	}

	/** Arrow keys move the choice, as in any radio group. */
	function onKindKey(event: KeyboardEvent) {
		const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
		if (step === 0) return;
		event.preventDefault();
		const next =
			MISSION_KINDS[
				(MISSION_KINDS.indexOf(kind) + step + MISSION_KINDS.length) % MISSION_KINDS.length
			];
		kind = next;
		(event.currentTarget as HTMLElement)
			.querySelector<HTMLButtonElement>(`[data-kind="${next}"]`)
			?.focus();
	}

	/** How often a list with working runs re-reads, as a chat's mission cards do. */
	const FOLLOW_MS = 12_000;

	$effect(() => {
		if (working === 0 || (data.error && !stale)) {
			return;
		}
		const poll = setInterval(() => {
			if (document.visibilityState === 'visible' && !refreshing) {
				void invalidate('app:missions');
			}
		}, FOLLOW_MS);
		return () => clearInterval(poll);
	});

	async function refresh() {
		refreshing = true;
		try {
			await refreshAll();
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
		{meta}
		meta_label="{shown.length} of {missions.length} runs across all projects, {working} working, {loops_running} loops running"
		onrefresh={refresh}
		{refreshing}
	>
		{#snippet actions()}
			{#if has_loops}
				<!-- svelte-ignore a11y_interactive_supports_focus -->
				<div class="kind" role="radiogroup" aria-label="Kind of run" onkeydown={onKindKey}>
					{#each MISSION_KINDS as value (value)}
						<button
							type="button"
							role="radio"
							data-kind={value}
							aria-checked={kind === value}
							tabindex={kind === value ? 0 : -1}
							class:is-on={kind === value}
							{@attach tip(`${kindCount(value)} runs`)}
							onclick={() => (kind = value)}>{MISSION_KIND_LABEL[value]}</button
						>
					{/each}
				</div>
			{/if}
		{/snippet}
	</PageHeader>

	{#if stale}
		<div class="banner banner-warn" role="status">
			<i class="dot dot-in_progress" style="margin-top:5px" aria-hidden="true"></i>
			<div class="banner-bd">
				<b>These statuses may be out of date.</b>
				<div class="mt-2">The list could not be refreshed: {data.error}</div>
			</div>
			<div class="banner-acts">
				<button class="btn btn-sm" type="button" onclick={refresh} disabled={refreshing}
					>Retry now</button
				>
			</div>
		</div>
	{/if}
	{#if data.error && !stale}
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
	{:else if missions.length === 0}
		<EmptyState
			title="No agent runs yet"
			description="File, Tackle and agent threads land here, one row per run."
		>
			{#snippet actions()}
				<a class="btn btn-sm" href="/projects">Open projects</a>
			{/snippet}
		</EmptyState>
	{:else if shown.length === 0}
		<EmptyState
			title={kind === 'loop' ? 'No loops in these runs' : 'No one-shot runs in these runs'}
			description="The filter shows {MISSION_KIND_LABEL[
				kind
			].toLowerCase()} only, from the latest {missions.length} runs."
		>
			{#snippet actions()}
				<button class="btn btn-sm" type="button" onclick={() => (kind = 'all')}
					>Show all runs</button
				>
			{/snippet}
		</EmptyState>
	{:else}
		<div bind:this={list_el}>
			<MissionsList missions={shown} show_project />
		</div>
	{/if}
</div>

<style>
	.missions {
		max-width: 1480px;
	}
	/* The activity log's project picker, so filters read alike across pages. */
	.kind {
		display: flex;
		gap: 2px;
		padding: 2px;
		border: 1px solid var(--line);
		border-radius: var(--r-1);
		background: var(--s2);
	}
	.kind button {
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
	.kind button:hover {
		color: var(--tx-hi);
	}
	.kind button:focus-visible {
		outline: 2px solid var(--em-500);
		outline-offset: 1px;
	}
	.kind button.is-on {
		background: var(--em-wash);
		color: var(--em-300);
	}
	@media (pointer: coarse) {
		.kind button {
			height: 32px;
			padding: 0 12px;
		}
	}
</style>
