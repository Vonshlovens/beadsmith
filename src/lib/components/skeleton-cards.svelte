<script lang="ts">
	/** Project-card skeletons: same geometry as the real card (specs/05). */
	interface Props {
		count?: number;
		label?: string;
	}

	let { count = 3, label = 'Loading projects' }: Props = $props();
</script>

<div class="pgrid" aria-busy="true">
	<span class="sr-only">{label}</span>
	{#each Array.from({ length: count }, (_, i) => i) as index (index)}
		<div class="skcard" aria-hidden="true">
			<div class="row" style="align-items:flex-start">
				<div style="flex:1">
					<div class="skel" style="width:58%;height:13px"></div>
					<div class="skel mt-2" style="width:38%;height:9px"></div>
				</div>
				<div class="skel" style="width:54px;height:9px"></div>
			</div>
			<div class="skel mt-4" style="height:3px"></div>
			<div class="row mt-3 gap-3">
				<div class="skel" style="width:52px;height:9px"></div>
				<div class="skel" style="width:52px;height:9px"></div>
				<div class="skel" style="width:52px;height:9px"></div>
			</div>
			<div class="rule mt-4"></div>
			<div class="row mt-3">
				<div class="skel" style="width:44%;height:9px"></div>
				<span class="spacer"></span>
				<div class="skel" style="width:52px;height:9px"></div>
			</div>
		</div>
	{/each}
</div>

<style>
	.pgrid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(292px, 1fr));
		gap: var(--s-3);
	}
	.skcard {
		border: 1px solid var(--line);
		border-radius: var(--r-2);
		background: var(--s2);
		padding: var(--s-4);
	}
</style>
