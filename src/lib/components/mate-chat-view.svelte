<script lang="ts">
	/**
	 * One First Mate chat: its messages, newest at the bottom, and the composer
	 * pinned under them. The chat is not wired to a model yet (see
	 * $lib/client/mate-chat.ts), and says so at the top.
	 */
	import { tick } from 'svelte';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import CommandIcon from '@lucide/svelte/icons/command';
	import ChatComposer from '$lib/components/chat-composer.svelte';
	import MarkdownBody from '$lib/components/markdown-body.svelte';
	import MateContextSelect from '$lib/components/mate-context-select.svelte';
	import { absoluteStamp, relativeShort } from '$lib/client/format';
	import { mate_chats } from '$lib/client/mate-chat.svelte';
	import type { Chat } from '$lib/client/mate-chat';
	import { app_state } from '$lib/client/stores.svelte';

	interface Props {
		chat: Chat;
		/** Bump to focus the composer. */
		focus_key?: number;
		onback: () => void;
		ondelete: () => void;
	}

	let { chat, focus_key = 0, onback, ondelete }: Props = $props();

	let text = $state('');
	let textarea = $state<HTMLTextAreaElement | null>(null);
	let log_el = $state<HTMLDivElement | null>(null);

	const waiting = $derived(mate_chats.isWaiting(chat.id));

	// Keep the newest message in view.
	$effect(() => {
		void chat.messages.length;
		void waiting;
		void tick().then(() => log_el?.scrollTo({ top: log_el.scrollHeight }));
	});

	$effect(() => {
		void focus_key;
		void chat.id;
		void tick().then(() => textarea?.focus());
	});

	function send(message: string) {
		mate_chats.send(chat.id, message);
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
				· {chat.messages.length}
				{chat.messages.length === 1 ? 'message' : 'messages'}
			</p>
		</div>
		<button class="btn btn-sm btn-ghost" type="button" onclick={ondelete}>Delete</button>
	</header>

	<div class="chat-scroll" bind:this={log_el}>
		<ol class="chat-log chat-col" aria-live="polite">
			<li class="chat-event">No model is connected yet. This chat stays in this browser.</li>
			{#each chat.messages as message (message.id)}
				<li class="chat-msg" class:is-you={message.role === 'you'}>
					<div class="chat-role">
						<span>{message.role === 'you' ? 'You' : 'First Mate'}</span>
						<time datetime={message.at} title={absoluteStamp(message.at)}
							>{relativeShort(message.at)}</time
						>
					</div>
					{#if message.role === 'mate'}
						<MarkdownBody source={message.text} class="chat-md" />
					{:else}
						<p class="chat-body">{message.text}</p>
					{/if}
				</li>
			{/each}
			{#if waiting}
				<li class="chat-msg">
					<div class="chat-role"><span>First Mate</span></div>
					<p class="chat-body is-dim">
						<span class="chat-dots" aria-hidden="true"><i></i><i></i><i></i></span>Thinking…
					</p>
				</li>
			{/if}
		</ol>
	</div>

	<div class="chat-col compose-dock">
		<ChatComposer
			bind:value={text}
			bind:textarea
			label="Message First Mate"
			placeholder="Ask a follow-up…"
			rows={2}
			busy={waiting}
			onsend={send}
		>
			{#snippet controls()}
				<MateContextSelect
					value={chat.scope}
					onchange={(scope) => mate_chats.setScope(chat.id, scope)}
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
	@media (min-width: 901px) {
		.back {
			display: none;
		}
	}
</style>
