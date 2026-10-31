<script lang="ts">
	/** Priority chip with a weighted left edge. P0 is the only one that borrows ember. */
	import { priorityClass, priorityName } from '$lib/client/format';

	interface Props {
		priority: number | undefined;
	}

	let { priority }: Props = $props();
</script>

<span
	class="prio {priorityClass(priority)}"
	title="Priority {priority ?? '—'} · {priorityName(priority)}"
>
	P{priority ?? '—'}
</span>
