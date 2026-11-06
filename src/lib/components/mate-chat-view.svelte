<script lang="ts">
	/**
	 * One First Mate chat: the agent session's events grouped into bubbles,
	 * newest at the bottom, and the composer pinned under them. The agent can
	 * speak unasked, so a bubble of its own may follow another. Tool calls are
	 * compact chips, thinking folds away, errors sit inline. Stop interrupts
	 * the agent's current turn; the session keeps running.
	 */
	import { tick, untrack } from 'svelte';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import CommandIcon from '@lucide/svelte/icons/command';
	import SquareIcon from '@lucide/svelte/icons/square';
	import ChatComposer from '#lib/components/chat-composer.svelte';
	import MarkdownBody from '#lib/components/markdown-body.svelte';
	import MateContextSelect from '#lib/components/mate-context-select.svelte';
	import { absoluteStamp, relativeShort } from '#lib/client/format.js';
	import { groupMateEvents, type MatePart } from '#lib/client/mate-chat.js';
	import { mate_chats } from '#lib/client/mate-chat.svelte.js';
	import type { MateChat } from '#lib/mate.js';
	import { app_state } from '#lib/client/stores.svelte.js';

	interface Props {
		chat: MateChat;
		/** Bump to focus the composer. */
		focus_key?: number;
		onback: () => void;
		ondelete: () => Promise<void>;
	}

	let { chat, focus_key = 0, onback, ondelete }: Props = $props();

	let confirming_delete = $state(false);
	let deleting = $state(false);
	let delete_error = $state<string | null>(null);
	let delete_button = $state<HTMLButtonElement | null>(null);
	let keep_button = $state<HTMLButtonElement | null>(null);
	let follow_latest = $state(true);
	let textarea = $state<HTMLTextAreaElement | null>(null);
	let log_el = $state<HTMLDivElement | null>(null);

	// Most events replace the `chat` object (a newer `updated_at`); only a
	// different chat should move focus back to the composer.
	const chat_id = $derived(chat.id);
	const bubbles = $derived(groupMateEvents(mate_chats.events));
	const working = $derived(mate_chats.working);
	const connected = $derived(mate_chats.connected);

	const RESULT_NOTE: Record<string, string> = {
		failed: 'turn failed',
		cancelled: 'interrupted'
	};

	/** Consecutive tool calls render as one row of chips. */
	function runs(
		parts: MatePart[]
	): (MatePart | { kind: 'tools'; id: string; items: MatePart[] })[] {
		const out: (MatePart | { kind: 'tools'; id: string; items: MatePart[] })[] = [];
		for (const part of parts) {
			const last = out.at(-1);
			if (part.kind === 'tool') {
				if (last !== undefined && last.kind === 'tools') {
					last.items.push(part);
				} else {
					out.push({ kind: 'tools', id: part.id, items: [part] });
				}
			} else {
				out.push(part);
			}
		}
		return out;
	}

	function jumpToLatest() {
		follow_latest = true;
		log_el?.scrollTo({ top: log_el.scrollHeight });
	}
	function trackScroll() {
		if (log_el) follow_latest = log_el.scrollHeight - log_el.scrollTop - log_el.clientHeight < 64;
	}

	// Stay pinned to the bottom when the transcript or its viewport changes
	// size without new events: a narrower window, the on-screen keyboard
	// opening, a long reply reflowing. Scrolling here keeps following on.
	$effect(() => {
		const el = log_el;
		if (!el) return;
		const observer = new ResizeObserver(() => {
			if (follow_latest) el.scrollTo({ top: el.scrollHeight });
		});
		observer.observe(el);
		if (el.firstElementChild) observer.observe(el.firstElementChild);
		return () => observer.disconnect();
	});

	// Follow activity only while the reader is already at the bottom.
	$effect(() => {
		void mate_chats.events.length;
		void mate_chats.pending.length;
		void working;
		if (untrack(() => follow_latest)) {
			void tick().then(() => {
				// The reader may have scrolled away while the new activity rendered.
				if (follow_latest) log_el?.scrollTo({ top: log_el.scrollHeight });
			});
		}
	});

	$effect(() => {
		void focus_key;
		void chat_id;
		if (!mate_chats.opening) void tick().then(() => textarea?.focus({ preventScroll: true }));
	});

	async function deleteChat() {
		if (deleting) return;
		deleting = true;
		delete_error = null;
		try {
			await ondelete();
		} catch {
			delete_error = 'Could not delete this chat. It has been kept; try again.';
		} finally {
			deleting = false;
		}
	}
	function openDelete() {
		confirming_delete = true;
		delete_error = null;
		// Land on the safe choice, so Enter or Space keeps the chat.
		void tick().then(() => keep_button?.focus());
	}
	function cancelDelete() {
		confirming_delete = false;
		void tick().then(() => delete_button?.focus());
	}
	/** Escape dismisses the confirmation instead of closing the chat. */
	function confirmKeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape' || deleting) return;
		event.preventDefault();
		cancelDelete();
	}

	function send(message: string) {
		void mate_chats.send(chat.id, message);
		mate_chats.drafts[chat.id] = '';
		void tick().then(jumpToLatest);
	}
