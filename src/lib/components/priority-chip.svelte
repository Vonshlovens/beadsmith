<script lang="ts">
	/** Priority chip with a weighted left edge. P0 is the only one that borrows ember. */
	import { tip } from '#lib/client/tooltip.js';
	import { priorityClass, priorityName } from '#lib/client/format.js';

	interface Props {
		priority: number | undefined;
	}

	let { priority }: Props = $props();
</script>

<span
	class="prio {priorityClass(priority)}"
	{@attach tip(`Priority ${priority ?? '—'} · ${priorityName(priority)}`)}
>
	P{priority ?? '—'}
</span>
