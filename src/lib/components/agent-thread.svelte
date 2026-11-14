<script lang="ts">
	/**
	 * One mission as a conversation: the stored turns, the
	 * run in progress, and a composer for the next message. Works with any
	 * provider. With live events the current run streams in; without them the
	 * thread polls status and the reply lands when the run finishes. A runner
	 * that cannot take follow-ups gets a disabled composer that says so. A
	 * loop mission adds its iteration table above the conversation; while it
	 * works, the composer steers it (a note for its next iteration) and it can
	 * stop after the current iteration or now (ADR-0019); once it has ended it
	 * can be restarted as a new run, optionally with a new iteration limit,
	 * from the same footer. Admins get
	 * the agent's live terminal above it too, on runners that relay one
	 * (ADR-0021).
	 *
	 * The transcript follows new output while the reader is at the bottom and
	 * stops when they scroll back, as a First Mate chat does. It is not a live
	 * region (the stream would be read out delta by delta); a status line
	 * announces each status change instead.
	 */
	import { tip } from '#lib/client/tooltip.js';
	import { tick, untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import ArrowClockwiseIcon from 'phosphor-svelte/lib/ArrowClockwiseIcon';
	import ArrowDownIcon from 'phosphor-svelte/lib/ArrowDownIcon';
	import ArrowSquareOutIcon from 'phosphor-svelte/lib/ArrowSquareOutIcon';
	import GitPullRequestIcon from 'phosphor-svelte/lib/GitPullRequestIcon';
	import SkipForwardIcon from 'phosphor-svelte/lib/SkipForwardIcon';
	import SquareIcon from 'phosphor-svelte/lib/SquareIcon';
	import ChatComposer from '#lib/components/chat-composer.svelte';
	import LoopIterations from '#lib/components/loop-iterations.svelte';
	import MarkdownBody from '#lib/components/markdown-body.svelte';
	import MissionLiveStream from '#lib/components/mission-live-stream.svelte';
	import MissionStatus, { missionStatusLabel } from '#lib/components/mission-status.svelte';
	import TerminalView from '#lib/components/terminal-view.svelte';
	import { api, errorMessage } from '#lib/client/api.js';
	import {
		canRestartLoop,
		composerState,
		formatElapsed,
		isBusyStatus,
		isFollowedMission,
		missionProvider,
		isSafeRunUrl,
		missionVerb,
		THREAD_POLL_MS
	} from '#lib/client/agent.js';
	import { absoluteStamp, relativeShort } from '#lib/client/format.js';
	import { iterationLimitError } from '#lib/client/loop.js';
	import { agentChoiceLine } from '#lib/client/agent-choice.js';
	import { currentViewer, statusSnapshot } from '#lib/client/projects.svelte.js';
	import type { DispatchRequest, DispatchTurn, LoopIteration } from '#lib/types.js';

	interface Props {
		project_id: string;
		request_id: string;
		/** What the caller already knows, painted before the first fetch lands. */
		initial?: DispatchRequest;
		/** Show the verb/status header (the dialog has its own). */
		show_header?: boolean;
		/** Focus the composer once the thread can take a message. */
		autofocus?: boolean;
		onupdated?: (request: DispatchRequest) => void;
	}

	let {
		project_id,
		request_id,
		initial,
		show_header = true,
		autofocus = false,
		onupdated
	}: Props = $props();

	let mission = $state<DispatchRequest | undefined>(untrack(() => initial));
	let turns = $state<DispatchTurn[]>([]);
	let loaded = $state(false);
	let load_error = $state<string | null>(null);
	let text = $state('');
	let sending = $state(false);
	let cancelling = $state(false);
	let winding_down = $state(false);
	let restarting = $state(false);
	/** The new run's iteration limit, as typed; starts at the loop's stored one. */
	let restart_limit = $state('');
	let now = $state(Date.now());
	let composer_el = $state<HTMLTextAreaElement | null>(null);
	let list_el = $state<HTMLDivElement | null>(null);
	let iterations = $state<LoopIteration[]>([]);
	let iterations_loaded = $state(false);
	let iterations_error = $state<string | null>(null);
	/** Bumps when a new run starts, so the live stream reconnects. */
	let run_generation = $state(0);

	const dispatch = $derived(statusSnapshot()?.dispatch ?? null);
	// Each thread follows the runner that launched it, not the default one.
	const capabilities = $derived(
		mission === undefined ? undefined : missionProvider(mission, dispatch)?.capabilities
	);
	// A run nothing follows any more (its provider was removed) is not working:
	// no working turn, polling, live stream, or Cancel.
	const busy = $derived(
		mission !== undefined && isBusyStatus(mission.status) && isFollowedMission(mission, dispatch)
	);
	const composer = $derived(
		mission === undefined
			? { can_send: false, reason: 'Loading…' }
			: composerState(mission, dispatch)
	);
	const live = $derived(
		busy && capabilities?.live_events === true && mission?.agent_id !== undefined
	);
	const can_cancel = $derived(
		busy && capabilities?.cancel === true && mission?.agent_id !== undefined
	);
	const is_loop = $derived(mission?.operation === 'loop');
	/** A loop shows its model and effort among its flags (LoopIterations). */
	const choice_line = $derived(
		mission === undefined || is_loop ? undefined : agentChoiceLine(mission)
	);
	// A loop's steer notes carry the run they steer; the turns that start a
	// run (the launch, a restart) carry none, so the latest of those is when
	// the current run began.
	const started_at = $derived.by(() => {
		const operator = turns.filter((turn) => turn.role === 'operator');
		const start = is_loop
			? operator.findLast((turn) => turn.run_id === undefined)
			: operator.at(-1);
		return Date.parse(start?.created_at ?? mission?.updated_at ?? '') || now;
	});
	const stop_requested = $derived(is_loop && mission?.loop?.stop_requested === true);
	const can_wind_down = $derived(is_loop && can_cancel && capabilities?.loop === true);
	const can_restart = $derived(mission !== undefined && canRestartLoop(mission, dispatch));
	const restart_error = $derived(
		restart_limit.trim() === '' ? undefined : iterationLimitError(restart_limit)
	);
	// The relay names the mission; the server finds its sandbox. A mission that
	// never started an agent has no terminal to open.
	const show_terminal = $derived(
		currentViewer()?.role === 'admin' &&
			capabilities?.terminal === true &&
			mission?.agent_id !== undefined
	);
	const run_url = $derived(isSafeRunUrl(mission?.agent_url) ? mission?.agent_url : undefined);
	const pr_url = $derived(isSafeRunUrl(mission?.git_pr_url) ? mission?.git_pr_url : undefined);
	/** The working row's word: the stored status, never more (design standards 9). */
	const phase = $derived(mission === undefined ? 'queued' : missionStatusLabel(mission.status));
	/** A run that failed before any agent started has no thread to continue. */
	const never_started = $derived(
		loaded && mission?.status === 'failed' && mission.agent_id === undefined
	);
	/** Follow new output only while the reader is at the bottom. */
	let follow_latest = $state(true);
	/** Read out when the status changes, so a screen reader hears progress without the deltas. */
	let announcement = $state('');
	let announced: string | undefined;

	async function refresh(signal?: AbortSignal) {
		try {
			// In order: the status read records a finished run's reply, so the
			// turns read after it includes that reply.
			const record = await api.dispatch(project_id, request_id, { signal });
			const history = await api.dispatchTurns(project_id, request_id, { signal });
			if (signal?.aborted) {
				return;
			}
			mission = record.request;
			turns = history.turns;
			load_error = null;
			onupdated?.(record.request);
			if (record.request.operation === 'loop') {
				await refreshIterations(signal);
			}
		} catch (error) {
			if (!signal?.aborted) {
				load_error = errorMessage(error);
			}
		} finally {
			if (!signal?.aborted) {
				loaded = true;
			}
		}
	}

	/**
	 * A loop's finished iterations. A failed read keeps the rows already
	 * shown and says so beside them.
	 */
	async function refreshIterations(signal?: AbortSignal) {
		try {
			const result = await api.dispatchIterations(project_id, request_id, { signal });
			if (signal?.aborted) {
				return;
			}
			iterations = result.iterations;
			iterations_error = null;
		} catch (error) {
			if (!signal?.aborted) {
				iterations_error = errorMessage(error);
			}
		} finally {
			if (!signal?.aborted) {
				iterations_loaded = true;
			}
		}
	}

	// Load on mount and whenever the thread changes.
	$effect(() => {
		void request_id;
		restart_limit = '';
		follow_latest = true;
		const ac = new AbortController();
		loaded = false;
		turns = [];
		iterations = [];
		iterations_loaded = false;
		iterations_error = null;
		void refresh(ac.signal);
		return () => ac.abort();
	});

	// Poll while the agent works. Live streams still poll, slower, because the
	// durable status (and the stored reply) is what the transcript shows.
	$effect(() => {
		if (!busy) {
			return;
		}
		const every = live ? THREAD_POLL_MS * 3 : THREAD_POLL_MS;
		const poll = setInterval(() => void refresh(), every);
		const tick = setInterval(() => (now = Date.now()), 1000);
		return () => {
			clearInterval(poll);
			clearInterval(tick);
		};
	});

	// Live events carry no iteration boundaries, so a running loop's table
	// polls at the thread's quick pace even when the status poll slows down.
	$effect(() => {
		if (!busy || !is_loop || !live) {
			return;
		}
		const poll = setInterval(() => void refreshIterations(), THREAD_POLL_MS);
		return () => clearInterval(poll);
	});

	// Offer the loop's own limit until the operator types another.
	$effect(() => {
		const stored = mission?.loop?.max_iterations;
		if (restart_limit === '' && stored !== undefined) {
			untrack(() => (restart_limit = String(stored)));
		}
	});

	// Keep the newest output in view while following: new turns, the live
	// stream growing, a reply reflowing, the window resizing. Scrolling up
	// stops following until the reader comes back down or jumps.
	$effect(() => {
		const el = list_el;
		if (!el) {
			return;
		}
		const observer = new ResizeObserver(() => {
			if (follow_latest) {
				el.scrollTo({ top: el.scrollHeight });
			}
		});
		observer.observe(el);
		if (el.firstElementChild) {
			observer.observe(el.firstElementChild);
		}
		return () => observer.disconnect();
	});

	let last_top = 0;

	function trackScroll() {
		if (!list_el) {
			return;
		}
		const top = list_el.scrollTop;
		const gap = list_el.scrollHeight - top - list_el.clientHeight;
		// Any move up is the reader leaving, however small: waiting for the
		// threshold lets the next streamed line snap a slow drag back down.
		// (A gap this small is the list shrinking, not a scroll.)
		follow_latest = !(gap >= 64 || (top < last_top - 1 && gap > 4));
		last_top = top;
	}

	function jumpToLatest() {
		follow_latest = true;
		list_el?.scrollTo({ top: list_el.scrollHeight });
	}

	// Announce status changes after the first load, not the status it opened on.
	$effect(() => {
		const current = mission;
		if (current === undefined || !loaded) {
			return;
		}
		const key = `${current.id}:${current.status}`;
		if (announced === key) {
			return;
		}
		const first = announced === undefined || !announced.startsWith(`${current.id}:`);
		announced = key;
		if (first) {
			return;
		}
		const parts = [`${missionVerb(current)} ${missionStatusLabel(current.status)}.`];
		if (current.status === 'failed' && current.error_message) {
			parts.push(current.error_message);
		}
		if (isSafeRunUrl(current.git_pr_url) && !isBusyStatus(current.status)) {
			parts.push('It has a pull request.');
		}
		announcement = parts.join(' ');
	});

	$effect(() => {
		if (autofocus && loaded && composer.can_send) {
			composer_el?.focus();
		}
	});

	async function send() {
		const message = text.trim();
		if (!composer.can_send || sending || message.length === 0) {
			return;
		}
		sending = true;
		try {
			if (is_loop) {
				// A steer joins the running loop: the live stream keeps going.
				const result = await api.steerDispatch(project_id, request_id, { text: message });
				mission = result.request;
				text = '';
				onupdated?.(result.request);
				toast.success('Steer note queued', {
					description: 'The loop reads it at the start of its next iteration.'
				});
			} else {
				const result = await api.followUpDispatch(project_id, request_id, { text: message });
				mission = result.request;
				text = '';
				run_generation += 1;
				onupdated?.(result.request);
			}
			void tick().then(jumpToLatest);
			await refresh();
		} catch (error) {
			toast.error(is_loop ? 'Could not steer the loop' : 'Could not send the message', {
				description: errorMessage(error)
			});
		} finally {
			sending = false;
		}
	}

	async function windDown() {
		if (!can_wind_down || stop_requested || winding_down) {
			return;
		}
		winding_down = true;
		try {
			const result = await api.stopDispatchAfterIteration(project_id, request_id);
			mission = result.request;
			onupdated?.(result.request);
			await refresh();
		} catch (error) {
			toast.error('Could not stop the loop', { description: errorMessage(error) });
		} finally {
			winding_down = false;
		}
	}

	/**
	 * Start a new run of the ended loop. The limit is sent only when it
	 * differs from the loop's own, so the transcript says when it changed.
	 */
	async function restart() {
		if (!can_restart || restarting) {
			return;
		}
		const text = restart_limit.trim();
		if (text !== '' && iterationLimitError(text) !== undefined) {
			return;
		}
		const limit = text === '' ? undefined : Number(text);
		restarting = true;
		try {
			const result = await api.restartDispatch(
				project_id,
				request_id,
				limit === undefined || limit === mission?.loop?.max_iterations
					? {}
					: { max_iterations: limit }
			);
			mission = result.request;
			run_generation += 1;
			onupdated?.(result.request);
			await refresh();
		} catch (error) {
			toast.error('Could not restart the loop', { description: errorMessage(error) });
			// The mission may have recorded why; show it.
			await refresh();
		} finally {
			restarting = false;
		}
	}

	function onLimitKeydown(event: KeyboardEvent) {
		// The field sits inside the composer's form: Enter restarts, never sends.
		if (event.key === 'Enter') {
			event.preventDefault();
			void restart();
		}
	}

	async function cancel() {
		if (!can_cancel || cancelling) {
			return;
		}
		cancelling = true;
		try {
			const result = await api.cancelDispatch(project_id, request_id);
			mission = result.request;
			onupdated?.(result.request);
			await refresh();
		} catch (error) {
			toast.error('Could not stop the run', { description: errorMessage(error) });
		} finally {
			cancelling = false;
		}
	}
</script>

<section class="athread" aria-label="Agent conversation" aria-busy={!loaded || busy}>
	{#if show_header && mission}
		<header class="th-hd">
			<span class="verb">{missionVerb(mission)}</span>
			<MissionStatus status={mission.status} live={isFollowedMission(mission, dispatch)} />
			{#if mission.duration_ms !== undefined && !busy}
				<span class="faint mono-num" {@attach tip('Run time')}
					>{formatElapsed(mission.duration_ms)}</span
				>
			{/if}
			{#if choice_line}
				<span class="faint choice" {@attach tip('Model · effort')}>{choice_line}</span>
			{/if}
			<span class="spacer"></span>
			{#if pr_url}
				<a class="btn btn-sm btn-ghost pr" href={pr_url} target="_blank" rel="noopener noreferrer">
					<GitPullRequestIcon size={13} aria-hidden="true" />Pull request
				</a>
			{/if}
			{#if run_url}
				<a
					class="btn btn-sm btn-ghost btn-icon"
					href={run_url}
					target="_blank"
					rel="noopener noreferrer"
					aria-label="Open the run on the agent runner"
					{@attach tip('Open the run')}
				>
					<ArrowSquareOutIcon size={14} />
				</a>
			{/if}
		</header>
	{/if}

	{#if load_error && !loaded}
		<p class="err" role="alert">{load_error}</p>
	{/if}

	{#if is_loop && mission?.loop}
		<LoopIterations
			loop={mission.loop}
			{iterations}
			loaded={iterations_loaded}
			error={iterations_error}
			{busy}
			onretry={() => void refreshIterations()}
		/>
	{/if}

	{#if show_terminal && mission}
		<TerminalView
			target={{ mission: mission.id }}
			subject={is_loop ? "this loop's" : "this mission's agent's"}
		/>
	{/if}

	<p class="sr-only" role="status">{announcement}</p>

	<div class="turns" bind:this={list_el} onscroll={trackScroll}>
		<ol class="chat-log">
			{#each turns as turn (turn.seq)}
				<li
					class="chat-msg"
					class:is-you={turn.role === 'operator'}
					class:is-failed={turn.status === 'failed'}
				>
					<div class="chat-role">
						<span>{turn.role === 'operator' ? 'You' : 'Agent'}</span>
						{#if is_loop && turn.role === 'operator' && turn.run_id !== undefined}
							<span class="st" {@attach tip('A note for the next iteration')}>steer</span>
						{/if}
						{#if turn.status && turn.status !== 'succeeded'}
							<span class="st">{missionStatusLabel(turn.status)}</span>
						{/if}
						<time datetime={turn.created_at} {@attach tip(absoluteStamp(turn.created_at))}
							>{relativeShort(turn.created_at)}</time
						>
					</div>
					{#if turn.role === 'agent'}
						<MarkdownBody source={turn.text} />
					{:else}
						<p class="chat-body">{turn.text}</p>
					{/if}
				</li>
			{/each}
			{#if busy}
				<li class="chat-msg">
					<div class="chat-role">
						<span>Agent</span>
						<span class="st">{phase}</span>
						<span class="when mono-num" {@attach tip('Time since this run was asked for')}
							>{formatElapsed(Math.max(0, now - started_at))}</span
						>
					</div>
					{#if live && mission}
						{#key run_generation}
							<div class="live">
								<MissionLiveStream {project_id} request_id={mission.id} />
							</div>
						{/key}
					{:else}
						<p class="chat-body is-dim">
							<span class="chat-dots" aria-hidden="true"><i></i><i></i><i></i></span
							>{mission?.status === 'queued'
								? 'Waiting to start.'
								: mission?.status === 'launching'
									? 'Asking the runner to start the agent.'
									: 'The reply appears here when the run finishes.'}
						</p>
					{/if}
				</li>
			{/if}
			{#if never_started && mission}
				<li class="chat-event">
					No agent started, so this thread cannot continue.
					{#if mission.issue_id}
						<a
							href="/p/{encodeURIComponent(mission.project_id)}/i/{encodeURIComponent(
								mission.issue_id
							)}">Open {mission.issue_id}</a
						> to launch again.
					{:else}
						<a href="/p/{encodeURIComponent(mission.project_id)}">Open the project</a> to launch again.
					{/if}
				</li>
			{:else if loaded && turns.length === 0 && !busy}
				<li class="chat-event">No messages yet.</li>
			{/if}
		</ol>
	</div>

	{#if !follow_latest}
		<div class="older">
			<span class="older-lbl"
				>{busy ? 'The agent is still working below' : 'Viewing earlier messages'}</span
			>
			<button class="btn btn-sm btn-ghost" type="button" onclick={jumpToLatest}>
				Jump to latest <ArrowDownIcon size={12} aria-hidden="true" />
			</button>
		</div>
	{/if}

	<ChatComposer
		bind:value={text}
		bind:textarea={composer_el}
		label={is_loop ? 'Steer the loop' : 'Message the agent'}
		placeholder={is_loop ? 'A note for the next iteration…' : 'Reply to the agent…'}
		submit_label={is_loop ? 'Steer' : 'Send'}
		rows={2}
		disabled={!composer.can_send}
		reason={composer.reason}
		busy={sending}
		onsend={() => void send()}
	>
		{#snippet actions()}
			{#if can_restart}
				<span class="restart">
					<label class="restart-limit">
						<span class="lbl">Iterations</span>
						<input
							class="input mono-num"
							class:is-invalid={restart_error !== undefined}
							type="text"
							inputmode="numeric"
							autocomplete="off"
							size="3"
							bind:value={restart_limit}
							disabled={restarting}
							aria-invalid={restart_error !== undefined}
							aria-describedby={restart_error === undefined ? undefined : 'restart-limit-err'}
							onkeydown={onLimitKeydown}
						/>
					</label>
					<button
						class="btn btn-sm"
						type="button"
						disabled={restarting || restart_error !== undefined}
						onclick={restart}
						{@attach tip('Run the loop again on this mission, with its settings')}
					>
						<ArrowClockwiseIcon size={12} aria-hidden="true" />
						{restarting ? 'Restarting…' : 'Restart'}
					</button>
					{#if restart_error}
						<span class="err restart-err" id="restart-limit-err" role="alert">{restart_error}</span>
					{/if}
				</span>
			{/if}
			{#if can_wind_down}
				<button
					class="btn btn-sm"
					type="button"
					disabled={stop_requested || winding_down || cancelling}
					onclick={windDown}
					{@attach tip(
						stop_requested
							? 'The loop stops when its current iteration ends'
							: 'Let the current iteration finish, then stop'
					)}
				>
					<SkipForwardIcon size={12} aria-hidden="true" />
					{stop_requested
						? 'Stopping after this iteration'
						: winding_down
							? 'Asking…'
							: 'Stop after iteration'}
				</button>
			{/if}
			{#if can_cancel}
				<button
					class="btn btn-sm btn-danger"
					type="button"
					disabled={cancelling}
					onclick={cancel}
					{@attach tip(is_loop ? 'End the loop now, mid-iteration' : 'Stop the run')}
				>
					<SquareIcon size={12} aria-hidden="true" />
					{cancelling ? 'Stopping…' : is_loop ? 'Stop now' : 'Stop'}
				</button>
			{/if}
		{/snippet}
	</ChatComposer>
</section>

<style>
	.athread {
		display: flex;
		flex-direction: column;
		min-height: 0;
		flex: 1;
		gap: var(--s-3);
	}
	.th-hd {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-2);
		min-height: 28px;
	}
	.choice {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--t-xs);
	}
	.verb {
		font-weight: 600;
		color: var(--tx-hi);
		font-size: var(--t-sm);
	}
	.spacer {
		flex: 1;
	}
	.turns {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding-bottom: var(--s-3);
	}
	.pr {
		gap: 5px;
	}
	.live {
		min-width: 0;
	}
	/* The First Mate chat's "viewing older messages" bar, so both read alike. */
	.older {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--s-2);
		padding: 2px 2px 2px var(--s-3);
		border-radius: var(--r-2);
		background: var(--s3);
		font-size: var(--t-xs);
		color: var(--tx-mid);
	}
	.older-lbl {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	@media (pointer: coarse) {
		.pr,
		.older .btn {
			min-height: 44px;
		}
	}
	.err {
		font-size: var(--t-xs);
		color: var(--danger-tx);
	}
	.restart {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-2);
	}
	.restart-limit {
		display: inline-flex;
		align-items: center;
		gap: var(--s-1);
	}
	.restart-limit .lbl {
		font-size: var(--t-xs);
		color: var(--tx-dim);
	}
	/* Sized to the footer's small buttons; three digits fit. */
	.restart-limit .input {
		width: calc(4ch + 20px);
		height: 28px;
		font-size: var(--t-xs);
		text-align: right;
	}
	@media (pointer: coarse) {
		.restart-limit .input {
			height: 44px;
		}
	}
	.restart-err {
		flex-basis: 100%;
	}
</style>
