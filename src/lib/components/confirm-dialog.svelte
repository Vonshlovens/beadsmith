<script lang="ts">
	/**
	 * A confirmation that names the action and the object
	 * (docs/design-standards.md §5), in place of `window.confirm`, whose box
	 * the browser draws outside the app's look. The confirm button says what
	 * it does; Cancel and Esc leave everything as it was. Focus starts on
	 * Cancel for a destructive action, so Enter alone cannot do the damage.
	 */
	import * as Dialog from '#lib/components/ui/dialog/index.js';

	interface Props {
		open: boolean;
		title: string;
		/** One or two sentences: what happens, and to whom. */
		description: string;
		/** The button's verb phrase, e.g. "Remove account". */
		confirm_label: string;
		destructive?: boolean;
		onconfirm: () => void;
	}

	let {
		open = $bindable(false),
		title,
		description,
		confirm_label,
		destructive = false,
		onconfirm
	}: Props = $props();

	let cancel_el = $state<HTMLButtonElement | null>(null);
	let confirm_el = $state<HTMLButtonElement | null>(null);

	function confirm() {
		open = false;
		onconfirm();
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content
		class="ui-dialog ui-dialog-sm"
		showCloseButton={false}
		role="alertdialog"
		onOpenAutoFocus={(event) => {
			event.preventDefault();
			(destructive ? cancel_el : confirm_el)?.focus();
		}}
	>
		<div class="modal-hd">
			<Dialog.Title class="lbl">{title}</Dialog.Title>
		</div>
		<div class="modal-bd">
			<Dialog.Description class="cd-desc">{description}</Dialog.Description>
		</div>
		<div class="modal-ft">
			<span class="spacer"></span>
			<button class="btn btn-sm" type="button" bind:this={cancel_el} onclick={() => (open = false)}
				>Cancel</button
			>
			<button
				class="btn btn-sm {destructive ? 'btn-danger' : 'btn-primary'}"
				type="button"
				bind:this={confirm_el}
				onclick={confirm}>{confirm_label}</button
			>
		</div>
	</Dialog.Content>
</Dialog.Root>

<style>
	:global(.cd-desc) {
		font-size: var(--t-sm);
		color: var(--tx);
		line-height: 1.6;
	}
</style>
