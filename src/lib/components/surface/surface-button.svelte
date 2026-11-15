<script lang="ts">
	/**
	 * The catalog's Button. Its action is an allowlisted bridge action that
	 * must run as the viewer behind a host-rendered confirmation (ADR-0025
	 * rule 6). Until that path exists the button renders but does nothing,
	 * and says so in visible text rather than only on hover
	 * (docs/design-standards.md, "Disabled controls need an understandable
	 * reason").
	 */
	interface Props {
		label: string;
		tone: 'default' | 'primary' | 'danger';
	}

	let { label, tone }: Props = $props();

	const reason_id = $props.id();
</script>

<span class="sf-btn">
	<button
		class="btn btn-sm"
		class:btn-primary={tone === 'primary'}
		class:btn-danger={tone === 'danger'}
		type="button"
		aria-disabled="true"
		aria-describedby={reason_id}
	>
		{label}
	</button>
	<span class="hint" id={reason_id}>Surface buttons do not run actions yet.</span>
</span>

<style>
	.sf-btn {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-2);
	}
	.sf-btn button[aria-disabled='true'] {
		cursor: not-allowed;
		opacity: 0.7;
	}
</style>
