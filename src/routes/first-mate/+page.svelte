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
	 * The question screen is also the app's home (`/` lands here), so under
	 * the composer it lists the viewer's work from live data: top todos (for
	 * admins), ready issues and running or failed repo workers, each linking
	 * to the work and, where a chat could act on it, offering a question.
	 * Members, and admins on a host with no runner, still get that list:
	 * the page is never a dead end. See #lib/client/mate-start.ts.
	 * The command palette stays on ⌘K, reachable from every composer.
	 */
	import { tip } from '#lib/client/tooltip.js';
	import { tick, untrack } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeftIcon';
	import ArrowRightIcon from 'phosphor-svelte/lib/ArrowRightIcon';
	import ChatCircleTextIcon from 'phosphor-svelte/lib/ChatCircleTextIcon';
	import CommandIcon from 'phosphor-svelte/lib/CommandIcon';
	import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
	import AgentThread from '#lib/components/agent-thread.svelte';
	import ChatComposer from '#lib/components/chat-composer.svelte';
	import IssueId from '#lib/components/issue-id.svelte';
	import MateChatView from '#lib/components/mate-chat-view.svelte';
	import { missionStatusLabel } from '#lib/components/mission-status.svelte';
	import MateContextSelect from '#lib/components/mate-context-select.svelte';
	import PriorityChip from '#lib/components/priority-chip.svelte';
	import RunnerSelect from '#lib/components/runner-select.svelte';
	import AgentChoiceSelect from '#lib/components/agent-choice-select.svelte';
	import { api, errorMessage } from '#lib/client/api.js';
	import {
		agentAvailability,
		isBusyStatus,
		missionProvider,
		missionVerb
	} from '#lib/client/agent.js';
	import { run_place } from '#lib/client/agent-runner.svelte.js';
	import { FIRST_MATE_PATH, threadHref } from '#lib/client/first-mate.js';
	import { dispatchBadgeKey, relativeShort } from '#lib/client/format.js';
	import { useHotkeys } from '#lib/client/hotkeys.svelte.js';
	import { stepFocus } from '#lib/client/list-focus.js';
	import { STARTERS, chatHref } from '#lib/client/mate-chat.js';
	import {
		runsOnNote,
		startMode,
		startSuggestions,
		topReady,
		topTodos,
		workerSummary,
		type StartSuggestion
	} from '#lib/client/mate-start.js';
	import { mate_chats } from '#lib/client/mate-chat.svelte.js';
	import { currentProject, currentViewer, statusSnapshot } from '#lib/client/projects.svelte.js';
	import { daysUntil, dueLabel } from '#lib/todos/dates.js';
	import { app_state } from '#lib/client/stores.svelte.js';
	import { PRODUCT_NAME } from '#lib/product.js';
	import type { DispatchRequest, Mission, ReadyIssue } from '#lib/types.js';
	import type { Todo } from '#lib/server/todos/store.js';

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
	/** Name each thread's runner only when there is more than one to tell apart. */
	const several_runners = $derived((dispatch?.providers?.length ?? 0) > 1);
	const selected_runner = $derived(
		selected === undefined ? undefined : missionProvider(selected, dispatch)
	);

	// The server-rendered snapshot lands before the first poll.
	$effect(() => {
		run_place.syncProviders(dispatch?.providers);
	});
	const mounted = $derived(mate_chats.loaded);
	const can_chat = $derived(mate_chats.can_chat);
	const mate_reason = $derived(mate_chats.status?.reason);
	const is_admin = $derived(currentViewer()?.role === 'admin');
	const mode = $derived(
		startMode({
			loaded: mounted,
			has_status: mate_chats.status !== null,
			admin_only: mate_reason === 'admin_only',
			connected: mate_chats.connected
		})
	);
	let retrying = $state(false);
	/** Why the last start failed; the question stays in the box. */
	let start_error = $state<string | null>(null);

	/** A phone or tablet: no focus on arrival, which would raise the keyboard over the page. */
	const touch_only = new MediaQuery('(hover: none) and (pointer: coarse)', false);

	/** Where a new chat runs: the viewer's pick, else the server default. */
	const new_chat_runner = $derived(
		mate_chats.connected
			? (run_place.chatRunner() ?? mate_chats.status?.runners?.[0]?.id ?? 'remote')
			: null
	);
	const runs_on = $derived(runsOnNote(new_chat_runner, mate_chats.status?.runners ?? []));

	// Live data for the home: each source keeps what it last read while it
	// refreshes, and a failed read says so instead of looking empty.
	interface Source<T> {
		value: T | null;
		error: string | null;
	}
	let ready_src = $state<Source<ReadyIssue[]>>({ value: null, error: null });
	let todo_src = $state<Source<Todo[]>>({ value: null, error: null });
	/** Bumped by a panel's Retry. */
	let live_seq = $state(0);

	$effect(() => {
		void live_seq;
		if (is_open) return;
		const admin = is_admin;
		const ac = new AbortController();
		untrack(() => {
			settle(ready_src, api.ready(100, { signal: ac.signal }), (r) => r.issues, ac.signal);
			// The todo list is admin-only; a member's read would be refused.
			if (admin) {
				settle(
					todo_src,
					api.todos({ status: 'open', limit: 200 }, { signal: ac.signal }),
					(r) => r.todos,
					ac.signal
				);
			}
		});
		return () => ac.abort();
	});

	function settle<R, T>(
		src: Source<T>,
		load: Promise<R>,
		take: (response: R) => T,
		signal: AbortSignal
	) {
		src.error = null;
		void load
			.then((response) => {
				if (!signal.aborted) src.value = take(response);
			})
			.catch((error) => {
				if (!signal.aborted) src.error = errorMessage(error);
			});
	}

	const suggestions = $derived(
		startSuggestions({
			admin: can_chat,
			runner: new_chat_runner,
			can_launch: agent.enabled,
			scope,
			ready: ready_src.value,
			todos: todo_src.value,
			missions: agent.visible && !loading && missions_error === null ? missions : null
		})
	);
	/** The question each panel can offer, when a chat could act on it. */
	const ask_for = $derived(
		Object.fromEntries(suggestions.map((suggestion) => [suggestion.id, suggestion])) as Partial<
			Record<StartSuggestion['id'], StartSuggestion>
		>
	);
	const home_todos = $derived(todo_src.value === null ? [] : topTodos(todo_src.value, new Date()));
	const open_todos = $derived(todo_src.value?.filter((todo) => todo.status === 'open').length ?? 0);
	const home_ready = $derived(ready_src.value === null ? [] : topReady(ready_src.value, scope));
	const workers = $derived(workerSummary(missions));
	const recent_chats = $derived(mate_chats.chats.slice(0, 3));

	async function retryStatus() {
		if (retrying) return;
		retrying = true;
		try {
			await mate_chats.load();
		} finally {
			retrying = false;
		}
	}

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
	// Arriving on a touch screen does not: the home is for reading first.
	const arrival_tick = app_state.first_mate_focus_tick;
	$effect(() => {
		const bumped = app_state.first_mate_focus_tick !== arrival_tick;
		if (!is_open && (bumped || !untrack(() => touch_only.current))) {
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
		start_error = null;
		try {
			const id = await mate_chats.start(text, scope);
			if (draft.trim() === text.trim()) draft = '';
			await goto(chatHref(id));
		} catch (error) {
			start_error = errorMessage(error);
			void tick().then(() => start_input?.focus());
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
			when: () => can_chat,
			run: () => void newChat()
		}
	]);
</script>

<svelte:head><title>First Mate · {PRODUCT_NAME}</title></svelte:head>

{#snippet pending(what: string)}
	<div class="work-pending" role="status">
		<span class="sr-only">Loading {what}…</span>
		<div class="skel" aria-hidden="true"></div>
		<div class="skel" aria-hidden="true"></div>
	</div>
{/snippet}

{#snippet failed(what: string, error: string, retry: () => void)}
	<div class="work-failed" role="alert">
		<p>Could not load {what}. {error}</p>
		<button class="btn btn-sm" type="button" onclick={retry}>Retry</button>
	</div>
{/snippet}

<!-- A refresh that failed keeps the last rows and says they may be old. -->
{#snippet stale(src: Source<unknown>)}
	{#if src.value !== null && src.error}
		<p class="work-stale">Could not refresh: {src.error}</p>
	{/if}
{/snippet}

<!-- Fills the box with a question about this panel; it never sends. -->
{#snippet ask(suggestion: StartSuggestion)}
	<button
		class="work-ask"
		type="button"
		disabled={starting}
		onclick={() => useStarter(suggestion.prompt)}
	>
		<span class="work-ask-lbl"
			><ChatCircleTextIcon size={13} aria-hidden="true" /> Ask about {suggestion.label}</span
		>
		<span class="work-ask-q">{suggestion.prompt}</span>
	</button>
{/snippet}

<div class="wrap is-wide mate" class:is-open={is_open}>
	<aside class="mate-rail" id="mate-rail" aria-label="Chats" bind:this={rail_el}>
		<button class="btn new-chat" type="button" disabled={!can_chat} onclick={() => void newChat()}>
			<PlusIcon size={14} aria-hidden="true" /> New chat
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
					<p class="hint">No agent threads yet. Ask an agent from an issue (a) to start one.</p>
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
											{@attach tip(missionStatusLabel(mission.status))}
											aria-hidden="true"
										></i>
										{mission.title ?? mission.project_name}
									</span>
									<span class="row-when mono-num">{relativeShort(mission.updated_at)}</span>
									<span class="row-meta">
										{missionVerb(mission)}
										{#if mission.issue_id}· {mission.issue_id}{/if}
										{#if several_runners}· {missionProvider(mission, dispatch)?.label ??
												'removed runner'}{/if}
										<span class="sr-only">, {missionStatusLabel(mission.status)}</span>
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
						{@attach tip('Back (esc)')}
						onclick={closeOpen}
					>
						<ArrowLeftIcon size={14} />
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
							{#if several_runners && selected_runner}· on {selected_runner.label}{/if}
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
				{#if mode === 'members'}
					<h1 class="h1">Your work</h1>
					<p class="sub">What is ready and running across your Beads projects.</p>
				{:else}
					<h1 class="h1">What do you want to know?</h1>
					<p class="sub">
						Ask about the work in your Beads projects: what's ready, what's stalled, what changed,
						what to file next.
					</p>
				{/if}

				{#if mode === 'error'}
					<div class="banner banner-err start-banner" role="alert">
						<div class="banner-bd">
							<b>Could not reach First Mate.</b>
							{mate_chats.list_error ?? ''} Your work below loads on its own.
						</div>
						<div class="banner-acts">
							<button
								class="btn btn-sm"
								type="button"
								disabled={retrying}
								onclick={() => void retryStatus()}>{retrying ? 'Retrying…' : 'Retry'}</button
							>
						</div>
					</div>
				{:else if mode === 'placeholder'}
					<div class="banner banner-warn start-banner">
						<div class="banner-bd">
							<b>No model is connected yet.</b>
							Replies are placeholders until a mate runner is configured. Your chats are kept for when
							one is.
						</div>
					</div>
				{:else if mode === 'members'}
					<div class="banner start-banner">
						<div class="banner-bd">
							<b>First Mate answers admins only, for now.</b>
							It runs an agent that can change Beads in every project. Your ready work is below.
						</div>
					</div>
				{/if}

				{#if mode !== 'members'}
					<ChatComposer
						bind:value={draft}
						bind:textarea={start_input}
						label="Ask First Mate"
						placeholder="Ask about your projects…"
						rows={4}
						submit_label="Ask"
						disabled={!can_chat}
						reason={mode === 'loading'
							? 'Loading First Mate…'
							: mode === 'error'
								? 'First Mate is unavailable. Retry above.'
								: undefined}
						busy={starting}
						onsend={(text) => void startChat(text)}
					>
						{#snippet controls()}
							<MateContextSelect bind:value={scope} disabled={starting || !can_chat} />
							<RunnerSelect />
							<AgentChoiceSelect takes={can_chat && mate_chats.connected} disabled={starting} />
							<button
								class="btn btn-sm btn-ghost"
								type="button"
								aria-label="Commands"
								{@attach tip('Commands (⌘K)')}
								onclick={() => app_state.openFirstMate()}
							>
								<CommandIcon size={12} aria-hidden="true" /><span class="cmd-lbl">Commands</span>
							</button>
						{/snippet}
					</ChatComposer>
					<p class="sr-only" role="status">{starting ? 'Starting the chat…' : ''}</p>
					{#if start_error}
						<p class="start-err" role="alert">
							Could not start the chat. {start_error} Your question is still in the box: send it again
							to retry.
						</p>
					{/if}

					{#if can_chat}
						<ul class="starters" aria-label="Starting points">
							{#each STARTERS as starter (starter)}
								<li>
									<button type="button" disabled={starting} onclick={() => useStarter(starter)}>
										{starter}
									</button>
								</li>
							{/each}
						</ul>
					{/if}
				{/if}

				<div class="work">
					{#if can_chat && recent_chats.length > 0}
						<!-- Narrow screens only: there the rail sits below the whole page. -->
						<section class="work-panel is-narrow-only" aria-labelledby="work-chats-hd">
							<div class="sec-hd">
								<h2 class="lbl" id="work-chats-hd">Recent chats</h2>
								<span class="rule"></span>
								<a class="work-all" href="#mate-rail"
									>All chats<ArrowRightIcon size={12} aria-hidden="true" /></a
								>
							</div>
							<ul class="work-list">
								{#each recent_chats as item (item.id)}
									<li>
										<a class="work-row is-plain" href={chatHref(item.id)}>
											<span class="work-ti">{item.title}</span>
											<span class="work-when mono-num">{relativeShort(item.updated_at)}</span>
										</a>
									</li>
								{/each}
							</ul>
						</section>
					{/if}

					{#if is_admin}
						<section class="work-panel" aria-labelledby="work-todos-hd">
							<div class="sec-hd">
								<h2 class="lbl" id="work-todos-hd">Todos</h2>
								{#if todo_src.value !== null}<span class="meta mono-num">{open_todos} open</span
									>{/if}
								<span class="rule"></span>
								<a class="work-all" href="/todos"
									>All todos<ArrowRightIcon size={12} aria-hidden="true" /></a
								>
							</div>
							{#if todo_src.value === null && todo_src.error}
								{@render failed('todos', todo_src.error, () => (live_seq += 1))}
							{:else if todo_src.value === null}
								{@render pending('todos')}
							{:else if home_todos.length === 0}
								<p class="work-empty">Nothing open. <a href="/todos">Capture a todo</a></p>
							{:else}
								<ul class="work-list">
									{#each home_todos as todo (todo.id)}
										<li class="work-row is-static">
											<PriorityChip priority={todo.priority} />
											<span class="work-ti">{todo.title}</span>
											{#if todo.due_at}
												<span
													class="work-when"
													class:is-late={(daysUntil(todo.due_at, new Date()) ?? 0) < 0}
													>{dueLabel(todo.due_at, new Date())}</span
												>
											{/if}
										</li>
									{/each}
								</ul>
							{/if}
							{@render stale(todo_src)}
							{#if ask_for.todos}{@render ask(ask_for.todos)}{/if}
						</section>
					{/if}

					<section class="work-panel" aria-labelledby="work-ready-hd">
						<div class="sec-hd">
							<h2 class="lbl" id="work-ready-hd">Ready</h2>
							{#if ready_src.value !== null}<span class="meta mono-num"
									>{ready_src.value.length}{ready_src.value.length >= 100 ? '+' : ''} ready</span
								>{/if}
							<span class="rule"></span>
							<a class="work-all" href="/ready"
								>Ready deck<ArrowRightIcon size={12} aria-hidden="true" /></a
							>
						</div>
						{#if ready_src.value === null && ready_src.error}
							{@render failed('ready issues', ready_src.error, () => (live_seq += 1))}
						{:else if ready_src.value === null}
							{@render pending('ready issues')}
						{:else if home_ready.length === 0}
							<p class="work-empty">No issue is ready to start in any project.</p>
						{:else}
							<ul class="work-list">
								{#each home_ready as issue (`${issue.project_id}:${issue.id}`)}
									<li>
										<a class="work-row" href="/p/{issue.project_id}/i/{issue.id}">
											<PriorityChip priority={issue.priority} />
											<span class="work-ti">{issue.title}</span>
											<span class="work-sub"><IssueId id={issue.id} /> · {issue.project_name}</span>
										</a>
									</li>
								{/each}
							</ul>
						{/if}
						{@render stale(ready_src)}
						{#if ask_for.ready}{@render ask(ask_for.ready)}{/if}
					</section>

					{#if agent.visible}
						<section class="work-panel" aria-labelledby="work-workers-hd">
							<div class="sec-hd">
								<h2 class="lbl" id="work-workers-hd">Workers</h2>
								{#if !loading && missions_error === null}<span class="meta mono-num"
										>{workers.working} working{#if workers.needs_you > 0}
											· {workers.needs_you} need you{/if}</span
									>{/if}
								<span class="rule"></span>
								<a class="work-all" href="/missions"
									>Missions<ArrowRightIcon size={12} aria-hidden="true" /></a
								>
							</div>
							{#if missions_error && missions.length === 0}
								{@render failed('workers', missions_error, () => void loadMissions())}
							{:else if loading}
								{@render pending('workers')}
							{:else if workers.rows.length === 0}
								<p class="work-empty">
									Nothing is running and nothing needs you. Ask an agent from an issue to start one.
								</p>
							{:else}
								<ul class="work-list">
									{#each workers.rows as mission (mission.id)}
										<li>
											<a class="work-row" href={threadHref(mission)}>
												<i class="dot dot-{dispatchBadgeKey(mission.status)}" aria-hidden="true"
												></i>
												<span class="work-ti">{mission.title ?? mission.project_name}</span>
												<span class="work-sub"
													>{missionStatusLabel(mission.status)} · {missionVerb(
														mission
													)}{#if mission.issue_id}
														· {mission.issue_id}{/if}</span
												>
											</a>
										</li>
									{/each}
								</ul>
							{/if}
							{#if ask_for.missions}{@render ask(ask_for.missions)}{/if}
						</section>
					{/if}
				</div>

				{#if mode === 'chat' || mode === 'placeholder'}
					<div class="notes">
						{#if runs_on?.crew}
							<p>
								<strong>Runs on {runs_on.label}, with crew tools.</strong>
								It reads every project, your todos and missions, routes todos and starts repo workers,
								acting as you{#if mate_chats.status?.reachable === false}. The runner is not
									answering right now{/if}.
							</p>
						{:else if runs_on}
							<p>
								<strong>Runs on {runs_on.label}.</strong>
								It works in its own Beads sandbox. Crew tools (your todos, missions, repo workers) are
								on Sand only{#if runs_on.sand_offered}: pick Sand under Runs on to use them{/if}{#if mate_chats.status?.reachable === false}.
									The runner is not answering right now{/if}.
							</p>
						{/if}
						{#if runs_on?.crew}
							<p>
								<strong>Beads changes go through missions.</strong>
								To file, comment or tackle, it starts a mission whose agent runs bd, and asks before starting
								more than one. It cannot delete anything.
								<span class="kbd">⌘K</span> runs a command without a chat.
							</p>
						{:else}
							<p>
								<strong>Changes go through bd.</strong>
								First Mate and its crew change Beads with bd, never behind its back.
								<span class="kbd">⌘K</span> runs a command without a chat.
							</p>
						{/if}
					</div>
				{/if}
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
		padding: 7px 8px;
		border-radius: var(--r-2);
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
		background: var(--s4);
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
	.start-banner {
		margin: 0 0 var(--s-4);
		font-size: var(--t-sm);
	}
	.start-err {
		margin: var(--s-2) 0 0;
		font-size: var(--t-sm);
		color: var(--danger-tx);
	}
	/* Starters, like a chat app's prompt chips: they fill the box, never send. */
	.starters {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-2);
		margin: var(--s-4) 0 0;
		padding: 0;
		list-style: none;
	}
	.starters button {
		padding: 6px 12px;
		background: var(--s1);
		border: 1px solid var(--line);
		border-radius: var(--r-2);
		color: var(--tx-mid);
		font: inherit;
		font-size: var(--t-sm);
		text-align: left;
		cursor: pointer;
		transition:
			background-color 0.12s ease-out,
			border-color 0.12s ease-out;
	}
	.starters button:hover:not(:disabled),
	.starters button:focus-visible {
		background: var(--s3);
		border-color: var(--line-2);
		color: var(--tx-hi);
	}
	.starters button:disabled {
		cursor: not-allowed;
		opacity: 0.6;
	}

	/* ---- the home: the viewer's work, each panel a way into it */
	.work {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 30ch), 1fr));
		gap: var(--s-5) var(--s-6);
		margin-top: var(--s-6);
	}
	.work-panel {
		display: flex;
		flex-direction: column;
		gap: var(--s-2);
		min-width: 0;
	}
	.work-panel .sec-hd {
		margin-bottom: 0;
	}
	.work-panel h2.lbl {
		margin: 0;
		font-size: var(--t-xs);
	}
	.work-all {
		display: inline-flex;
		align-items: center;
		gap: var(--s-1);
		font-size: var(--t-xs);
		color: var(--tx-mid);
		white-space: nowrap;
	}
	.work-all:hover,
	.work-all:focus-visible {
		color: var(--tx-hi);
	}
	.work-list {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.work-row {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: baseline;
		gap: 2px var(--s-2);
		margin: 0 calc(-1 * var(--s-2));
		padding: 6px var(--s-2);
		border-radius: var(--r-2);
		color: var(--tx);
		font-size: var(--t-sm);
		text-decoration: none;
		outline: none;
	}
	.work-row.is-plain {
		grid-template-columns: minmax(0, 1fr) auto;
	}
	a.work-row:hover,
	a.work-row:focus-visible {
		background: var(--s2);
		color: var(--tx-hi);
		text-decoration: none;
	}
	a.work-row:focus-visible {
		box-shadow: inset 0 0 0 1px var(--line-3);
	}
	.work-row .dot {
		align-self: center;
	}
	.work-ti {
		min-width: 0;
		line-height: 1.4;
		overflow-wrap: anywhere;
	}
	/* A link leads to the whole record, so its title may stop at two lines. */
	a.work-row .work-ti {
		display: -webkit-box;
		overflow: hidden;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
	}
	.work-when,
	.work-sub {
		font-size: var(--t-xs);
		color: var(--tx-dim);
	}
	.work-when {
		white-space: nowrap;
	}
	.work-when.is-late {
		color: var(--danger-tx);
		font-weight: 600;
	}
	.work-sub {
		grid-column: 2 / -1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.work-empty,
	.work-failed p {
		margin: 0;
		font-size: var(--t-sm);
		color: var(--tx-mid);
	}
	.work-failed {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-2) var(--s-3);
	}
	.work-failed p {
		color: var(--danger-tx);
	}
	.work-stale {
		margin: 0;
		font-size: var(--t-xs);
		color: var(--amber-tx);
	}
	.work-pending {
		display: grid;
		gap: var(--s-3);
		padding: var(--s-2) 0;
	}
	.work-pending .skel:last-child {
		width: 70%;
	}
	.work-ask {
		display: flex;
		flex-direction: column;
		gap: 2px;
		width: 100%;
		margin-top: var(--s-1);
		padding: var(--s-2) var(--s-3);
		background: var(--s2);
		border: 1px solid var(--line-2);
		border-radius: var(--r-2);
		font: inherit;
		text-align: left;
		cursor: pointer;
		transition:
			background-color 0.12s ease-out,
			border-color 0.12s ease-out;
	}
	.work-ask:hover:not(:disabled),
	.work-ask:focus-visible {
		background: var(--s3);
		border-color: var(--line-3);
	}
	.work-ask:disabled {
		cursor: not-allowed;
		opacity: 0.6;
	}
	.work-ask-lbl {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: var(--t-sm);
		font-weight: 600;
		color: var(--tx-hi);
	}
	.work-ask-q {
		font-size: var(--t-xs);
		color: var(--tx-mid);
	}
	@media (pointer: coarse) {
		.starters button,
		.work-ask,
		a.work-row,
		.work-all {
			min-height: 44px;
		}
	}
	@media (min-width: 901px) {
		.is-narrow-only {
			display: none;
		}
	}
	@media (max-width: 640px) {
		.cmd-lbl {
			display: none;
		}
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
