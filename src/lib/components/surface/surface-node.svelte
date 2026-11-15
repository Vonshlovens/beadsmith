<script lang="ts">
	/**
	 * One node of a catalog surface and, for Stack and Row, its children
	 * (ADR-0025 rule 2). Every catalog component has exactly one branch here;
	 * the server refused anything else when the surface was saved, so there
	 * is no fallback that guesses at an unknown node. Text props are text:
	 * Svelte escapes them, and only `Markdown` goes through the app's
	 * sanitizing renderer.
	 */
	import MarkdownBody from '#lib/components/markdown-body.svelte';
	import type { SurfaceNode } from '#lib/client/surfaces.js';
	import type { SurfaceBindingResult } from '#lib/surfaces.js';
	import SurfaceButton from './surface-button.svelte';
	import SurfaceChart from './surface-chart.svelte';
	import SurfaceIssueBoard from './surface-issue-board.svelte';
	import SurfaceIssueList from './surface-issue-list.svelte';
	import SurfaceStatTile from './surface-stat-tile.svelte';
	import Self from './surface-node.svelte';

	interface Props {
		id: string;
		nodes: Map<string, SurfaceNode>;
		bindings: Record<string, SurfaceBindingResult> | null;
		/** The surface's name, for the accessible names of its lists. */
		surface_name: string;
	}

	let { id, nodes, bindings, surface_name }: Props = $props();

	const node = $derived(nodes.get(id));
	const result = (name: string) => bindings?.[name];
	/** "blocked_list" reads as "blocked list" to a screen reader. */
	const named = (node_id: string) => `${surface_name}: ${node_id.replace(/[_-]+/g, ' ')}`;
</script>

{#if node === undefined}
	<!-- Unreachable for a spec the server accepted; nothing to draw. -->
{:else if node.component === 'Stack' || node.component === 'Row'}
	<div
		class="sf-layout sf-{node.component === 'Stack' ? 'stack' : 'row'} sf-gap-{node.gap}"
		class:sf-nowrap={node.component === 'Row' && !node.wrap}
	>
		{#each node.children as child (child)}
			<Self id={child} {nodes} {bindings} {surface_name} />
		{/each}
	</div>
{:else if node.component === 'Heading'}
	<svelte:element this={`h${node.level}`} class="sf-h sf-h{node.level}">{node.text}</svelte:element>
{:else if node.component === 'Text'}
	<p class="sf-text">{node.text}</p>
{:else if node.component === 'Markdown'}
	<MarkdownBody source={node.text} />
{:else if node.component === 'StatTile'}
	<SurfaceStatTile label={node.label} hint={node.hint} result={result(node.count)} />
{:else if node.component === 'IssueList'}
	<SurfaceIssueList
		label={named(node.id)}
		limit={node.limit}
		empty={node.empty}
		result={result(node.data)}
	/>
{:else if node.component === 'IssueBoard'}
	<SurfaceIssueBoard label={named(node.id)} result={result(node.data)} />
{:else if node.component === 'Chart'}
	<SurfaceChart by={node.by} title={node.title} result={result(node.data)} />
{:else if node.component === 'Button'}
	<SurfaceButton label={node.label} tone={node.tone} />
{/if}

<style>
	.sf-layout {
		display: flex;
		min-width: 0;
	}
	.sf-stack {
		flex-direction: column;
	}
	.sf-row {
		flex-direction: row;
		flex-wrap: wrap;
		align-items: stretch;
	}
	/* A Row's children share its width; wrapping keeps each one readable. */
	.sf-row > :global(*) {
		flex: 1 1 14rem;
		min-width: 0;
	}
	.sf-row.sf-nowrap {
		flex-wrap: nowrap;
		overflow-x: auto;
	}
	.sf-row.sf-nowrap > :global(*) {
		flex: 1 0 12rem;
	}
	.sf-gap-sm {
		gap: var(--s-2);
	}
	.sf-gap-md {
		gap: var(--s-4);
	}
	.sf-gap-lg {
		gap: var(--s-6);
	}
	.sf-h {
		margin: 0;
		color: var(--tx-hi);
		font-weight: 600;
	}
	.sf-h2 {
		font-size: var(--t-lg);
	}
	.sf-h3 {
		font-size: var(--t-md);
	}
	.sf-h4 {
		font-size: var(--t-sm);
	}
	.sf-text {
		margin: 0;
		max-width: 70ch;
		color: var(--tx-mid);
		font-size: var(--t-sm);
		white-space: pre-line;
	}
</style>
