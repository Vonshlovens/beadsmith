<script lang="ts">
	/**
	 * One First Mate chat: the agent session's events grouped into bubbles,
	 * newest at the bottom, and the composer pinned under them. The agent can
	 * speak unasked, so a bubble of its own may follow another. Tool calls are
	 * compact chips, thinking folds away, errors sit inline. Stop interrupts
	 * the agent's current turn; the session keeps running.
	 */
	import { tick } from 'svelte';
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
		ondelete: () => void;
	}

	let { chat, focus_key = 0, onback, ondelete }: Props = $props();

	let text = $state('');
	let textarea = $state<HTMLTextAreaElement | null>(null);
	let log_el = $state<HTMLDivElement | null>(null);

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

	// Keep the newest message in view.
	$effect(() => {
		void mate_chats.events.length;
		void mate_chats.pending.length;
		void working;
		void tick().then(() => log_el?.scrollTo({ top: log_el.scrollHeight }));
	});

	$effect(() => {
		void focus_key;
		void chat.id;
		void tick().then(() => textarea?.focus());
	});

	function send(message: string) {
		void mate_chats.send(chat.id, message);
		text = '';
	}
</script>

<section class="chat" aria-label="Chat">
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
		<button class="btn btn-sm btn-ghost" type="button" onclick={ondelete}>Delete</button>
	</header>

	<div class="chat-scroll" bind:this={log_el}>
		<ol class="chat-log chat-col" aria-live="polite">
			{#if !connected}
				<li class="chat-event">No model is connected yet. Replies are placeholders.</li>
			{/if}
			{#if mate_chats.open_error}
				<li class="chat-event err" role="alert">{mate_chats.open_error}</li>
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
													<span class="sr-only">, {tool.status}</span>
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
						<span class="st">{item.error ? 'not sent' : 'sending'}</span>
					</div>
					<p class="chat-body is-dim">{item.text}</p>
					{#if item.error}
						<p class="err" role="alert">
							{item.error}
							<button
								class="btn btn-sm btn-ghost"
								type="button"
								onclick={() => mate_chats.retry(chat.id, item)}>Retry</button
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
				<li class="chat-event err" role="status">{mate_chats.stream_error}</li>
			{/if}
		</ol>
	</div>

	<div class="chat-col compose-dock">
		<ChatComposer
			bind:value={text}
			bind:textarea
			label="Message First Mate"
			placeholder={working ? 'Add to what it is doing…' : 'Ask a follow-up…'}
			rows={2}
			onsend={send}
		>
			{#snippet controls()}
				<MateContextSelect
					value={chat.scope}
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
						disabled={mate_chats.interrupting}
						onclick={() => void mate_chats.interrupt(chat.id)}
						title="Interrupt the current turn; the session keeps running"
					>
						<SquareIcon size={12} strokeWidth={1.6} />
						{mate_chats.interrupting ? 'Stopping…' : 'Stop'}
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
	@media (min-width: 901px) {
		.back {
			display: none;
		}
	}
</style>