</script>

<section class="chat" aria-label={chat.title}>
	<header class="chat-col chat-hd">
		<button
			class="btn btn-sm btn-ghost btn-icon back"
			type="button"
			aria-label="Back to chats"
			title="Back (esc)"
			onclick={onback}
		>
			<ArrowLeftIcon size={14} strokeWidth={1.4} />
		</button>
		<div class="chat-ti">
			<h1>{chat.title}</h1>
			<p class="dim xs">
				Started <time datetime={chat.created_at} title={absoluteStamp(chat.created_at)}
					>{relativeShort(chat.created_at)}</time
				>
				· {bubbles.length}
				{bubbles.length === 1 ? 'message' : 'messages'}
			</p>
		</div>
		<button
			bind:this={delete_button}
			class="btn btn-sm btn-ghost"
			type="button"
			aria-expanded={confirming_delete}
			disabled={deleting}
			onclick={() => (confirming_delete ? cancelDelete() : openDelete())}>Delete chat</button
		>
	</header>

	{#if confirming_delete}
		<div class="chat-col delete-confirm">
			<p>Delete this chat and stop its session? Its saved messages will be removed.</p>
			{#if delete_error}<p class="err" role="alert">{delete_error}</p>{/if}
			<button
				class="btn btn-sm btn-danger"
				type="button"
				disabled={deleting}
				onkeydown={confirmKeydown}
				onclick={() => void deleteChat()}>{deleting ? 'Deleting…' : 'Delete permanently'}</button
			>
			<button
				bind:this={keep_button}
				class="btn btn-sm btn-ghost"
				type="button"
				disabled={deleting}
				onkeydown={confirmKeydown}
				onclick={cancelDelete}>Keep chat</button
			>
		</div>
	{/if}
	<!-- svelte-ignore a11y_no_noninteractive_tabindex (Scrollable transcript needs keyboard scrolling.) -->
	<div
		class="chat-scroll"
		bind:this={log_el}
		onscroll={trackScroll}
		tabindex="0"
		role="region"
		aria-label="Conversation, oldest first"
	>
		<ol class="chat-log chat-col" aria-live="polite" aria-busy={mate_chats.opening}>
			{#if mate_chats.opening}
				<li class="chat-event" role="status">Loading conversation…</li>
			{:else if !mate_chats.open_error && bubbles.length === 0 && mate_chats.pending.length === 0}
				<li class="chat-event">No messages yet. Send a message to start this conversation.</li>
			{/if}
			{#if !connected}
				<li class="chat-event">No model is connected yet. Replies are placeholders.</li>
			{/if}
			{#if mate_chats.open_error}
				<li class="chat-event err" role="alert">
					{mate_chats.open_error}
					<button
						class="btn btn-sm btn-ghost"
						type="button"
						onclick={() => void mate_chats.open(chat.id)}>Retry loading</button
					>
				</li>
			{/if}
			{#each bubbles as bubble (bubble.id)}
				<li
					class="chat-msg"
					class:is-you={bubble.role === 'you'}
					class:is-failed={bubble.result?.status === 'failed'}
				>
					<div class="chat-role">
						<span>{bubble.role === 'you' ? 'You' : 'First Mate'}</span>
						{#if bubble.result && RESULT_NOTE[bubble.result.status]}
							<span class="st">{RESULT_NOTE[bubble.result.status]}</span>
						{/if}
						<time datetime={bubble.at} title={absoluteStamp(bubble.at)}
							>{relativeShort(bubble.at)}</time
						>
					</div>
					{#if bubble.role === 'you'}
						{#each bubble.parts as part (part.id)}
							{#if part.kind === 'text'}<p class="chat-body">{part.text}</p>{/if}
						{/each}
					{:else}
						<div class="parts">
							{#each runs(bubble.parts) as part (part.id)}
								{#if part.kind === 'text'}
									<MarkdownBody source={part.text} class="chat-md" />
								{:else if part.kind === 'thinking'}
									<details class="thinking">
										<summary>Thinking</summary>
										<p>{part.text}</p>
									</details>
								{:else if part.kind === 'tools'}
									<ul class="tools" aria-label="Tool calls">
										{#each part.items as tool (tool.id)}
											{#if tool.kind === 'tool'}
												<li class="tool" class:is-running={tool.status === 'running'}>
													<code>{tool.name}</code>
													<span class="tool-status"> · {tool.status}</span>
												</li>
											{/if}
										{/each}
									</ul>
								{:else if part.kind === 'error'}
									<p class="err" role="status">{part.message}</p>
								{/if}
							{/each}
							{#if bubble.result?.git_pr_url}
								<p class="pr">
									<a href={bubble.result.git_pr_url} target="_blank" rel="noopener noreferrer"
										>Pull request</a
									>
								</p>
							{/if}
						</div>
					{/if}
				</li>
			{/each}
			{#each mate_chats.pending as item (item.message_id)}
				<li class="chat-msg is-you" class:is-failed={item.error !== undefined}>
					<div class="chat-role">
						<span>You</span>
						<span class="st"
							>{item.error
								? 'send not confirmed'
								: item.event_id
									? 'accepted · awaiting transcript'
									: 'sending'}</span
						>
					</div>
					<p class="chat-body is-dim">{item.text}</p>
					{#if item.error}
						<p class="err" role="alert">
							{item.error}
							<button
								class="btn btn-sm btn-ghost"
								type="button"
								onclick={() => mate_chats.retry(chat.id, item)}>Retry send</button
							>
							<button
								class="btn btn-sm btn-ghost"
								type="button"
								onclick={() => mate_chats.discard(item)}>Discard</button
							>
						</p>
					{/if}
				</li>
			{/each}
			{#if working}
				<li class="chat-msg">
					<div class="chat-role"><span>First Mate</span><span class="st">working</span></div>
					<p class="chat-body is-dim">
						<span class="chat-dots" aria-hidden="true"><i></i><i></i><i></i></span>Working…
					</p>
				</li>
			{/if}
			{#if mate_chats.stream_error}
				<li class="chat-event err" role="status">
					{mate_chats.stream_error}
					<button
						class="btn btn-sm btn-ghost"
						type="button"
						onclick={() => void mate_chats.open(chat.id)}>Reconnect</button
					>
				</li>
			{/if}
		</ol>
	</div>

	<div class="chat-col compose-dock">
		{#if !follow_latest}
			<button class="btn btn-sm btn-ghost" type="button" onclick={jumpToLatest}
				>Jump to latest</button
			>
		{/if}
		<p class="compose-status dim xs" role="status">
			{#if mate_chats.scope_saving}Saving scope…
			{:else if mate_chats.interrupt_requested}Stop requested. Waiting for the turn to finish.
			{:else}Scope applies to your next message.{/if}
		</p>
		{#if mate_chats.action_error}
			<p class="err" role="alert">{mate_chats.action_error}</p>
		{/if}
		<ChatComposer
			bind:value={mate_chats.drafts[chat.id]}
			bind:textarea
			label="Message First Mate"
			disabled={mate_chats.opening || !!mate_chats.open_error || mate_chats.scope_saving}
			reason={mate_chats.opening
				? 'Loading conversation…'
				: mate_chats.scope_saving
					? 'Saving scope…'
					: mate_chats.open_error
						? 'Load the conversation before sending.'
						: undefined}
			placeholder={working ? 'Add to what it is doing…' : 'Ask a follow-up…'}
			rows={2}
			onsend={send}
		>
			{#snippet controls()}
				<MateContextSelect
					value={chat.scope}
					disabled={mate_chats.scope_saving || mate_chats.opening}
					onchange={(scope) => void mate_chats.setScope(chat.id, scope)}
				/>
				<button
					class="btn btn-sm btn-ghost"
					type="button"
					title="Commands (⌘K)"
					onclick={() => app_state.openFirstMate()}
				>
					<CommandIcon size={12} strokeWidth={1.6} aria-hidden="true" /> Commands
				</button>
			{/snippet}
			{#snippet actions()}
				{#if connected && working}
					<button
						class="btn btn-sm btn-danger"
						type="button"
						disabled={mate_chats.interrupting || mate_chats.interrupt_requested}
						onclick={() => void mate_chats.interrupt(chat.id)}
						title="Interrupt the current turn; the session keeps running"
					>
						<SquareIcon size={12} strokeWidth={1.6} />
						{mate_chats.interrupting
							? 'Requesting stop…'
							: mate_chats.interrupt_requested
								? 'Stop requested'
								: 'Stop turn'}
					</button>
				{/if}
			{/snippet}
		</ChatComposer>
	</div>
</section>

<style>
	.chat {
		display: flex;
		flex-direction: column;
		min-height: 0;
		min-width: 0;
		height: 100%;
	}
	.chat-col {
		width: 100%;
		max-width: 76ch;
		margin: 0 auto;
	}
	.chat-hd {
		display: flex;
		align-items: flex-start;
		gap: var(--s-2);
		padding: 0 0 var(--s-3);
		margin-bottom: var(--s-4);
		border-bottom: 2px solid var(--rule);
	}
	.chat-ti {
		flex: 1;
		min-width: 0;
	}
	.chat-ti h1 {
		margin: 0 0 2px;
		font-size: var(--t-md);
		font-weight: 600;
		line-height: 1.35;
		color: var(--tx-hi);
		overflow-wrap: anywhere;
	}
	.chat-ti p {
		margin: 0;
	}
	.chat-scroll {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding-bottom: var(--s-5);
	}
	.compose-dock {
		flex: none;
	}
	.parts {
		display: flex;
		flex-direction: column;
		gap: var(--s-2);
	}
	.tools {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.tool {
		padding: 1px 6px;
		border: 1px solid var(--line);
		border-radius: var(--r-1);
		background: var(--s1);
		color: var(--tx-mid);
	}
	.tool.is-running {
		border-color: var(--line-3);
		color: var(--tx-hi);
	}
	.tool {
		overflow-wrap: anywhere;
		min-width: 0;
		max-width: 100%;
	}
	.tool-status {
		font-size: var(--t-xs);
	}
	.delete-confirm {
		padding-bottom: var(--s-3);
		font-size: var(--t-sm);
	}
	.compose-status {
		margin: var(--s-2) 0;
	}
	.tool code {
		font-family: var(--font-mono);
		font-size: var(--t-xs);
	}
	.thinking {
		font-size: var(--t-xs);
		color: var(--tx-dim);
	}
	.thinking summary {
		cursor: pointer;
	}
	.thinking p {
		margin: 4px 0 0;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.err {
		margin: 0;
		font-size: var(--t-sm);
		color: var(--danger-tx);
	}
	.pr {
		margin: 0;
		font-size: var(--t-sm);
	}
	@media (pointer: coarse) {
		.chat :global(.btn-sm),
		.thinking summary {
			min-height: 44px;
		}
	}
	@media (min-width: 901px) {
		.back {
			display: none;
		}
	}
</style>
