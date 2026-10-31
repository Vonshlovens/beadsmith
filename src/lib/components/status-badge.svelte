<script lang="ts">
	/**
	 * Status badge = dot + word. The text carries the state, colour reinforces
	 * it. `compact` keeps only the bead (a narrow list column); the word moves
	 * to the tooltip and stays for screen readers.
	 */
	import { statusKey, statusLabel } from '$lib/client/format';

	interface Props {
		status: string | undefined;
		class?: string;
		compact?: boolean;
	}

	let { status, class: class_name = '', compact = false }: Props = $props();

	const key = $derived(statusKey(status));
	const label = $derived(statusLabel(status));
</script>

{#if compact}
	<span class="badge-bead {class_name}" title={label}>
		<i class="dot dot-{key}" aria-hidden="true"></i><span class="sr-only">{label}</span>
	</span>
{:else}
	<span class="badge badge-{key} {class_name}">
		<i class="dot dot-{key}" aria-hidden="true"></i>{label}
	</span>
{/if}

<style>
	.badge-bead {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 20px;
		height: 20px;
	}
	.badge-bead .dot {
		width: 8px;
		height: 8px;
	}
</style>
