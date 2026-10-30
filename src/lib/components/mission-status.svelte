<script lang="ts">
	/** Dispatch workflow status using the existing badge + bead colours. */
	import { dispatchBadgeKey } from '$lib/client/format';
	import type { DispatchStatus } from '$lib/types';

	interface Props {
		status: DispatchStatus;
	}

	let { status }: Props = $props();

	const key = $derived(dispatchBadgeKey(status));
	const label = $derived(status.replaceAll('_', ' '));
</script>

<span class="badge badge-{key}">
	<i class="dot dot-{key}" aria-hidden="true"></i>{label}
</span>
