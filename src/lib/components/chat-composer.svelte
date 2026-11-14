<script lang="ts">
	/**
	 * The message box for First Mate chats and agent threads: a bordered
	 * textarea with a row of controls under it. Enter sends, Shift+Enter starts
	 * a new line, and ⌘/Ctrl+Enter also sends. On a touch-only screen Enter
	 * starts a new line instead (an on-screen keyboard has no Shift+Enter) and
	 * the Send button sends. When the box cannot take a message, `reason` says
	 * why in place of the hint.
	 *
	 * A message over `max_chars` is kept whole and refused with a count, rather
	 * than cut short by `maxlength` the moment it is pasted.
	 */
	import type { Snippet } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import ArrowUpIcon from 'phosphor-svelte/lib/ArrowUpIcon';
	import { MAX_MESSAGE_CHARS } from '#lib/client/mate-chat.js';

	interface Props {
		value: string | undefined;
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
		/** Longest message the receiver takes. */
		max_chars?: number;
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
		max_chars = MAX_MESSAGE_CHARS,
		textarea = $bindable(null),
		onsend,
		controls,
		actions,
		class: class_name = ''
	}: Props = $props();

	const hint_id = $props.id();
	/** A phone or tablet without a pointer: Enter is the keyboard's only line break. */
	const touch_only = new MediaQuery('(hover: none) and (pointer: coarse)', false);

	// Trimmed, as the server counts it: trailing blank lines are not over the limit.
	const length = $derived((value ?? '').trim().length);
	const over = $derived(length - max_chars);
	/** Show the count once it is worth watching, not on every short message. */
	const show_count = $derived(length >= max_chars * 0.9);
	const can_send = $derived(!disabled && !busy && over <= 0 && (value ?? '').trim().length > 0);

	// Browsers without `field-sizing` (Firefox today) keep a fixed-height box;
	// grow it with the text instead, up to the CSS max-height.
	const grows_natively =
		typeof CSS !== 'undefined' && CSS.supports?.('field-sizing', 'content') === true;
	$effect(() => {
		void value;
		const el = textarea;
		if (grows_natively || el === null) return;
		el.style.height = 'auto';
		el.style.height = `${el.scrollHeight}px`;
	});

	function submit(event?: SubmitEvent) {
		event?.preventDefault();
		if (can_send) {
			onsend((value ?? '').trim());
		}
	}

	function onKeydown(event: KeyboardEvent) {
		// keyCode 229: Safari reports the Enter that confirms an IME candidate
		// with `isComposing` already false.
		if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
		if (event.shiftKey || event.altKey) return;
		const modified = event.metaKey || event.ctrlKey;
		if (touch_only.current && !modified) return;
		event.preventDefault();
		submit();
	}
</script>

<form class="composer {class_name}" class:is-disabled={disabled} aria-busy={busy} onsubmit={submit}>
	<textarea
		bind:this={textarea}
		bind:value
		class="composer-in"
		{rows}
		aria-label={label}
		aria-describedby={hint_id}
		aria-invalid={over > 0 ? 'true' : undefined}
		enterkeyhint={touch_only.current ? 'enter' : 'send'}
		placeholder={disabled ? '' : placeholder}
		{disabled}
		onkeydown={onKeydown}></textarea>
	<div class="composer-ft">
		{@render controls?.()}
		<span class="spacer"></span>
		<span id={hint_id} class="composer-hint">
			{#if disabled && reason}
				<span class="why">{reason}</span>
			{:else if over > 0}
				<span class="count is-over mono-num"
					>{length.toLocaleString()} / {max_chars.toLocaleString()} · shorten by {over.toLocaleString()}</span
				>
			{:else}
				{#if show_count}
					<span class="count mono-num"
						>{length.toLocaleString()} / {max_chars.toLocaleString()}</span
					>
				{/if}
				{#if touch_only.current}
					<span class="sr-only">Use the {submit_label} button to send.</span>
				{:else}
					<span class="hint-keys" aria-hidden="true"
						><span class="kbd">⏎</span> send <span class="kbd">⇧⏎</span> new line</span
					>
					<span class="sr-only">Enter sends, Shift+Enter starts a new line.</span>
				{/if}
			{/if}
		</span>
		{@render actions?.()}
		<button class="btn btn-sm btn-primary send" type="submit" disabled={!can_send}>
			{busy ? 'Sending…' : submit_label}
			<ArrowUpIcon size={13} aria-hidden="true" />
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
	.composer:has(.composer-in[aria-invalid='true']) {
		border-color: var(--danger);
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
	.composer-hint {
		display: inline-flex;
		align-items: center;
		gap: var(--s-2);
		min-width: 0;
		font-size: var(--t-xs);
		color: var(--tx-dim);
	}
	.count.is-over {
		color: var(--danger-tx);
		font-weight: 600;
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
			min-height: 44px;
		}
	}
</style>
