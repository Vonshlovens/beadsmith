<script lang="ts">
	/**
	 * A data binding that did not resolve, in place of the component that
	 * reads it (ADR-0025: bindings resolve independently, so one refusal or
	 * outage is one broken tile, not a blank surface). A failed read is never
	 * drawn as an empty list or a zero.
	 */
	interface Props {
		/** What the component would have shown, for the reader. */
		what: string;
		message: string;
	}

	let { what, message }: Props = $props();
</script>

<div class="sf-err panel" role="status">
	<i class="dot dot-blocked" aria-hidden="true"></i>
	<div>
		<b>{what} could not be read.</b>
		<div class="hint">{message}</div>
	</div>
</div>

<style>
	.sf-err {
		display: flex;
		align-items: flex-start;
		gap: var(--s-2);
		padding: var(--s-3) var(--s-4);
		font-size: var(--t-sm);
		color: var(--tx-mid);
	}
	.sf-err .dot {
		margin-top: 5px;
		flex: none;
	}
	.sf-err b {
		color: var(--tx-hi);
		font-weight: 600;
	}
</style>
