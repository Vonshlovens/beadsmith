<script lang="ts">
	/**
	 * One automation (ADR-0019 rule 7): what it launches and when, its next
	 * fire times, and every run it fired, skipped or was refused, each linked
	 * to its mission. Admins run it now, edit its schedule and loop settings
	 * (its history stays), pause or resume it, and delete it (its missions
	 * stay in Missions).
	 */
	import { goto, refreshAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import RocketLaunchIcon from 'phosphor-svelte/lib/RocketLaunchIcon';
	import PauseIcon from 'phosphor-svelte/lib/PauseIcon';
	import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimpleIcon';
	import PlayIcon from 'phosphor-svelte/lib/PlayIcon';
	import TrashIcon from 'phosphor-svelte/lib/TrashIcon';
	import AutomationDialog from '#lib/components/automation-dialog.svelte';
	import ConfirmDialog from '#lib/components/confirm-dialog.svelte';
	import EmptyState from '#lib/components/empty-state.svelte';
	import IssueId from '#lib/components/issue-id.svelte';
	import PageHeader from '#lib/components/page-header.svelte';
	import { api, errorMessage } from '#lib/client/api.js';
	import { runAutomationNow, setAutomationEnabled } from '#lib/client/automation-actions.js';
	import {
		AUTOMATION_OUTCOME_LABEL,
		AUTOMATION_TRIGGER_LABEL,
		automationOutcomeKey,
		describeSchedule,
		formatSlot,
		launchSummary,
		relativeUntil
	} from '#lib/client/automations.js';
	import { missionThreadHref } from '#lib/client/first-mate.js';
	import { loopFlagsLine } from '#lib/client/loop.js';
	import { currentViewer } from '#lib/client/projects.svelte.js';
	import { tip } from '#lib/client/tooltip.js';
	import { PRODUCT_NAME } from '#lib/product.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let refreshing = $state(false);
	let busy = $state(false);
	let confirming = $state(false);
	let editing = $state(false);

	const can_manage = $derived(currentViewer()?.role === 'admin');
	const automation = $derived(data.detail?.automation);
	const words = $derived(automation ? describeSchedule(automation.cron) : undefined);

	async function refresh() {
		refreshing = true;
		try {
			await refreshAll();
		} finally {
			refreshing = false;
		}
	}

	async function act(action: () => Promise<unknown>) {
		if (busy) return;
		busy = true;
		try {
			await action();
		} finally {
			busy = false;
		}
	}

	async function remove() {
		if (automation === undefined) return;
		await act(async () => {
			try {
				await api.deleteAutomation(automation.id);
				toast.success(`${automation.name} deleted`, {
					description: 'Its missions stay in Missions.'
				});
				await goto('/automations');
			} catch (error) {
				toast.error('Could not delete it', { description: errorMessage(error) });
			}
		});
	}
</script>

<svelte:head><title>{automation?.name ?? 'Automation'} · {PRODUCT_NAME}</title></svelte:head>

<div class="wrap automation">
	<nav class="crumbs" aria-label="Breadcrumb">
		<a href="/automations">Automations</a>
		{#if automation}
			<span aria-hidden="true">/</span>
			<a href="/automations?project={automation.project_id}">{automation.project_name}</a>
		{/if}
	</nav>

	{#if data.error || automation === undefined}
		<PageHeader title="Automation" onrefresh={refresh} {refreshing} />
		<div class="banner banner-err" role="alert">
			<i class="dot dot-blocked" style="margin-top:5px" aria-hidden="true"></i>
			<div class="banner-bd">
				<b>This automation could not be loaded.</b>
				<div class="mt-2">{data.error ?? 'It may have been deleted.'}</div>
			</div>
			<div class="banner-acts">
				<button class="btn btn-sm" type="button" onclick={refresh}>Retry now</button>
				<a class="btn btn-sm btn-ghost" href="/automations">All automations</a>
			</div>
		</div>
	{:else}
		<PageHeader
			title={automation.name}
			meta={automation.enabled ? undefined : 'paused'}
			onrefresh={refresh}
			{refreshing}
		>
			{#snippet actions()}
				{#if can_manage}
					<button
						class="btn btn-sm btn-primary"
						type="button"
						disabled={busy}
						onclick={() => act(() => runAutomationNow(automation))}
					>
						<RocketLaunchIcon size={13} aria-hidden="true" />Run now
					</button>
					<button class="btn btn-sm" type="button" disabled={busy} onclick={() => (editing = true)}>
						<PencilSimpleIcon size={13} aria-hidden="true" />Edit
					</button>
					<button
						class="btn btn-sm"
						type="button"
						disabled={busy}
						onclick={() => act(() => setAutomationEnabled(automation, !automation.enabled))}
					>
						{#if automation.enabled}
							<PauseIcon size={13} aria-hidden="true" />Pause
						{:else}
							<PlayIcon size={13} aria-hidden="true" />Resume
						{/if}
					</button>
					<button
						class="btn btn-sm btn-ghost btn-icon"
						type="button"
						disabled={busy}
						aria-label="Delete {automation.name}"
						{@attach tip('Delete')}
						onclick={() => (confirming = true)}
					>
						<TrashIcon size={13} />
					</button>
				{/if}
			{/snippet}
		</PageHeader>

		{#if !automation.enabled}
			<div class="banner banner-warn" role="status">
				<div class="banner-bd">
					<b>Paused.</b>
					{automation.paused_reason ?? 'Its schedule fires nothing until it is resumed.'}
					Resuming does not catch up on the runs it missed.
				</div>
			</div>
		{/if}

		<dl class="facts">
			<dt>Runs</dt>
			<dd>
				{#if automation.launch.issue_id}
					<IssueId id={automation.launch.issue_id} />
				{/if}
				{launchSummary(automation.launch)}
				{#if automation.launch.loop}
					<span class="faint">· {loopFlagsLine(automation.launch.loop)}</span>
				{/if}
			</dd>
			<dt>When</dt>
			<dd>
				{words ?? 'Custom schedule'}
				<span class="faint"
					>· <code class="mono-num">{automation.cron}</code> in {automation.time_zone}</span
				>
			</dd>
			<dt>If the last run is still going</dt>
			<dd>{automation.overlap === 'queue' ? 'Run it when the last one ends' : 'Skip that run'}</dd>
			<dt>Runs on</dt>
			<dd>{automation.provider ?? 'The default runner'}</dd>
		</dl>

		<section class="sec">
			<div class="sec-hd"><span class="lbl">Next runs</span><span class="rule"></span></div>
			{#if data.detail?.upcoming.length}
				<ol class="upcoming">
					{#each data.detail.upcoming as slot (slot)}
						<li>
							<span class="mono-num">{formatSlot(slot, automation.time_zone)}</span>
							<span class="faint mono-num">{relativeUntil(slot)}</span>
						</li>
					{/each}
				</ol>
			{:else}
				<p class="hint">
					{automation.enabled ? 'No fire time in the next five years.' : 'None while paused.'}
				</p>
			{/if}
		</section>

		<section class="sec">
			<div class="sec-hd">
				<span class="lbl">History</span><span class="rule"></span>
				<span class="meta">newest first</span>
			</div>
			{#if data.detail?.runs.length}
				<div class="panel tbl-scroll">
					<table class="tbl runs">
						<thead>
							<tr>
								<th scope="col">When</th>
								<th scope="col">Trigger</th>
								<th scope="col">Outcome</th>
								<th scope="col">Detail</th>
							</tr>
						</thead>
						<tbody>
							{#each data.detail.runs as run (run.slot)}
								{@const key = automationOutcomeKey(run.outcome)}
								<tr>
									<td class="mono-num nowrap">{formatSlot(run.slot, automation.time_zone)}</td>
									<td class="nowrap">{AUTOMATION_TRIGGER_LABEL[run.trigger]}</td>
									<td>
										<span class="badge badge-{key}"
											><i class="dot dot-{key}" aria-hidden="true"></i>{AUTOMATION_OUTCOME_LABEL[
												run.outcome
											]}</span
										>
									</td>
									<td class="detail">
										{#if run.mission_id}
											<a href={missionThreadHref(automation.project_id, run.mission_id)}
												>Open the mission</a
											>
										{/if}
										{#if run.message}<span class="msg">{run.message}</span>{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{:else}
				<EmptyState
					title="No runs yet"
					description={automation.next_run
						? `The first runs ${formatSlot(automation.next_run, automation.time_zone)}.`
						: 'Runs appear here once it fires.'}
				/>
			{/if}
		</section>

		<ConfirmDialog
			bind:open={confirming}
			title="Delete {automation.name}?"
			description="Its schedule and run history are removed. The missions it launched stay in Missions."
			confirm_label="Delete automation"
			destructive
			onconfirm={remove}
		/>
		{#if can_manage}
			<AutomationDialog bind:open={editing} {automation} />
		{/if}
	{/if}
</div>

<style>
	.automation {
		max-width: 1000px;
	}
	.crumbs {
		display: flex;
		gap: var(--s-2);
		margin-bottom: var(--s-2);
		font-size: var(--t-xs);
		color: var(--tx-dim);
	}
	.crumbs a {
		color: var(--tx-mid);
	}
	.banner {
		margin-bottom: var(--s-5);
	}
	.facts {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		gap: var(--s-2) var(--s-5);
		margin: 0 0 var(--s-7);
		font-size: var(--t-sm);
	}
	.facts dt {
		color: var(--tx-dim);
	}
	.facts dd {
		margin: 0;
		color: var(--tx-hi);
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0 var(--s-2);
		min-width: 0;
	}
	.upcoming {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--s-1);
		font-size: var(--t-sm);
	}
	.upcoming li {
		display: flex;
		gap: var(--s-3);
		align-items: baseline;
	}
	.nowrap {
		white-space: nowrap;
	}
	.runs .detail {
		display: flex;
		flex-wrap: wrap;
		gap: 0 var(--s-3);
	}
	.msg {
		color: var(--tx-mid);
	}
	@media (max-width: 600px) {
		.facts {
			grid-template-columns: minmax(0, 1fr);
			gap: 2px;
		}
		.facts dd {
			margin-bottom: var(--s-3);
		}
	}
</style>
