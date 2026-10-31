<script lang="ts">
	/** Type is a taxonomy, not a signal: outline chip, no colour except epics. */
	interface Props {
		type: string | undefined;
	}

	let { type }: Props = $props();

	const key = $derived((type ?? '').trim().toLowerCase());
	const modifier = $derived(
		key === 'epic' ? ' type-epic' : key === 'milestone' ? ' type-milestone' : ''
	);
</script>

<span class="type{modifier}">{key || 'task'}</span>
