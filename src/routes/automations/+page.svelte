<script lang="ts">
	/**
	 * Scheduled launches (ADR-0019 rule 7), across projects or one project's
	 * (`?project=`). Each row answers "what runs when, and how did the last
	 * one go": schedule in words, next run, last result linked to its mission.
	 * Admins create one, run it now and pause it here; the row opens its page
	 * with the full history.
	 */
	import { refreshAll } from '$app/navigation';
	import PauseIcon from 'phosphor-svelte/lib/PauseIcon';
	import PlayIcon from 'phosphor-svelte/lib/PlayIcon';
	import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
	import RocketLaunchIcon from 'phosphor-svelte/lib/RocketLaunchIcon';
	import AutomationDialog from '#lib/components/automation-dialog.svelte';
	import EmptyState from '#lib/components/empty-state.svelte';
	import PageHeader from '#lib/components/page-header.svelte';
	import type { AutomationView } from '#lib/automations.js';
	import { runAutomationNow, setAutomationEnabled } from '#lib/client/automation-actions.js';
	import {
		AUTOMATION_OUTCOME_LABEL,
		automationOutcomeKey,
		describeSchedule,
		formatSlot,
		launchSummary,
		relativeUntil
	} from '#lib/client/automations.js';
	import { missionThreadHref } from '#lib/client/first-mate.js';
	import { relativeShort } from '#lib/client/format.js';
	import { useHotkeys } from '#lib/client/hotkeys.svelte.js';
	import { stepFocus } from '#lib/client/list-focus.js';
	import { currentViewer, projectList } from '#lib/client/projects.svelte.js';
	import { tip } from '#lib/client/tooltip.js';
	import { PRODUCT_NAME } from '#lib/product.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let list_el = $state<HTMLUListElement | null>(null);
	let refreshing = $state(false);
	let creating = $state(false);
	/** Rows with a request in flight, so a double press cannot fire twice. */
	let busy = $state<Record<string, boolean>>({});

	const can_manage = $derived(currentViewer()?.role === 'admin');
	const filter_name = $derived(
		data.project === undefined
			? undefined
			: (projectList().find((p) => p.id === data.project)?.name ?? data.project)
	);
	const paused = $derived(data.automations.filter((a) => !a.enabled).length);
	const meta = $derived(
		[String(data.automations.length), paused > 0 ? `${paused} paused` : '']
			.filter(Boolean)
			.join(' · ')
	);

	async function refresh() {
		refreshing = true;
		try {
			await refreshAll();
		} finally {
			refreshing = false;
		}
	}

	async function act(automation: AutomationView, action: () => Promise<unknown>) {
		if (busy[automation.id]) return;
		busy[automation.id] = true;
		try {
			await action();
		} finally {
			busy[automation.id] = false;
		}
	}

	useHotkeys(() => [
		{
			keys: ['j', 'ArrowDown'],
			label: 'Next automation',
			group: 'Lists',
			run: () => stepFocus(list_el, 'a.a-main', 1)
		},
		{
			keys: ['k', 'ArrowUp'],
			label: 'Previous automation',
			group: 'Lists',
			run: () => stepFocus(list_el, 'a.a-main', -1)
		},
		{
			keys: ['n'],
			label: 'New automation',
			group: 'Agent',
			when: () => can_manage && !creating,
			run: () => (creating = true)
		}
	]);
</script>

<svelte:head><title>Automations · {PRODUCT_NAME}</title></svelte:head>

