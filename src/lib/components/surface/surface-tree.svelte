<script lang="ts">
	/**
	 * A catalog surface drawn natively from its spec (ADR-0025 rule 2), with
	 * each binding's data as `GET /api/surfaces/:slug/data` resolved it for
	 * this viewer. `bindings` is null when that read failed as a whole; each
	 * data component then says it could not be read, while headings and text
	 * still show.
	 */
	import { surfaceNodes } from '#lib/client/surfaces.js';
	import type { SurfaceBindingResult, SurfaceSpecShape } from '#lib/surfaces.js';
	import SurfaceNode from './surface-node.svelte';

	interface Props {
		spec: SurfaceSpecShape;
		bindings: Record<string, SurfaceBindingResult> | null;
		name: string;
	}

	let { spec, bindings, name }: Props = $props();

	const nodes = $derived(surfaceNodes(spec));
</script>

<div class="sf">
	<SurfaceNode id={spec.root} {nodes} {bindings} surface_name={name} />
</div>

<style>
	.sf {
		min-width: 0;
	}
</style>
