<script lang="ts">
	/**
	 * One mission as a conversation: the stored turns, the
	 * run in progress, and a composer for the next message. Works with any
	 * provider. With live events the current run streams in; without them the
	 * thread polls status and the reply lands when the run finishes. A runner
	 * that cannot take follow-ups gets a disabled composer that says so.
	 */
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import GitPullRequestIcon from '@lucide/svelte/icons/git-pull-request';
	import SendIcon from '@lucide/svelte/icons/send-horizontal';
	import SquareIcon from '@lucide/svelte/icons/square';
	import MarkdownBody from '$lib/components/markdown-body.svelte';
	import MissionLiveStream from '$lib/components/mission-live-stream.svelte';
	import MissionStatus from '$lib/components/mission-status.svelte';
	import { api, errorMessage } from '$lib/client/api';
	import {
		composerState,
		formatElapsed,
		isBusyStatus,
		isFollowedMission,
		isSafeRunUrl,
		missionVerb,
		THREAD_POLL_MS
	} from '$lib/client/agent';
	import { absoluteStamp, relativeShort } from '$lib/client/format';
	import { statusSnapshot } from '$lib/client/projects.svelte';
	import type { DispatchRequest, DispatchTurn } from '$lib/types';

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
	let now = $state(Date.now());
	let composer_el = $state<HTMLTextAreaElement | null>(null);
	let list_el = $state<HTMLOListElement | null>(null);
	/** Bumps when a new run starts, so the live stream reconnects. */
	let run_generation = $state(0);

	const dispatch = $derived(statusSnapshot()?.dispatch ?? null);
	const capabilities = $derived(dispatch?.capabilities);
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
	const started_at = $derived.by(() => {
		const last_operator = [...turns].reverse().find((turn) => turn.role === 'operator');
		return Date.parse(last_operator?.created_at ?? mission?.updated_at ?? '') || now;
	});
	const run_url = $derived(isSafeRunUrl(mission?.agent_url) ? mission?.agent_url : undefined);

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

	// Load on mount and whenever the thread changes.
	$effect(() => {
		void request_id;
		const ac = new AbortController();
		loaded = false;
		turns = [];
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

	// Keep the newest turn in view.
	$effect(() => {
		void turns.length;
		void busy;
		requestAnimationFrame(() => {
			list_el?.lastElementChild?.scrollIntoView({ block: 'nearest' });
		});
	});

	$effect(() => {
		if (autofocus && loaded && composer.can_send) {
			composer_el?.focus();
		}
	});

	async function send(event?: SubmitEvent) {
		event?.preventDefault();
		const message = text.trim();
		if (!composer.can_send || sending || message.length === 0) {
			return;
		}
		sending = true;
		try {
			const result = await api.followUpDispatch(project_id, request_id, { text: message });
			mission = result.request;
			text = '';
			run_generation += 1;
			onupdated?.(result.request);
			await refresh();
		} catch (error) {
			toast.error('Could not send the message', { description: errorMessage(error) });
		} finally {
			sending = false;
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

	function onComposerKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			void send();
		}
	}
</script>

<section class="athread" aria-label="Agent conversation" aria-busy={!loaded || busy}>
	{#if show_header && mission}
		<header class="th-hd">
			<span class="verb">{missionVerb(mission)}</span>
			<MissionStatus status={mission.status} />
			{#if mission.duration_ms !== undefined && !busy}
				<span class="faint mono-num" title="Run time">{formatElapsed(mission.duration_ms)}</span>
			{/if}
			<span class="spacer"></span>
			{#if mission.git_pr_url}
				<a
					class="btn btn-sm btn-ghost btn-icon"
					href={mission.git_pr_url}
					target="_blank"
					rel="noopener noreferrer"
					aria-label="Open the pull request"
					title="Pull request"
				>
					<GitPullRequestIcon size={14} strokeWidth={1.4} />
				</a>
			{/if}
			{#if run_url}
				<a
					class="btn btn-sm btn-ghost btn-icon"
					href={run_url}
					target="_blank"
					rel="noopener noreferrer"
					aria-label="Open the run on the agent runner"
					title="Open the run"
				>
					<ExternalLinkIcon size={14} strokeWidth={1.4} />
				</a>
			{/if}
		</header>
	{/if}

	{#if load_error && !loaded}
		<p class="err" role="alert">{load_error}</p>
	{/if}

	<ol class="turns" bind:this={list_el} aria-live="polite">
		{#each turns as turn (turn.seq)}
			<li class="turn turn-{turn.role}" class:is-failed={turn.status === 'failed'}>
				<div class="who">
					<span>{turn.role === 'operator' ? 'you' : 'agent'}</span>
					{#if turn.status && turn.status !== 'succeeded'}
						<span class="st">{turn.status}</span>
					{/if}
					<time datetime={turn.created_at} title={absoluteStamp(turn.created_at)}
						>{relativeShort(turn.created_at)}</time
					>
				</div>
				{#if turn.role === 'agent'}
					<MarkdownBody source={turn.text} class="turn-prose" />
				{:else}
					<p class="said">{turn.text}</p>
				{/if}
			</li>
		{/each}
		{#if busy}
			<li class="turn turn-agent is-working">
				<div class="who">
					<span>agent</span>
					<span class="st">working</span>
					<span class="mono-num">{formatElapsed(Math.max(0, now - started_at))}</span>
				</div>
				{#if live && mission}
					{#key run_generation}
						<div class="live">
							<MissionLiveStream {project_id} request_id={mission.id} />
						</div>
					{/key}
				{:else}
					<p class="said dim">
						<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
						The reply appears here when the run finishes.
					</p>
				{/if}
			</li>
		{/if}
		{#if loaded && turns.length === 0 && !busy}
			<li class="turn"><p class="said dim">No messages yet.</p></li>
		{/if}
	</ol>

	<form class="compose" onsubmit={send}>
		<textarea
			bind:this={composer_el}
			bind:value={text}
			class="compose-in"
			rows={2}
			maxlength={4000}
			aria-label="Message the agent"
			placeholder={composer.can_send ? 'Reply to the agent…' : ''}
			disabled={!composer.can_send || sending}
			onkeydown={onComposerKeydown}></textarea>
		<div class="compose-ft">
			{#if !composer.can_send && composer.reason}
				<span class="why">{composer.reason}</span>
			{:else}
				<span class="why faint"><span class="kbd">⌘⏎</span> send</span>
			{/if}
			<span class="spacer"></span>
			{#if can_cancel}
				<button
					class="btn btn-sm btn-danger"
					type="button"
					disabled={cancelling}
					onclick={cancel}
					title="Stop the run"
				>
					<SquareIcon size={12} strokeWidth={1.6} />
					{cancelling ? 'Stopping…' : 'Stop'}
				</button>
			{/if}
			<button
				class="btn btn-sm btn-primary btn-icon"
				type="submit"
				disabled={!composer.can_send || sending || text.trim().length === 0}
				aria-label="Send"
				title="Send (⌘⏎)"
			>
				<SendIcon size={14} strokeWidth={1.6} />
			</button>
		</div>
	</form>
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
		align-items: center;
		gap: var(--s-2);
		min-height: 28px;
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
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--s-3);
		overflow-y: auto;
		min-height: 0;
		flex: 1;
	}
	.turn {
		border-left: 2px solid var(--line-2);
		padding: 2px 0 2px var(--s-3);
		min-width: 0;
	}
	.turn-operator {
		border-left-color: var(--em-700);
	}
	.turn-agent {
		border-left-color: var(--cyan-line);
	}
	.turn.is-failed {
		border-left-color: var(--danger);
	}
	.turn.is-working {
		border-left-style: dashed;
	}
	.who {
		display: flex;
		align-items: baseline;
		gap: var(--s-2);
		font-size: var(--t-xs);
		color: var(--tx-dim);
		margin-bottom: 3px;
	}
	.who time {
		margin-left: auto;
		letter-spacing: 0;
		text-transform: none;
		color: var(--tx-dim);
	}
	.who .st {
		color: var(--amber-tx);
	}
	.turn.is-failed .who .st {
		color: var(--danger-tx);
	}
	.said {
		margin: 0;
		font-size: var(--t-sm);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		color: var(--tx-hi);
	}
	.said.dim {
		color: var(--tx-dim);
	}
	.turn :global(.turn-prose) {
		font-size: var(--t-sm);
		max-width: none;
	}
	.live {
		max-height: 320px;
		overflow-y: auto;
	}
	.dots {
		display: inline-flex;
		gap: 3px;
		margin-right: 6px;
		vertical-align: middle;
	}
	.dots i {
		width: 4px;
		height: 4px;
		border-radius: 99px;
		background: var(--cyan);
		animation: bdui-pulse 1.2s ease-in-out infinite;
	}
	.dots i:nth-child(2) {
		animation-delay: 0.2s;
	}
	.dots i:nth-child(3) {
		animation-delay: 0.4s;
	}
	.compose {
		flex: none;
		border: 1px solid var(--line);
		border-radius: var(--r-2);
		background: var(--s2);
		padding: var(--s-2) var(--s-3);
	}
	.compose:focus-within {
		border-color: var(--line-2);
	}
	.compose-in {
		width: 100%;
		background: none;
		border: 0;
		outline: none;
		resize: vertical;
		min-height: 40px;
		font-size: var(--t-sm);
		line-height: 1.55;
		color: var(--tx-hi);
	}
	.compose-in::placeholder {
		color: var(--tx-faint);
	}
	.compose-in:disabled {
		cursor: not-allowed;
	}
	.compose-ft {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		margin-top: 4px;
	}
	.why {
		font-size: var(--t-xs);
		color: var(--tx-dim);
	}
	.err {
		font-size: var(--t-xs);
		color: var(--danger-tx);
	}
	@media (pointer: coarse) {
		.compose-ft :global(.btn-sm) {
			height: 32px;
			min-width: 32px;
		}
	}
</style>
