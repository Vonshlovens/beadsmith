<script lang="ts">
	/**
	 * Who can see a grown thing, a saved view or a surface (ADR-0025 rule 7), as a dot and a word:
	 * Private (its owner only), Published (members see it), or, for the
	 * owner, Draft ahead when a newer revision than the published one exists
	 * and members still see the older one.
	 */
	import { tip } from '#lib/client/tooltip.js';
	import type { GrownSummary } from '#lib/grown.js';

	let { view }: { view: GrownSummary<unknown> } = $props();

	const state = $derived(
		!view.published
			? {
					key: 'deferred',
					label: 'Private',
					help: view.mine
						? 'Only you see it. Publish it to show members.'
						: 'Only its owner sees it.'
				}
			: view.unpublished_changes
				? {
						key: 'in_progress',
						label: 'Draft ahead',
						help: 'Members see the published revision. Your newer changes stay private until you publish them.'
					}
				: {
						key: 'open',
						label: 'Published',
						help: view.mine ? 'Members see this revision.' : 'Published by an admin.'
					}
	);
</script>

<span
	class="badge badge-{state.key}"
	{@attach tip(state.help)}
	aria-label="{state.label}: {state.help}"
	><i class="dot dot-{state.key}" aria-hidden="true"></i>{state.label}</span
>
