<script lang="ts">
	/**
	 * First Mate: agent threads on the left, the selected
	 * conversation on the right, and the command console when no thread is
	 * open. Provider-agnostic: what the runner can do comes from
	 * `dispatch.capabilities`. With no provider configured the threads are
	 * hidden and the page is just the command console.
	 */
	import { goto, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import RadioIcon from '@lucide/svelte/icons/radio';
	import TimerIcon from '@lucide/svelte/icons/timer';
	import AgentThread from '$lib/components/agent-thread.svelte';
	import FileIssueDialog from '$lib/components/file-issue-dialog.svelte';
	import FirstMateConsole from '$lib/components/first-mate-console.svelte';
	import IssueId from '$lib/components/issue-id.svelte';
	import PageHeader from '$lib/components/page-header.svelte';
	import TackleIssueDialog from '$lib/components/tackle-issue-dialog.svelte';
	import { api, errorMessage } from '$lib/client/api';
	import { agentAvailability, isBusyStatus, missionVerb } from '$lib/client/agent';
	import {
		FIRST_MATE_PATH,
		firstMatePageHref,
		isFirstMateHotkey,
		parsePinnedView,
		threadHref,
		type FirstMateView
	} from '$lib/client/first-mate';
	import { dispatchBadgeKey, relativeShort } from '$lib/client/format';
	import { useHotkeys } from '$lib/client/hotkeys.svelte';
	import { stepFocus } from '$lib/client/list-focus';
	import { statusSnapshot } from '$lib/client/projects.svelte';
	import { app_state } from '$lib/client/stores.svelte';
	import { PRODUCT_NAME } from '$lib/product';
	import type { DispatchRequest, Mission } from '$lib/types';

	const initial_query = page.url.searchParams.get('q') ?? '';
	const initial_view = parsePinnedView(page.url.searchParams.get('view'));

	/** How often the thread list re-reads missions while one is working. */
	const LIST_POLL_MS = 8000;

	let refresh_key = $state(0);
	let file_open = $state(false);
	let file_project_id = $state('');
	let tackle_open = $state(false);
	let tackle_project_id = $state('');
	let tackle_issue_id = $state('');
	let tackle_issue_title = $state('');
	let file_was_open = false;
	let tackle_was_open = false;
	let url_timer: ReturnType<typeof setTimeout> | undefined;

	let missions = $state<Mission[]>([]);
	let missions_error = $state<string | null>(null);
	let loading = $state(true);
	let show = $state<'active' | 'all'>('all');
	let list_el = $state<HTMLUListElement | null>(null);

	const dispatch = $derived(statusSnapshot()?.dispatch ?? null);
	const agent = $derived(agentAvailability(statusSnapshot()));
	const thread_id = $derived(page.url.searchParams.get('thread'));
	const thread_project = $derived(page.url.searchParams.get('project'));
	const selected = $derived(missions.find((mission) => mission.id === thread_id));
	const active_count = $derived(missions.filter((mission) => isBusyStatus(mission.status)).length);
	const shown = $derived(
		show === 'active' ? missions.filter((mission) => isBusyStatus(mission.status)) : missions
	);

	async function loadMissions(signal?: AbortSignal) {
		try {
			const response = await api.missions({ limit: 60 }, { signal });
			missions = response.missions;
			missions_error = null;
		} catch (error) {
			if (!signal?.aborted) {
				missions_error = errorMessage(error);
			}
		} finally {
			if (!signal?.aborted) {
				loading = false;
			}
		}
	}

	$effect(() => {
		if (!agent.visible) {
			return;
		}
		void refresh_key;
		const ac = new AbortController();
		void loadMissions(ac.signal);
		return () => ac.abort();
	});

	$effect(() => {
		if (!agent.visible || active_count === 0) {
			return;
		}
		const poll = setInterval(() => void loadMissions(), LIST_POLL_MS);
		return () => clearInterval(poll);
	});

	/** Keep the list row in step with what the open thread just learned. */
	function onThreadUpdated(request: DispatchRequest) {
		missions = missions.map((mission) =>
			mission.id === request.id ? { ...mission, ...request } : mission
		);
	}

	function closeThread() {
		void goto(FIRST_MATE_PATH, { keepFocus: true, noScroll: true });
	}

	function onWindowKeydown(event: KeyboardEvent) {
		if (!isFirstMateHotkey(event)) {
			return;
		}
		event.preventDefault();
		if (thread_id !== null) {
			app_state.openFirstMate();
			return;
		}
		app_state.focusFirstMatePage();
	}

	useHotkeys(() => [
		{
			keys: ['j', 'ArrowDown'],
			label: 'Next thread',
			group: 'Lists',
			when: () => agent.visible,
			run: () => stepFocus(list_el, 'a.th-row', 1)
		},
		{
			keys: ['k', 'ArrowUp'],
			label: 'Previous thread',
			group: 'Lists',
			when: () => agent.visible,
			run: () => stepFocus(list_el, 'a.th-row', -1)
		},
		{
			keys: ['Escape'],
			label: 'Close the thread',
			group: 'Agent',
			when: () => thread_id !== null,
			run: closeThread
		},
		{
			keys: ['n'],
			label: 'Commands (close the thread)',
			group: 'Agent',
			when: () => thread_id !== null,
			run: () => {
				closeThread();
				app_state.focusFirstMatePage();
			}
		}
	]);

	async function onNavigate(href: string) {
		await goto(href);
	}

	function onFile(project_id: string) {
		file_project_id = project_id;
		file_open = true;
	}

	function onTackle(target: { project_id: string; issue_id: string; issue_title: string }) {
		tackle_project_id = target.project_id;
		tackle_issue_id = target.issue_id;
		tackle_issue_title = target.issue_title;
		tackle_open = true;
	}

	function onStateChange(state: { query: string; view: FirstMateView | null }) {
		if (url_timer !== undefined) {
			clearTimeout(url_timer);
		}
		url_timer = setTimeout(() => {
			if (page.url.pathname !== FIRST_MATE_PATH || thread_id !== null) {
				return;
			}
			const next = firstMatePageHref(state.query, state.view);
			const current = `${page.url.pathname}${page.url.search}`;
			if (next !== current) {
				replaceState(next, {});
			}
		}, 250);
	}

	$effect(() => {
		if (file_was_open && !file_open) {
			app_state.focusFirstMatePage();
		}
		file_was_open = file_open;
	});

	$effect(() => {
		if (tackle_was_open && !tackle_open) {
			app_state.focusFirstMatePage();
		}
		tackle_was_open = tackle_open;
	});

	$effect(() => {
		return () => {
			if (url_timer !== undefined) {
				clearTimeout(url_timer);
			}
		};
	});
</script>

<svelte:head><title>First Mate · {PRODUCT_NAME}</title></svelte:head>
<svelte:window onkeydown={onWindowKeydown} />

<div
	class="wrap is-wide mate"
	class:has-threads={agent.visible}
	class:has-thread={thread_id !== null}
>
	<PageHeader
		title="First Mate"
		meta={agent.visible && active_count > 0 ? `${active_count} working` : undefined}
		onrefresh={() => (refresh_key += 1)}
	>
		{#snippet actions()}
			{#if agent.visible}
				<span
					class="runner"
					class:is-off={!dispatch?.armed}
					title={dispatch?.capabilities?.live_events
						? 'The runner streams events while it works'
						: 'The runner reports when it finishes; threads poll for the reply'}
				>
					{#if dispatch?.capabilities?.live_events}
						<RadioIcon size={13} strokeWidth={1.4} aria-hidden="true" /> live
					{:else}
						<TimerIcon size={13} strokeWidth={1.4} aria-hidden="true" /> polls
					{/if}
					{#if !dispatch?.armed}<span class="off">· disarmed</span>{/if}
				</span>
			{/if}
		{/snippet}
	</PageHeader>

	<div class="mate-grid">
		{#if agent.visible}
			<aside class="threads" aria-label="Agent threads">
				<div class="threads-hd" role="radiogroup" aria-label="Show">
					<button
						type="button"
						role="radio"
						aria-checked={show === 'all'}
						class:is-on={show === 'all'}
						onclick={() => (show = 'all')}>All <span class="n">{missions.length}</span></button
					>
					<button
						type="button"
						role="radio"
						aria-checked={show === 'active'}
						class:is-on={show === 'active'}
						onclick={() => (show = 'active')}>Working <span class="n">{active_count}</span></button
					>
				</div>
				{#if loading}
					<p class="hint pad">Loading…</p>
				{:else if missions_error}
					<p class="hint pad" role="alert">{missions_error}</p>
				{:else if shown.length === 0}
					<p class="hint pad">
						{show === 'active'
							? 'No agent is working.'
							: 'No threads yet. Press a on an issue to start one.'}
					</p>
				{:else}
					<ul class="th-list" bind:this={list_el}>
						{#each shown as mission (mission.id)}
							<li>
								<a
									class="th-row"
									class:is-sel={mission.id === thread_id}
									href={threadHref(mission)}
									aria-current={mission.id === thread_id ? 'true' : undefined}
								>
									<i
										class="dot dot-{dispatchBadgeKey(mission.status)}"
										title={mission.status}
										aria-hidden="true"
									></i>
									<span class="th-verb">{missionVerb(mission)}</span>
									{#if mission.issue_id}
										<IssueId id={mission.issue_id} />
									{/if}
									<span class="th-when mono-num">{relativeShort(mission.updated_at)}</span>
									<span class="th-ti">{mission.title ?? mission.project_name}</span>
									<span class="sr-only">{mission.status}</span>
								</a>
							</li>
						{/each}
					</ul>
				{/if}
			</aside>
		{/if}

		<section class="pane" aria-label={thread_id ? 'Thread' : 'Commands'}>
			{#if thread_id && thread_project && agent.visible}
				<div class="pane-hd">
					<button
						class="btn btn-sm btn-ghost btn-icon back"
						type="button"
						aria-label="Back to threads"
						title="Close (esc)"
						onclick={closeThread}
					>
						<ArrowLeftIcon size={14} strokeWidth={1.4} />
					</button>
					{#if selected?.issue_id}
						<IssueId
							id={selected.issue_id}
							href="/p/{selected.project_id}/i/{selected.issue_id}"
							strong
						/>
					{/if}
					<span class="pane-ti">{selected?.title ?? ''}</span>
					<span class="faint xs">{selected?.project_name ?? ''}</span>
				</div>
				{#key thread_id}
					<AgentThread
						project_id={thread_project}
						request_id={thread_id}
						initial={selected}
						onupdated={onThreadUpdated}
					/>
				{/key}
			{:else}
				<FirstMateConsole
					variant="page"
					active={true}
					{initial_query}
					{initial_view}
					{refresh_key}
					focus_key={app_state.first_mate_focus_tick}
					{title}
					{onNavigate}
					{onFile}
					{onTackle}
					{onStateChange}
				/>
			{/if}
		</section>
	</div>
</div>

{#snippet title(heading: string)}
	<span class="crumb-view">{heading}</span>
{/snippet}

{#if file_project_id}
	<FileIssueDialog project_id={file_project_id} bind:open={file_open} />
{/if}
{#if tackle_issue_id && tackle_project_id}
	<TackleIssueDialog
		project_id={tackle_project_id}
		issue_id={tackle_issue_id}
		issue_title={tackle_issue_title}
		bind:open={tackle_open}
		show_trigger={false}
	/>
{/if}

<style>
	.mate {
		display: flex;
		flex-direction: column;
		max-width: 1720px;
	}
	.mate:not(.has-threads) {
		max-width: 760px;
	}
	.mate-grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--s-4);
		min-height: 0;
	}
	.has-threads .mate-grid {
		grid-template-columns: 320px minmax(0, 1fr);
		height: calc(100dvh - var(--topbar-h) - var(--main-pad-top) - var(--main-pad-bottom) - 48px);
		min-height: 420px;
	}
	@media (min-width: 1600px) {
		.has-threads .mate-grid {
			grid-template-columns: 380px minmax(0, 1fr);
		}
	}
	@media (max-width: 900px) {
		.has-threads .mate-grid {
			grid-template-columns: minmax(0, 1fr);
			height: auto;
		}
		.has-thread .threads {
			display: none;
		}
		.threads {
			max-height: 42dvh;
		}
		.has-thread .pane {
			height: calc(100dvh - var(--topbar-h) - 120px);
		}
	}
	@media (min-width: 901px) {
		.back {
			display: none;
		}
	}

	.runner {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		height: 24px;
		padding: 0 8px;
		border: 1px solid var(--line);
		border-radius: var(--r-1);
		font-size: var(--t-xs);
		color: var(--tx-mid);
	}
	.runner .off {
		color: var(--amber-tx);
	}

	.threads {
		display: flex;
		flex-direction: column;
		min-height: 0;
		border: 1px solid var(--line);
		border-radius: var(--r-2);
		background: var(--s1);
		overflow: hidden;
	}
	.threads-hd {
		display: flex;
		gap: 2px;
		padding: 6px;
		border-bottom: 1px solid var(--line);
	}
	.threads-hd button {
		flex: 1;
		height: 26px;
		border: 1px solid transparent;
		border-radius: var(--r-1);
		background: none;
		color: var(--tx-dim);
		font: inherit;
		font-size: var(--t-xs);
		cursor: pointer;
	}
	.threads-hd button.is-on {
		background: var(--s3);
		border-color: var(--line);
		color: var(--tx-hi);
	}
	.threads-hd .n {
		color: var(--tx-faint);
		margin-left: 4px;
		font-variant-numeric: tabular-nums;
	}
	.th-list {
		list-style: none;
		margin: 0;
		padding: 0;
		overflow-y: auto;
		min-height: 0;
		flex: 1;
	}
	.th-row {
		display: grid;
		grid-template-columns: auto auto minmax(0, 1fr) auto;
		grid-template-areas:
			'dot verb id when'
			'ti ti ti ti';
		align-items: center;
		gap: 2px 8px;
		padding: 8px var(--s-3) 8px calc(var(--s-3) - 2px);
		border-bottom: 1px solid var(--line);
		border-left: 2px solid transparent;
		color: var(--tx);
		font-size: var(--t-xs);
		outline: none;
	}
	.th-row:hover,
	.th-row:focus-visible {
		background: var(--s3);
		text-decoration: none;
	}
	.th-row:focus-visible {
		box-shadow: inset 0 0 0 1px var(--em-700);
	}
	.th-row.is-sel {
		background: var(--em-wash);
		border-left-color: var(--em-500);
	}
	.th-row .dot {
		grid-area: dot;
	}
	.th-verb {
		grid-area: verb;
		color: var(--tx-hi);
		font-weight: 600;
	}
	.th-row :global(.id) {
		grid-area: id;
		justify-self: start;
	}
	.th-when {
		grid-area: when;
		color: var(--tx-faint);
	}
	.th-ti {
		grid-area: ti;
		color: var(--tx-mid);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		padding-left: 14px;
	}
	.pad {
		padding: var(--s-4);
	}

	.pane {
		display: flex;
		flex-direction: column;
		min-height: 0;
		min-width: 0;
	}
	.has-threads .pane {
		border: 1px solid var(--line);
		border-radius: var(--r-2);
		background: var(--bg);
		padding: var(--s-3) var(--s-4) var(--s-4);
	}
	.pane-hd {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		padding-bottom: var(--s-2);
		margin-bottom: var(--s-2);
		border-bottom: 1px solid var(--line);
		min-width: 0;
	}
	.pane-ti {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--tx-hi);
		font-size: var(--t-sm);
	}
	.crumb-view {
		color: var(--tx-hi);
	}
</style>