<div class="wrap is-wide automations">
	<PageHeader
		title={filter_name === undefined ? 'Automations' : `Automations · ${filter_name}`}
		{meta}
		meta_label="{data.automations.length} automations, {paused} paused"
		onrefresh={refresh}
		{refreshing}
	>
		{#snippet actions()}
			{#if filter_name !== undefined}
				<a class="btn btn-sm btn-ghost" href="/automations">All projects</a>
			{/if}
			{#if can_manage}
				<button
					class="btn btn-sm btn-primary"
					type="button"
					aria-keyshortcuts="n"
					onclick={() => (creating = true)}
				>
					<PlusIcon size={13} aria-hidden="true" />New automation
				</button>
			{/if}
		{/snippet}
	</PageHeader>

	{#if data.error}
		<div class="banner banner-err" role="alert">
			<i class="dot dot-blocked" style="margin-top:5px" aria-hidden="true"></i>
			<div class="banner-bd">
				<b>Automations could not be loaded.</b>
				<div class="mt-2">{data.error}</div>
			</div>
			<div class="banner-acts">
				<button class="btn btn-sm" type="button" onclick={refresh}>Retry now</button>
			</div>
		</div>
	{:else if data.automations.length === 0}
		<EmptyState
			title={filter_name === undefined ? 'No automations yet' : `No automations for ${filter_name}`}
			description={can_manage
				? 'Schedule a ralph loop, such as a nightly build of an epic. Each run lands in Missions.'
				: 'Admins schedule ralph loops here, such as a nightly build. Each run lands in Missions.'}
		>
			{#snippet actions()}
				{#if can_manage}
					<button class="btn btn-sm btn-primary" type="button" onclick={() => (creating = true)}
						>New automation</button
					>
				{/if}
				{#if filter_name !== undefined}
					<a class="btn btn-sm" href="/automations">Show all projects</a>
				{/if}
			{/snippet}
		</EmptyState>
	{:else}
		<ul class="list panel" aria-label="Automations" bind:this={list_el}>
			{#each data.automations as automation (automation.id)}
				{@const words = describeSchedule(automation.cron)}
				{@const last = automation.last_run}
				<li class="a-row" class:is-paused={!automation.enabled}>
					<a class="a-main" href="/automations/{automation.id}">
						<span class="a-name">{automation.name}</span>
						<span class="a-what">{launchSummary(automation.launch)}</span>
					</a>
					{#if filter_name === undefined}
						<a class="a-proj" href="/automations?project={automation.project_id}"
							>{automation.project_name}</a
						>
					{/if}
					<span class="a-when" {@attach tip(`${automation.cron} · ${automation.time_zone}`)}>
						{#if words}{words}{:else}<code class="mono-num">{automation.cron}</code>{/if}
					</span>
					<span class="a-next mono-num">
						{#if !automation.enabled}
							<span class="badge badge-deferred" {@attach tip(automation.paused_reason)}
								><i class="dot dot-deferred" aria-hidden="true"></i>Paused</span
							>
						{:else if automation.next_run}
							<span {@attach tip(formatSlot(automation.next_run, automation.time_zone))}
								>{relativeUntil(automation.next_run)}</span
							>
						{:else}
							<span class="faint">—</span>
						{/if}
					</span>
					<span class="a-last">
						{#if last}
							{@const key = automationOutcomeKey(last.outcome)}
							{#if last.mission_id}
								<a
									class="badge badge-{key}"
									href={missionThreadHref(automation.project_id, last.mission_id)}
									{@attach tip(`Open the mission · ${formatSlot(last.slot, automation.time_zone)}`)}
									><i class="dot dot-{key}" aria-hidden="true"></i>{AUTOMATION_OUTCOME_LABEL[
										last.outcome
									]}</a
								>
							{:else}
								<span class="badge badge-{key}" {@attach tip(last.message)}
									><i class="dot dot-{key}" aria-hidden="true"></i>{AUTOMATION_OUTCOME_LABEL[
										last.outcome
									]}</span
								>
							{/if}
							<span class="faint mono-num">{relativeShort(last.slot)}</span>
						{:else}
							<span class="faint">Not run yet</span>
						{/if}
					</span>
					{#if can_manage}
						<span class="a-acts">
							<button
								class="btn btn-sm btn-ghost"
								type="button"
								disabled={busy[automation.id]}
								onclick={() => act(automation, () => runAutomationNow(automation))}
							>
								<RocketLaunchIcon size={13} aria-hidden="true" />Run now
							</button>
							<button
								class="btn btn-sm btn-ghost btn-icon"
								type="button"
								disabled={busy[automation.id]}
								aria-label={automation.enabled
									? `Pause ${automation.name}`
									: `Resume ${automation.name}`}
								{@attach tip(automation.enabled ? 'Pause the schedule' : 'Resume the schedule')}
								onclick={() =>
									act(automation, () => setAutomationEnabled(automation, !automation.enabled))}
							>
								{#if automation.enabled}<PauseIcon size={13} />{:else}<PlayIcon size={13} />{/if}
							</button>
						</span>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>

{#if can_manage}
	<AutomationDialog bind:open={creating} project_id={data.project} />
{/if}

<style>
	.automations {
		max-width: 1480px;
	}
	.list {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.a-row {
		display: grid;
		grid-template-columns:
			minmax(0, 1fr) minmax(0, 10em) minmax(0, 13em) 6.5em minmax(0, 10em)
			auto;
		align-items: center;
		gap: var(--s-3);
		min-height: 44px;
		padding: 4px var(--s-3) 4px var(--s-4);
		border-bottom: 1px solid var(--line);
		font-size: var(--t-xs);
	}
	.list:not(:has(.a-proj)) .a-row {
		grid-template-columns: minmax(0, 1fr) minmax(0, 13em) 6.5em minmax(0, 10em) auto;
	}
	.a-row:last-child {
		border-bottom: 0;
	}
	.a-row:hover,
	.a-row:focus-within {
		background: var(--s3);
	}
	.a-main {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
		color: inherit;
		outline: none;
	}
	.a-main:hover {
		text-decoration: none;
	}
	.a-main:hover .a-name {
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.a-main:focus-visible {
		box-shadow: -2px 0 0 var(--em-500);
	}
	.a-name {
		color: var(--tx-hi);
		font-size: var(--t-sm);
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.a-what,
	.a-proj,
	.a-when {
		color: var(--tx-dim);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.a-when {
		color: var(--tx-mid);
	}
	.a-next {
		color: var(--tx-mid);
	}
	.a-last {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		min-width: 0;
	}
	.a-last a.badge:hover {
		text-decoration: none;
		filter: brightness(1.1);
	}
	.a-last a.badge:focus-visible {
		outline: 2px solid var(--em-500);
		outline-offset: 1px;
	}
	.a-acts {
		display: inline-flex;
		gap: 2px;
		justify-content: flex-end;
	}
	.a-acts :global(svg) {
		flex: none;
	}
	/* Paused stays readable; the badge says so, the name just steps back. */
	.is-paused .a-name {
		color: var(--tx-mid);
	}
	@media (max-width: 860px) {
		.a-row,
		.list:not(:has(.a-proj)) .a-row {
			grid-template-columns: minmax(0, 1fr) auto;
			row-gap: 4px;
			padding: 8px var(--s-3);
		}
		.a-main {
			grid-column: 1 / -1;
		}
		.a-proj {
			display: none;
		}
		.a-when {
			grid-column: 1;
		}
		.a-next {
			grid-column: 2;
			justify-self: end;
		}
		.a-last {
			grid-column: 1;
		}
		.a-acts {
			grid-column: 2;
		}
	}
</style>
