<script lang="ts">
	/**
	 * First Mate as a chat, laid out after Overalls' threads: a quiet rail of
	 * chats (and agent threads, when a runner is configured) and one
	 * conversation column. A new chat starts from the question screen.
	 *
	 * Chats are kept on the server and answered by one long-lived agent on the
	 * mate runner (docs/first-mate.md); without a runner they get a
	 * placeholder, and members are told First Mate is for admins for now.
	 * Agent threads are real: `?thread=&project=` opens a mission as before.
	 * The command palette stays on ⌘K, reachable from every composer.
	 */
	import { tick, untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import CommandIcon from '@lucide/svelte/icons/command';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import AgentThread from '#lib/components/agent-thread.svelte';
	import ChatComposer from '#lib/components/chat-composer.svelte';
	import IssueId from '#lib/components/issue-id.svelte';
	import MateChatView from '#lib/components/mate-chat-view.svelte';
	import MateContextSelect from '#lib/components/mate-context-select.svelte';
	import { api, errorMessage } from '#lib/client/api.js';
	import { agentAvailability, isBusyStatus, missionVerb } from '#lib/client/agent.js';
	import { FIRST_MATE_PATH, threadHref } from '#lib/client/first-mate.js';
	import { dispatchBadgeKey, relativeShort } from '#lib/client/format.js';
	import { useHotkeys } from '#lib/client/hotkeys.svelte.js';
	import { stepFocus } from '#lib/client/list-focus.js';
	import { STARTERS, chatHref } from '#lib/client/mate-chat.js';
	import { mate_chats } from '#lib/client/mate-chat.svelte.js';
	import { currentProject, statusSnapshot } from '#lib/client/projects.svelte.js';
	import { app_state } from '#lib/client/stores.svelte.js';
	import { PRODUCT_NAME } from '#lib/product.js';
	import type { DispatchRequest, Mission } from '#lib/types.js';

	/** How often the thread list re-reads missions while one is working. */
	const LIST_POLL_MS = 8000;

	let starting = $state(false);
	let draft = $state(page.url.searchParams.get('q') ?? '');
	let scope = $state<string | null>(currentProject()?.id ?? null);
	let start_input = $state<HTMLTextAreaElement | null>(null);
	let rail_el = $state<HTMLElement | null>(null);

	let missions = $state<Mission[]>([]);
	let missions_error = $state<string | null>(null);
	let loading = $state(true);

	const dispatch = $derived(statusSnapshot()?.dispatch ?? null);
	const agent = $derived(agentAvailability(statusSnapshot()));
	const chat_id = $derived(page.url.searchParams.get('chat'));
	const chat = $derived(mate_chats.get(chat_id));
	const thread_id = $derived(page.url.searchParams.get('thread'));
	const thread_project = $derived(page.url.searchParams.get('project'));
	const thread_open = $derived(thread_id !== null && thread_project !== null && agent.visible);
	const selected = $derived(missions.find((mission) => mission.id === thread_id));
	const active_count = $derived(missions.filter((mission) => isBusyStatus(mission.status)).length);
	const is_open = $derived(thread_open || chat_id !== null);
	const mounted = $derived(mate_chats.loaded);
	const can_chat = $derived(mate_chats.can_chat);
	const mate_reason = $derived(mate_chats.status?.reason);

	$effect(() => {
		void mate_chats.load();
	});

	// Follow the open chat's events; leaving the page stops following (the
	// agent keeps working on the runner).
	$effect(() => {
		const id = chat_id;
		const allowed = can_chat;
		untrack(() => {
			if (id !== null && allowed) {
				void mate_chats.open(id);
			} else if (id === null) {
				mate_chats.close();
			}
		});
	});
	$effect(() => () => mate_chats.close());

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

	// The top bar's First Mate button and `n` bump this to focus the question.
	$effect(() => {
		void app_state.first_mate_focus_tick;
		if (!is_open) {
			void tick().then(() => start_input?.focus());
		}
	});

	/** Keep the rail row in step with what the open thread just learned. */
	function onThreadUpdated(request: DispatchRequest) {
		missions = missions.map((mission) =>
			mission.id === request.id ? { ...mission, ...request } : mission
		);
	}

	async function startChat(text: string) {
		if (starting) {
			return;
		}
		starting = true;
		try {
			const id = await mate_chats.start(text, scope);
			if (draft.trim() === text.trim()) draft = '';
			await goto(chatHref(id));
		} catch (error) {
			toast.error('Could not start the chat', { description: errorMessage(error) });
		} finally {
			starting = false;
		}
	}

	function useStarter(text: string) {
		draft = text;
		void tick().then(() => start_input?.focus());
	}

	function closeOpen() {
		void goto(FIRST_MATE_PATH, { reset: false });
	}

	async function deleteChat() {
		if (!chat) {
			return;
		}
		const id = chat.id;
		await mate_chats.remove(id);
		if (chat_id === id) closeOpen();
	}

	async function newChat() {
		if (is_open) {
			await goto(FIRST_MATE_PATH);
		}
		app_state.focusFirstMatePage();
	}

	useHotkeys(() => [
		{
			keys: ['j', 'ArrowDown'],
			label: 'Next chat',
			group: 'Lists',
			run: () => stepFocus(rail_el, 'a.mate-row', 1)
		},
		{
			keys: ['k', 'ArrowUp'],
			label: 'Previous chat',
			group: 'Lists',
			run: () => stepFocus(rail_el, 'a.mate-row', -1)
		},
		{
			keys: ['Escape'],
			label: 'Close the chat',
			group: 'Agent',
			when: () => is_open,
			run: closeOpen
		},
		{
			keys: ['n'],
			label: 'New chat',
			group: 'Agent',
			run: () => void newChat()
		}
	]);
</script>

<svelte:head><title>First Mate · {PRODUCT_NAME}</title></svelte:head>

<div class="wrap is-wide mate" class:is-open={is_open}>
	<aside class="mate-rail" aria-label="Chats" bind:this={rail_el}>
		<button class="btn new-chat" type="button" disabled={!can_chat} onclick={() => void newChat()}>
			<PlusIcon size={14} strokeWidth={1.6} aria-hidden="true" /> New chat
			<span class="kbd" aria-hidden="true">n</span>
		</button>

		<section class="rail-sec" aria-labelledby="mate-chats-hd">
			<h2 class="caps rail-hd" id="mate-chats-hd">
				Chats <span class="n">{mate_chats.chats.length}</span>
			</h2>
			{#if !mounted}
				<p class="hint" role="status">Loading chats…</p>
			{:else if mounted && mate_reason === 'admin_only'}
				<p class="hint">First Mate answers admins only for now.</p>
			{:else if mate_chats.list_error}
				<p class="hint" role="alert">{mate_chats.list_error}</p>
				<button class="btn btn-sm" type="button" onclick={() => void mate_chats.load()}
					>Retry chats</button
				>
			{:else if mounted && mate_chats.chats.length === 0}
				<p class="hint">Your chats appear here.</p>
			{:else}
				<ul class="rail-list">
					{#each mate_chats.chats as item (item.id)}
						<li>
							<a
								class="mate-row"
								href={chatHref(item.id)}
								aria-current={item.id === chat_id ? 'page' : undefined}
							>
								<span class="row-ti">{item.title}</span>
								<span class="row-when mono-num">{relativeShort(item.updated_at)}</span>
							</a>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		{#if agent.visible}
			<section class="rail-sec" aria-labelledby="mate-threads-hd">
				<h2 class="caps rail-hd" id="mate-threads-hd">
					Agent threads
					<span class="n">
						{active_count > 0 ? `${active_count} working` : missions.length}
						{#if dispatch && !dispatch.armed}<span class="off">· disarmed</span>{/if}
					</span>
				</h2>
				{#if loading}
					<p class="hint">Loading…</p>
				{:else if missions_error}
					<p class="hint" role="alert">{missions_error}</p>
				{:else if missions.length === 0}
					<p class="hint">No agent threads yet. Press a on an issue to start one.</p>
				{:else}
					<ul class="rail-list">
						{#each missions as mission (mission.id)}
							<li>
								<a
									class="mate-row is-thread"
									href={threadHref(mission)}
									aria-current={mission.id === thread_id ? 'page' : undefined}
								>
									<span class="row-ti">
										<i
											class="dot dot-{dispatchBadgeKey(mission.status)}"
											title={mission.status}
											aria-hidden="true"
										></i>
										{mission.title ?? mission.project_name}
									</span>
									<span class="row-when mono-num">{relativeShort(mission.updated_at)}</span>
									<span class="row-meta">
										{missionVerb(mission)}
										{#if mission.issue_id}· {mission.issue_id}{/if}
										<span class="sr-only">, {mission.status}</span>
									</span>
								</a>
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		{/if}
	</aside>

	<section class="mate-main" aria-label={is_open ? 'Conversation' : 'New chat'}>
		{#if thread_open && thread_id && thread_project}
			<div class="thread">
				<header class="thread-hd">
					<button
						class="btn btn-sm btn-ghost btn-icon back"
						type="button"
						aria-label="Back to chats"
						title="Back (esc)"
						onclick={closeOpen}
					>
						<ArrowLeftIcon size={14} strokeWidth={1.4} />
					</button>
					<div class="thread-ti">
						<h1>{selected?.title ?? 'Agent thread'}</h1>
						<p class="dim xs">
							{#if selected?.issue_id}
								<IssueId
									id={selected.issue_id}
									href="/p/{selected.project_id}/i/{selected.issue_id}"
								/>
								·
							{/if}
							{selected?.project_name ?? ''}
						</p>
					</div>
				</header>
				{#key thread_id}
					<AgentThread
						project_id={thread_project}
						request_id={thread_id}
						initial={selected}
						autofocus
						onupdated={onThreadUpdated}
					/>
				{/key}
			</div>
		{:else if chat}
			{#key chat.id}
				<MateChatView
					{chat}
					focus_key={app_state.first_mate_focus_tick}
					onback={closeOpen}
					ondelete={deleteChat}
				/>
			{/key}
		{:else if chat_id}
			<div class="start">
				<h1 class="h1">
					{mate_chats.opening || !mounted ? 'Loading conversation…' : 'Conversation unavailable'}
				</h1>
				<p role="status">
					{mate_chats.open_error ??
						(mate_reason === 'admin_only'
							? 'First Mate is for admins for now.'
							: 'Choose a chat from the list or return to your chats.')}
				</p>
				{#if can_chat}<button
						class="btn"
						type="button"
						onclick={() => void mate_chats.open(chat_id)}>Retry conversation</button
					>{/if}
				<button class="btn btn-ghost" type="button" onclick={closeOpen}>Back to chats</button>
			</div>
		{:else}
			<div class="start">
				<h1 class="h1">What do you want to know?</h1>
				<p class="sub">
					Ask about the work in your Beads projects: what's ready, what's stalled, what changed,
					what to file next.
				</p>

				<ChatComposer
					bind:value={draft}
					bind:textarea={start_input}
					label="Ask First Mate"
					placeholder="Ask about your projects…"
					rows={4}
					submit_label="Ask"
					disabled={!mounted || !can_chat}
					reason={!mounted
						? 'Loading First Mate…'
						: mate_reason === 'admin_only'
							? 'First Mate is for admins for now'
							: !can_chat
								? 'First Mate is unavailable. Retry loading chats.'
								: undefined}
					busy={starting}
					onsend={(text) => void startChat(text)}
				>
					{#snippet controls()}
						<MateContextSelect bind:value={scope} disabled={starting || !can_chat} />
						<button
							class="btn btn-sm btn-ghost"
							type="button"
							title="Commands (⌘K)"
							onclick={() => app_state.openFirstMate()}
						>
							<CommandIcon size={12} strokeWidth={1.6} aria-hidden="true" /> Commands
						</button>
					{/snippet}
				</ChatComposer>

				<ol class="starters" aria-label="Starting points">
					{#each STARTERS as starter, index (starter)}
						<li>
							<button
								type="button"
								disabled={!can_chat || starting}
								onclick={() => useStarter(starter)}
							>
								<span class="n mono-num">{String(index + 1).padStart(2, '0')}</span>
								<span>{starter}</span>
							</button>
						</li>
					{/each}
				</ol>

				<div class="notes">
					{#if mate_reason === 'admin_only'}
						<p>
							<strong>Admins only, for now.</strong>
							First Mate runs an agent that can change Beads in every project, so only admins talk to
							it.
						</p>
					{:else if mate_chats.connected}
						<p>
							<strong>Runner configured.</strong>
							Messages go to the configured runner. Available actions depend on its setup{#if mate_chats.status?.reachable === false};
								the runner is not answering right now{/if}.
						</p>
					{:else}
						<p>
							<strong>Not connected yet.</strong>
							No model answers yet: replies are placeholders. Your chats are kept for when one is.
						</p>
					{/if}
					<p>
						<strong>Changes go through bd.</strong>
						First Mate and its crew change Beads with bd, never behind its back.
						<span class="kbd">⌘K</span> runs a command without a chat.
					</p>
				</div>
			</div>
		{/if}
	</section>
</div>

<style>
	.mate {
		display: grid;
		grid-template-columns: 248px minmax(0, 1fr);
		height: calc(100dvh - var(--topbar-h) - var(--main-pad-top) - var(--main-pad-bottom));
		min-height: 480px;
	}

	/* ---- rail: quiet, the conversation is the working surface */
	.mate-rail {
		display: flex;
		flex-direction: column;
		gap: var(--s-5);
		min-height: 0;
		overflow-y: auto;
		padding-right: var(--s-4);
		border-right: 1px solid var(--line);
	}
	.new-chat {
		flex: none;
		justify-content: flex-start;
		width: 100%;
	}
	.new-chat .kbd {
		margin-left: auto;
	}
	.rail-hd {
		display: flex;
		align-items: baseline;
		gap: var(--s-2);
		margin: 0 0 var(--s-2);
		padding-bottom: 6px;
		border-bottom: 2px solid var(--rule);
	}
	.rail-hd .n {
		margin-left: auto;
		font-weight: 400;
		letter-spacing: 0;
		text-transform: none;
		color: var(--tx-dim);
	}
	.rail-hd .off {
		color: var(--amber-tx);
	}
	.rail-list {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.mate-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 2px var(--s-2);
		align-items: start;
		padding: 7px 8px 7px 6px;
		border-left: 2px solid transparent;
		border-radius: 0 var(--r-1) var(--r-1) 0;
		color: var(--tx-mid);
		font-size: var(--t-sm);
		text-decoration: none;
		outline: none;
	}
	.mate-row:hover,
	.mate-row:focus-visible {
		background: var(--s2);
		color: var(--tx-hi);
		text-decoration: none;
	}
	.mate-row:focus-visible {
		box-shadow: inset 0 0 0 1px var(--line-3);
	}
	.mate-row[aria-current='page'] {
		background: var(--s3);
		border-left-color: var(--em-500);
		color: var(--tx-hi);
		font-weight: 600;
	}
	.row-ti {
		display: -webkit-box;
		min-width: 0;
		overflow: hidden;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		line-height: 1.4;
		overflow-wrap: anywhere;
	}
	.mate-row:is(:focus-visible, [aria-current='page']) .row-ti {
		-webkit-line-clamp: unset;
		line-clamp: unset;
	}
	.row-ti .dot {
		margin-right: 4px;
	}
	.row-when {
		padding-top: 1px;
	}
	.row-when,
	.row-meta {
		font-size: var(--t-xs);
		font-weight: 400;
		color: var(--tx-dim);
	}
	.row-meta {
		grid-column: 1 / -1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* ---- main */
	.mate-main {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
		padding-left: var(--s-6);
		overflow-y: auto;
	}
	.mate.is-open .mate-main {
		overflow: hidden;
	}

	/* ---- the question screen */
	.start {
		width: 100%;
		max-width: 76ch;
		margin: 0 auto;
		padding: clamp(var(--s-5), 9vh, 96px) 0 var(--s-6);
	}
	.start .h1 {
		margin: 0 0 var(--s-2);
	}
	.sub {
		margin: 0 0 var(--s-5);
		font-size: var(--t-base);
		color: var(--tx-mid);
	}
	.starters {
		list-style: none;
		margin: var(--s-5) 0 0;
		padding: 0;
	}
	.starters li + li {
		border-top: 1px solid var(--line);
	}
	.starters button {
		display: grid;
		grid-template-columns: 4ch minmax(0, 1fr);
		gap: var(--s-3);
		width: 100%;
		padding: 10px 6px;
		background: none;
		border: 0;
		border-radius: var(--r-1);
		color: var(--tx-mid);
		font: inherit;
		font-size: var(--t-sm);
		text-align: left;
		cursor: pointer;
	}
	.starters button:hover,
	.starters button:focus-visible {
		background: var(--s2);
		color: var(--tx-hi);
	}
	.starters .n {
		color: var(--tx-dim);
	}
	.notes {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--s-3) var(--s-6);
		margin-top: var(--s-6);
		padding-top: var(--s-4);
		border-top: 2px solid var(--rule);
		font-size: var(--t-sm);
		color: var(--tx-mid);
	}
	.notes p {
		margin: 0;
	}
	.notes strong {
		display: block;
		margin-bottom: 2px;
		color: var(--tx-hi);
		font-weight: 600;
	}

	/* ---- an agent thread */
	.thread {
		display: flex;
		flex-direction: column;
		width: 100%;
		max-width: 76ch;
		height: 100%;
		min-height: 0;
		margin: 0 auto;
	}
	.thread-hd {
		display: flex;
		align-items: flex-start;
		gap: var(--s-2);
		padding: 0 0 var(--s-3);
		margin-bottom: var(--s-4);
		border-bottom: 2px solid var(--rule);
	}
	.thread-ti {
		flex: 1;
		min-width: 0;
	}
	.thread-ti h1 {
		margin: 0 0 2px;
		font-size: var(--t-md);
		font-weight: 600;
		line-height: 1.35;
		color: var(--tx-hi);
		overflow-wrap: anywhere;
	}
	.thread-ti p {
		margin: 0;
	}

	@media (min-width: 901px) {
		.back {
			display: none;
		}
	}
	@media (max-width: 900px) {
		.mate {
			display: flex;
			flex-direction: column;
			height: auto;
			min-height: 0;
		}
		.mate.is-open {
			height: calc(100dvh - var(--topbar-h) - var(--main-pad-top) - var(--main-pad-bottom));
		}
		.mate.is-open .mate-rail {
			display: none;
		}
		.mate.is-open .mate-main {
			flex: 1;
		}
		.mate-rail {
			order: 2;
			overflow: visible;
			padding: var(--s-5) 0 0;
			border-right: 0;
		}
		.mate-main {
			padding-left: 0;
			overflow: visible;
		}
		/* The question screen is already a new chat. */
		.new-chat {
			display: none;
		}
		.start {
			padding-top: var(--s-3);
		}
		.notes {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
