<script lang="ts">
	/** Assignee cell: the name, or a faint unassigned placeholder. */
	interface Props {
		assignee: string | undefined;
	}

	let { assignee }: Props = $props();
</script>

{#if assignee}{assignee}{:else}<span class="faint">unassigned</span>{/if}
