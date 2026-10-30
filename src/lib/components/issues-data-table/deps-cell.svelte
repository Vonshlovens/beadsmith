<script lang="ts">
	/** Dependency counts: blockers first, dependents second. */
	interface Props {
		dependency_count: number;
		dependent_count: number;
	}

	let { dependency_count, dependent_count }: Props = $props();
</script>

<span class="deps" title="{dependency_count} blocking, {dependent_count} dependent">
	<span class={dependency_count > 0 ? 'up' : 'faint'}>↑{dependency_count}</span>
	<b>↓{dependent_count}</b>
</span>

<style>
	.deps {
		font-size: var(--t-xs);
		color: var(--tx-faint);
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.04em;
	}
	.deps b {
		color: var(--tx-mid);
		font-weight: 400;
	}
	.deps .up {
		color: var(--em-400);
	}
</style>
