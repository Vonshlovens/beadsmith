<script lang="ts">
	/**
	 * Loading skeletons match the real geometry, not a generic block
	 * (specs/05). They shimmer at low amplitude and stop entirely under
	 * prefers-reduced-motion.
	 */
	interface Props {
		rows?: number;
		label?: string;
	}

	let { rows = 6, label = 'Loading' }: Props = $props();

	const widths = ['68%', '54%', '74%', '46%', '62%', '58%', '70%', '50%'];
</script>

<div class="panel" aria-busy="true">
	<span class="sr-only">{label}</span>
	<div class="skrow head" aria-hidden="true">
		<div class="skel" style="width:56px;height:8px"></div>
		<div class="skel" style="width:44px;height:8px"></div>
		<div class="skel" style="width:160px;height:8px"></div>
		<span class="spacer"></span>
		<div class="skel" style="width:52px;height:8px"></div>
	</div>
	{#each Array.from({ length: rows }, (_, i) => i) as index (index)}
		<div class="skrow" aria-hidden="true">
			<div class="skel" style="width:76px;height:10px"></div>
			<div class="skel" style="width:58px;height:10px"></div>
			<div
				class="skel"
				style="width:{widths[index % widths.length]};max-width:420px;height:10px"
			></div>
			<span class="spacer"></span>
			<div class="skel" style="width:34px;height:10px"></div>
		</div>
	{/each}
</div>

<style>
	.skrow {
		display: flex;
		align-items: center;
		gap: var(--s-3);
		height: 38px;
		border-bottom: 1px solid var(--line);
		padding: 0 var(--s-4);
	}
	.skrow:last-child {
		border-bottom: 0;
	}
	.head {
		background: var(--s1);
		height: 34px;
	}
</style>
