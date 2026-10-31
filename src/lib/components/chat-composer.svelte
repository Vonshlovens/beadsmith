<script lang="ts">
	/**
	 * The message box for First Mate chats and agent threads: a bordered
	 * textarea with a row of controls under it. Enter sends, Shift+Enter starts
	 * a new line, and ⌘/Ctrl+Enter also sends. When the box cannot take a
	 * message, `reason` says why in place of the hint.
	 */
	import type { Snippet } from 'svelte';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import { MAX_MESSAGE_CHARS } from '$lib/client/mate-chat';

	interface Props {
		value: string;
		/** Accessible name for the textarea. */
		label: string;
		placeholder?: string;
		rows?: number;
		/** The box cannot take a message; `reason` says why. */
		disabled?: boolean;
		reason?: string;
		/** A send is in flight. */
		busy?: boolean;
		submit_label?: string;
		textarea?: HTMLTextAreaElement | null;
		onsend: (text: string) => void;
		/** Left of the footer: context, mode, commands. */
		controls?: Snippet;
		/** Right of the footer, before Send. */
		actions?: Snippet;
		class?: string;
	}

	let {
		value = $bindable(),
		label,
		placeholder = '',
		rows = 3,
		disabled = false,
		reason,
		busy = false,
		submit_label = 'Send',
		textarea = $bindable(null),
		onsend,
		controls,
		actions,
		class: class_name = ''
	}: Props = $props();

	const can_send = $derived(!disabled && !busy && value.trim().length > 0);

	function submit(event?: SubmitEvent) {
		event?.preventDefault();
		if (can_send) {
			onsend(value.trim());
		}
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key !== 'Enter' || event.isComposing || event.shiftKey || event.altKey) {
			return;
		}
		event.preventDefault();
		submit();
	}
</script>

<form class="composer {class_name}" class:is-disabled={disabled} onsubmit={submit}>
	<textarea
		bind:this={textarea}
		bind:value
		class="composer-in"
		{rows}
		maxlength={MAX_MESSAGE_CHARS}
		aria-label={label}
		placeholder={disabled ? '' : placeholder}
		{disabled}
		onkeydown={onKeydown}></textarea>
	<div class="composer-ft">
		{@render controls?.()}
		<span class="spacer"></span>
		{#if disabled && reason}
			<span class="why">{reason}</span>
		{:else}
			<span class="hint-keys" aria-hidden="true"
				><span class="kbd">⏎</span> send <span class="kbd">⇧⏎</span> new line</span
			>
		{/if}
		{@render actions?.()}
		<button class="btn btn-sm btn-primary send" type="submit" disabled={!can_send}>
			{submit_label}
			<ArrowUpIcon size={13} strokeWidth={2} aria-hidden="true" />
		</button>
	</div>
</form>

<style>
	/* After Overalls' thread composer: a plain box whose border darkens to ink
	   while you type in it. */
	.composer {
		flex: none;
		border: 2px solid var(--line-2);
		border-radius: var(--r-2);
		background: var(--bg);
		padding: 10px 12px 10px 14px;
		transition: border-color 0.12s ease;
	}
	.composer:focus-within {
		border-color: var(--tx-hi);
	}
	.composer.is-disabled {
		background: var(--s1);
	}
	.composer-in {
		display: block;
		width: 100%;
		min-height: 44px;
		max-height: 40dvh;
		padding: 2px 0 8px;
		background: none;
		border: 0;
		outline: none;
		resize: none;
		field-sizing: content;
		font-family: var(--font-prose);
		font-size: 15px;
		line-height: 1.55;
		color: var(--tx-hi);
	}
	.composer-in::placeholder {
		color: var(--tx-dim);
	}
	.composer-in:disabled {
		cursor: not-allowed;
	}
	.composer-ft {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-2);
	}
	.spacer {
		flex: 1;
	}
	.hint-keys,
	.why {
		font-size: var(--t-xs);
		color: var(--tx-dim);
	}
	.hint-keys .kbd {
		margin-left: 4px;
	}
	.hint-keys .kbd:first-child {
		margin-left: 0;
	}
	.send {
		gap: 5px;
		margin-left: auto;
	}
	@media (max-width: 640px) {
		.hint-keys {
			display: none;
		}
	}
	@media (pointer: coarse) {
		.composer-ft :global(.btn-sm) {
			height: 32px;
		}
	}
</style>
