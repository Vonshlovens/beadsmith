<script lang="ts">
	/**
	 * One First Mate chat, laid out like a chat app: messages run down the
	 * page, newest at the bottom, with the composer pinned under them. A run
	 * of messages from one sender shares a header (avatar and time); a new day
	 * gets a divider. Names stay available to assistive technology but are
	 * not repeated on screen: in a chat between you and First Mate the avatar
	 * already says who spoke.
	 *
	 * The agent can speak unasked, so one of its messages may follow another.
	 * Tool calls are compact chips, thinking folds away, errors sit inline.
	 * Stop interrupts the agent's current turn; the session keeps running.
	 */
	import { tip } from '#lib/client/tooltip.js';
	import { tick, untrack } from 'svelte';
	import ArrowDownIcon from 'phosphor-svelte/lib/ArrowDownIcon';
	import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeftIcon';
	import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
	import CommandIcon from 'phosphor-svelte/lib/CommandIcon';
	import CopyIcon from 'phosphor-svelte/lib/CopyIcon';
	import SquareIcon from 'phosphor-svelte/lib/SquareIcon';
	import SteeringWheelIcon from 'phosphor-svelte/lib/SteeringWheelIcon';
	import TrashIcon from 'phosphor-svelte/lib/TrashIcon';
	import ChatComposer from '#lib/components/chat-composer.svelte';
	import MarkdownBody from '#lib/components/markdown-body.svelte';
	import MateContextSelect from '#lib/components/mate-context-select.svelte';
	import { absoluteStamp } from '#lib/client/format.js';
	import {
		clockTime,
		groupMateEvents,
		initials,
		placeMateRows,
		type MateBubble,
		type MatePart
	} from '#lib/client/mate-chat.js';
	import { mate_chats, type PendingMessage } from '#lib/client/mate-chat.svelte.js';
	import { currentViewer } from '#lib/client/projects.svelte.js';
	import type { MateChat } from '#lib/mate.js';
	import { app_state } from '#lib/client/stores.svelte.js';
	import { run_place } from '#lib/client/agent-runner.svelte.js';

	interface Props {
		chat: MateChat;
		/** Bump to focus the composer. */
		focus_key?: number;
		onback: () => void;
		ondelete: () => Promise<void>;
	}

	let { chat, focus_key = 0, onback, ondelete }: Props = $props();

	/** Name the chat's runner only when there is more than one to tell apart. */
	const runner_label = $derived(
		run_place.runners.length > 1
			? (run_place.runners.find((runner) => runner.id === chat.runner)?.label ?? 'removed runner')
			: undefined
	);

	let confirming_delete = $state(false);
	let deleting = $state(false);
	let delete_error = $state<string | null>(null);
	let delete_button = $state<HTMLButtonElement | null>(null);
	let keep_button = $state<HTMLButtonElement | null>(null);
	let follow_latest = $state(true);
	let textarea = $state<HTMLTextAreaElement | null>(null);
	let log_el = $state<HTMLDivElement | null>(null);
	let copied = $state<string | null>(null);
	let title_open = $state(false);

	// Most events replace the `chat` object (a newer `updated_at`); only a
	// different chat should move focus back to the composer.
	const chat_id = $derived(chat.id);
	const bubbles = $derived(groupMateEvents(mate_chats.events));
	const working = $derived(mate_chats.working);
	const connected = $derived(mate_chats.connected);
	const viewer = $derived(currentViewer());
	const my_initials = $derived(initials(viewer?.name, viewer?.email));

	type Row =
		| { kind: 'bubble'; key: string; role: 'you' | 'mate'; at: string; bubble: MateBubble }
		| { kind: 'pending'; key: string; role: 'you'; at: string; item: PendingMessage };

	/** Stored messages, then sends not yet in the transcript. */
	const rows = $derived.by(() => {
		const list: Row[] = [
			...bubbles.map((bubble) => ({
				kind: 'bubble' as const,
				key: bubble.id,
				role: bubble.role,
				at: bubble.at,
				bubble
			})),
			...mate_chats.pending.map((item) => ({
				kind: 'pending' as const,
				key: item.message_id,
				role: 'you' as const,
				at: item.at,
				item
			}))
		];
		const placement = placeMateRows(list);
		return list.map((row, index) => ({ ...row, ...placement[index]! }));
	});

	const RESULT_NOTE: Record<string, string> = {
		failed: 'Turn failed',
		cancelled: 'Interrupted'
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

	/** What Copy puts on the clipboard: the message's text, as written. */
	function copyText(row: Row): string {
		if (row.kind === 'pending') return row.item.text;
		return row.bubble.parts
			.filter((part) => part.kind === 'text')
			.map((part) => part.text)
			.join('\n\n');
	}

	async function copy(row: Row) {
		try {
			await navigator.clipboard.writeText(copyText(row));
			copied = row.key;
			setTimeout(() => {
				if (copied === row.key) copied = null;
			}, 1500);
		} catch {
			mate_chats.action_error = 'Could not copy the message. Select the text and copy it instead.';
		}
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
	/**
	 * While the confirmation is open, Escape dismisses it instead of closing
	 * the chat, wherever focus is. This runs in the capture phase, ahead of
	 * the page's hotkeys, which skip a key that is already handled.
	 */
	function confirmKeydown(event: KeyboardEvent) {
		if (!confirming_delete || event.key !== 'Escape' || deleting) return;
		event.preventDefault();
		cancelDelete();
	}

	function send(message: string) {
		void mate_chats.send(chat.id, message);
		mate_chats.drafts[chat.id] = '';
		void tick().then(jumpToLatest);
	}
</script>

<svelte:window onkeydowncapture={confirmKeydown} />

<section class="chat" aria-label={chat.title}>
	<header class="chat-hd">
		<button
			class="btn btn-sm btn-ghost btn-icon back"
			type="button"
			aria-label="Back to chats"
			{@attach tip('Back (esc)')}
			onclick={onback}
		>
			<ArrowLeftIcon size={14} />
		</button>
		<!-- A long title is clipped to one line; tapping it (or Enter) shows all of it. -->
		<h1 class="chat-ti">
			<button
				class="ti-btn"
				class:is-open={title_open}
				type="button"
				{@attach tip(title_open ? null : chat.title)}
				onclick={() => (title_open = !title_open)}>{chat.title}</button
			>
		</h1>
		<p class="chat-meta">
			Started <time datetime={chat.created_at} {@attach tip(absoluteStamp(chat.created_at))}
				>{absoluteStamp(chat.created_at)}</time
			>{#if runner_label}
				· on {runner_label}{/if}
		</p>
		<button
			bind:this={delete_button}
			class="btn btn-sm btn-ghost btn-icon"
			type="button"
			aria-label="Delete chat"
			aria-expanded={confirming_delete}
			disabled={deleting}
			{@attach tip('Delete chat')}
			onclick={() => (confirming_delete ? cancelDelete() : openDelete())}
		>
			<TrashIcon size={15} aria-hidden="true" />
		</button>
	</header>

	{#if confirming_delete}
		<div class="delete-confirm">
			<p>Delete this chat and stop its session? Its saved messages will be removed.</p>
			{#if delete_error}<p class="err" role="alert">{delete_error}</p>{/if}
			<div class="confirm-actions">
				<button
					class="btn btn-sm btn-danger"
					type="button"
					disabled={deleting}
					onclick={() => void deleteChat()}>{deleting ? 'Deleting…' : 'Delete permanently'}</button
				>
				<button
					bind:this={keep_button}
					class="btn btn-sm btn-ghost"
					type="button"
					disabled={deleting}
					onclick={cancelDelete}>Keep chat</button
				>
			</div>
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
		<ol class="log" aria-live="polite" aria-busy={mate_chats.opening}>
			{#if mate_chats.opening}
				<li class="note" role="status">Loading conversation…</li>
			{:else if !mate_chats.open_error && rows.length === 0}
				<li class="note">No messages yet. Send a message to start this conversation.</li>
			{/if}
			{#if !connected}
				<li class="note">No model is connected yet. Replies are placeholders.</li>
			{/if}
			{#if mate_chats.open_error}
				<li class="note err" role="alert">
					{mate_chats.open_error}
					<button
						class="btn btn-sm btn-ghost"
						type="button"
						onclick={() => void mate_chats.open(chat.id)}>Retry loading</button
					>
				</li>
			{/if}

			{#each rows as row (row.key)}
				{#if row.day}
					<li class="day"><span>{row.day}</span></li>
				{/if}
				<li
					class="msg"
					class:is-head={row.head}
					class:is-you={row.role === 'you'}
					class:is-failed={(row.kind === 'bubble' && row.bubble.result?.status === 'failed') ||
						(row.kind === 'pending' && row.item.error !== undefined)}
				>
					<div class="gutter">
						{#if row.head}
							{#if row.role === 'mate'}
								<span class="avatar is-mate" aria-hidden="true"
									><SteeringWheelIcon size={17} weight="bold" /></span
								>
							{:else}
								<span class="avatar" aria-hidden="true">{my_initials}</span>
							{/if}
						{:else}
							<time class="gutter-time" datetime={row.at} aria-hidden="true"
								>{clockTime(row.at)}</time
							>
						{/if}
					</div>
					<div class="msg-main">
						<p class="msg-hd" class:sr-only={!row.head}>
							<span class="sr-only">{row.role === 'you' ? 'You' : 'First Mate'}, </span>
							<time datetime={row.at} {@attach tip(absoluteStamp(row.at))}>{clockTime(row.at)}</time
							>
						</p>

						{#if row.kind === 'pending'}
							<p class="body is-pending">{row.item.text}</p>
							{#if row.item.error}
								<p class="err" role="alert">
									Not sent: {row.item.error}
									<button
										class="link-btn"
										type="button"
										onclick={() => mate_chats.retry(chat.id, row.item)}>Retry</button
									>
									<button
										class="link-btn"
										type="button"
										onclick={() => mate_chats.discard(row.item)}>Discard</button
									>
								</p>
							{:else}
								<p class="sending">{row.item.event_id ? 'Sent' : 'Sending…'}</p>
							{/if}
						{:else if row.role === 'you'}
							{#each row.bubble.parts as part (part.id)}
								{#if part.kind === 'text'}<p class="body">{part.text}</p>{/if}
							{/each}
						{:else}
							<div class="parts">
								{#each runs(row.bubble.parts) as part (part.id)}
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
														<span class="tool-status">{tool.status}</span>
													</li>
												{/if}
											{/each}
										</ul>
									{:else if part.kind === 'error'}
										<p class="err" role="status">{part.message}</p>
									{/if}
								{/each}
								{#if row.bubble.result?.git_pr_url}
									<p class="pr">
										<a href={row.bubble.result.git_pr_url} target="_blank" rel="noopener noreferrer"
											>Pull request</a
										>
									</p>
								{/if}
								<!-- After the turn's content, so it shows on grouped messages too. -->
								{#if row.bubble.result && RESULT_NOTE[row.bubble.result.status]}
									<p class="outcome">
										<span class="st">{RESULT_NOTE[row.bubble.result.status]}</span>
									</p>
								{/if}
							</div>
						{/if}
					</div>
					{#if copyText(row).trim() !== ''}
						<div class="msg-tools">
							<button
								class="btn btn-sm btn-ghost btn-icon"
								type="button"
								aria-label={copied === row.key ? 'Copied' : 'Copy message'}
								{@attach tip(copied === row.key ? 'Copied' : 'Copy message')}
								onclick={() => void copy(row)}
							>
								{#if copied === row.key}<CheckIcon size={14} aria-hidden="true" />{:else}<CopyIcon
										size={14}
										aria-hidden="true"
									/>{/if}
							</button>
						</div>
					{/if}
				</li>
			{/each}

			{#if mate_chats.stream_error}
				<li class="note err" role="status">
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

	<div class="dock">
		{#if !follow_latest}
			<div class="older">
				<span class="older-lbl">Viewing older messages</span>
				<button class="btn btn-sm btn-ghost" type="button" onclick={jumpToLatest}>
					Jump to latest <ArrowDownIcon size={12} aria-hidden="true" />
				</button>
			</div>
		{/if}
		{#if mate_chats.action_error}
			<p class="err dock-err" role="alert">{mate_chats.action_error}</p>
		{/if}
		<ChatComposer
			class="is-compact"
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
			placeholder={working ? 'Add to what it is doing…' : 'Message First Mate'}
			rows={1}
			onsend={send}
		>
			{#snippet controls()}
				<MateContextSelect
					value={chat.scope}
					disabled={mate_chats.scope_saving || mate_chats.opening}
					onchange={(scope) => void mate_chats.setScope(chat.id, scope)}
				/>
				<button
					class="btn btn-sm btn-ghost cmd"
					type="button"
					aria-label="Commands"
					{@attach tip('Commands (⌘K)')}
					onclick={() => app_state.openFirstMate()}
				>
					<CommandIcon size={12} aria-hidden="true" /><span class="cmd-lbl">Commands</span>
				</button>
			{/snippet}
			{#snippet actions()}
				{#if connected && working}
					<button
						class="btn btn-sm btn-danger"
						type="button"
						disabled={mate_chats.interrupting || mate_chats.interrupt_requested}
						onclick={() => void mate_chats.interrupt(chat.id)}
						{@attach tip('Interrupt the current turn; the session keeps running')}
					>
						<SquareIcon size={12} />
						{mate_chats.interrupting
							? 'Requesting stop…'
							: mate_chats.interrupt_requested
								? 'Stop requested'
								: 'Stop turn'}
					</button>
				{/if}
			{/snippet}
		</ChatComposer>
		<p class="activity" role="status">
			{#if mate_chats.scope_saving}Saving scope…
			{:else if mate_chats.interrupt_requested}Stop requested. Waiting for the turn to finish.
			{:else if working}<span class="chat-dots" aria-hidden="true"><i></i><i></i><i></i></span>First
				Mate is working…{/if}
		</p>
	</div>
</section>

<style>
	.chat {
		--chat-max: 100ch;
		--gutter: 40px;
		display: flex;
		flex-direction: column;
		min-height: 0;
		min-width: 0;
		height: 100%;
	}

	/* ---- header: one line, like a channel bar */
	.chat-hd {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		min-height: 36px;
		padding: 0 0 var(--s-2);
		border-bottom: 2px solid var(--rule);
	}
	.chat-ti {
		flex: 0 1 auto;
		min-width: 0;
		margin: 0;
		font-size: var(--t-md);
		font-weight: 600;
		line-height: 1.35;
		color: var(--tx-hi);
	}
	.ti-btn {
		display: block;
		max-width: 100%;
		padding: 0;
		overflow: hidden;
		background: none;
		border: 0;
		border-radius: var(--r-1);
		color: inherit;
		font: inherit;
		text-align: left;
		text-overflow: ellipsis;
		white-space: nowrap;
		cursor: pointer;
	}
	.ti-btn.is-open {
		white-space: normal;
		overflow-wrap: anywhere;
	}
	.chat-meta {
		flex: 1 0 auto;
		margin: 0;
		font-size: var(--t-xs);
		color: var(--tx-dim);
		white-space: nowrap;
	}
	.delete-confirm {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-2) var(--s-4);
		padding: var(--s-3) 0;
		border-bottom: 1px solid var(--line);
		font-size: var(--t-sm);
	}
	.delete-confirm p {
		margin: 0;
	}
	.confirm-actions {
		display: flex;
		gap: var(--s-2);
	}

	/* ---- transcript */
	.chat-scroll {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		scrollbar-color: var(--line-2) transparent;
		scrollbar-width: thin;
	}
	.log {
		display: flex;
		flex-direction: column;
		max-width: var(--chat-max);
		margin: 0;
		padding: var(--s-4) 0 var(--s-3);
		list-style: none;
	}
	.note {
		margin: 0 0 var(--s-3);
		padding-left: var(--gutter);
		font-size: var(--t-sm);
		color: var(--tx-dim);
	}
	.day {
		display: flex;
		align-items: center;
		gap: var(--s-3);
		margin: var(--s-4) 0 var(--s-2);
		font-size: var(--t-xs);
		font-weight: 600;
		color: var(--tx-dim);
	}
	.day:first-child {
		margin-top: 0;
	}
	.day::before,
	.day::after {
		content: '';
		flex: 1;
		height: 1px;
		background: var(--line);
	}

	/* A message row: gutter (avatar, or the time on hover), content, tools. */
	.msg {
		position: relative;
		display: grid;
		grid-template-columns: var(--gutter) minmax(0, 1fr);
		column-gap: var(--s-3);
		padding: 2px var(--s-3) 2px 0;
		border-radius: var(--r-2);
	}
	.msg.is-head {
		margin-top: var(--s-4);
		padding-top: 4px;
	}
	.log > .day + .msg.is-head,
	.log > .msg.is-head:first-child {
		margin-top: 0;
	}
	.msg:hover,
	.msg:focus-within {
		background: var(--s1);
	}
	.gutter {
		display: flex;
		justify-content: flex-end;
		padding-top: 2px;
	}
	.avatar {
		display: grid;
		place-items: center;
		width: 32px;
		height: 32px;
		border-radius: var(--r-3);
		background: var(--s4);
		color: var(--tx-mid);
		font-size: var(--t-xs);
		font-weight: 700;
		letter-spacing: 0.02em;
	}
	/* Ink, not the accent: red marks primary actions and selection. */
	.avatar.is-mate {
		background: var(--tx-hi);
		color: var(--bg);
	}
	.gutter-time {
		padding-top: 3px;
		font-size: var(--t-micro);
		color: var(--tx-faint);
		font-variant-numeric: tabular-nums;
		opacity: 0;
	}
	.msg:hover .gutter-time,
	.msg:focus-within .gutter-time {
		opacity: 1;
	}
	.msg-main {
		min-width: 0;
		max-width: 76ch;
	}
	.msg-hd {
		display: flex;
		align-items: baseline;
		gap: var(--s-2);
		margin: 0 0 2px;
		font-size: var(--t-xs);
		color: var(--tx-dim);
		font-variant-numeric: tabular-nums;
	}
	.outcome {
		margin: 0;
		font-size: var(--t-xs);
	}
	.st {
		padding: 0 5px;
		border: 1px solid var(--amber-line);
		border-radius: var(--r-1);
		color: var(--amber-tx);
		font-weight: 600;
	}
	.msg.is-failed .st {
		border-color: var(--danger-line);
		color: var(--danger-tx);
	}
	.body {
		margin: 0;
		font-family: var(--font-prose);
		font-size: 15px;
		line-height: 1.6;
		color: var(--tx-hi);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.body.is-pending {
		color: var(--tx-mid);
	}
	.sending {
		margin: 2px 0 0;
		font-size: var(--t-xs);
		color: var(--tx-dim);
	}
	.parts {
		display: flex;
		flex-direction: column;
		gap: var(--s-2);
	}
	.parts :global(.chat-md) {
		max-width: none;
	}
	.parts :global(.chat-md > :first-child) {
		margin-top: 0;
	}
	.parts :global(.chat-md > :last-child) {
		margin-bottom: 0;
	}

	/* Copy sits on the row's top edge, like a chat app's message toolbar;
	   it shows on hover and keyboard focus, and always on touch screens. */
	.msg-tools {
		position: absolute;
		top: -12px;
		right: var(--s-3);
		display: flex;
		border: 1px solid var(--line);
		border-radius: var(--r-2);
		background: var(--bg);
		box-shadow: var(--shadow-tip);
		opacity: 0;
		pointer-events: none;
		transition: opacity 0.12s ease-out;
	}
	.msg:hover .msg-tools,
	.msg:focus-within .msg-tools {
		opacity: 1;
		pointer-events: auto;
	}
	@media (pointer: coarse) {
		.msg-tools {
			position: static;
			grid-column: 2;
			justify-self: start;
			margin-top: 2px;
			border: 0;
			background: none;
			box-shadow: none;
			opacity: 1;
			pointer-events: auto;
		}
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
		display: inline-flex;
		align-items: baseline;
		gap: 6px;
		min-width: 0;
		max-width: 100%;
		padding: 1px 6px;
		border: 1px solid var(--line);
		border-radius: var(--r-1);
		background: var(--s1);
		color: var(--tx-mid);
		overflow-wrap: anywhere;
	}
	.tool.is-running {
		border-color: var(--line-3);
		color: var(--tx-hi);
	}
	.tool code {
		font-family: var(--font-mono);
		font-size: var(--t-xs);
	}
	.tool-status {
		font-size: var(--t-xs);
		color: var(--tx-dim);
	}
	.thinking {
		font-size: var(--t-xs);
		color: var(--tx-dim);
	}
	.thinking summary {
		width: fit-content;
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
	.link-btn {
		margin-left: var(--s-2);
		padding: 0;
		background: none;
		border: 0;
		color: var(--tx-hi);
		font: inherit;
		font-weight: 600;
		text-decoration: underline;
		text-underline-offset: 2px;
		cursor: pointer;
	}
	.pr {
		margin: 0;
		font-size: var(--t-sm);
	}

	/* ---- dock: older-messages bar, composer, activity line */
	.dock {
		flex: none;
		max-width: var(--chat-max);
		padding-left: calc(var(--gutter) + var(--s-3));
	}
	.older {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--s-2);
		margin-bottom: var(--s-2);
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
	.cmd {
		gap: 5px;
	}
	.dock-err {
		margin-bottom: var(--s-2);
	}
	.dock :global(.composer.is-compact) {
		padding: 8px 10px 8px 14px;
	}
	.dock :global(.composer.is-compact .composer-in) {
		min-height: 26px;
		padding: 3px 0 6px;
	}
	.activity {
		min-height: 22px;
		margin: 0;
		padding: 3px 0 0;
		font-size: var(--t-xs);
		color: var(--tx-dim);
	}

	@media (pointer: coarse) {
		.chat :global(.btn-sm),
		.thinking summary {
			min-height: 44px;
		}
		.link-btn {
			min-height: 44px;
		}
	}
	@media (min-width: 901px) {
		.back {
			display: none;
		}
	}
	@media (max-width: 640px) {
		.chat {
			--gutter: 32px;
		}
		.avatar {
			width: 28px;
			height: 28px;
		}
		.chat-meta {
			display: none;
		}
		.chat-ti {
			flex: 1;
		}
		.dock {
			padding-left: 0;
		}
		.cmd-lbl {
			display: none;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.msg-tools {
			transition: none;
		}
	}
</style>
