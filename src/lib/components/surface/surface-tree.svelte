<script lang="ts">
	/**
	 * A catalog surface drawn natively from its spec (ADR-0025 rule 2), with
	 * each binding's data as `GET /api/surfaces/:slug/data` resolved it for
	 * this viewer. `bindings` is null when that read failed as a whole; each
	 * data component then says it could not be read, while headings and text
	 * still show.
	 */
	import { surfaceNodes, type SurfaceHost } from '#lib/client/surfaces.js';
	import type { SurfaceBindingResult, SurfaceSpecShape } from '#lib/surfaces.js';
	import SurfaceNode from './surface-node.svelte';

	interface Props {
		spec: SurfaceSpecShape;
		bindings: Record<string, SurfaceBindingResult> | null;
		name: string;
		/** The slug and revision on screen, for the buttons' actions. */
		slug: string;
		revision: number;
		/** Whether the viewer may run actions (an admin). */
		can_act: boolean;
	}

	let { spec, bindings, name, slug, revision, can_act }: Props = $props();

	const nodes = $derived(surfaceNodes(spec));
	const host: SurfaceHost = $derived({ slug, revision, actions: spec.actions, can_act });
</script>

<div class="sf">
	<SurfaceNode id={spec.root} {nodes} {bindings} {host} surface_name={name} />
</div>

<style>
	.sf {
		min-width: 0;
	}
</style>
