<script lang="ts">
	/**
	 * The catalog's Chart: a bar per value of one field (status, priority,
	 * type, assignee or project), counting a binding's issues. It is a
	 * snapshot of the rows read now, not a trend, so the caption says what was
	 * counted and from how many issues, and every bar carries its count as
	 * text (docs/design-standards.md, "Choose a view").
	 */
	import { projectList } from '#lib/client/projects.svelte.js';
	import { surfaceBars, surfaceIssues } from '#lib/client/surfaces.js';
	import type { SurfaceBindingResult } from '#lib/surfaces.js';
	import type { ViewGroup } from '#lib/views.js';
	import SurfaceBindingError from './surface-binding-error.svelte';

	interface Props {
		by: ViewGroup;
		title?: string;
		result: SurfaceBindingResult | undefined;
	}

	let { by, title, result }: Props = $props();

	const names = $derived(new Map(projectList().map((p) => [p.id, p.name])));
	const read = $derived(surfaceIssues(result, (id) => names.get(id) ?? id));
	const bars = $derived(read.ok ? surfaceBars(read.value.issues, by) : []);
	const max = $derived(Math.max(1, ...bars.map((bar) => bar.count)));
	const caption = $derived(title ?? `Issues by ${by}`);
	const counted = $derived(read.ok ? read.value.issues.length : 0);
	const partial = $derived(read.ok && (read.value.dropped > 0 || read.value.more));
</script>

{#if !read.ok}
	<SurfaceBindingError what={caption} message={read.message} />
{:else}
	<figure class="sf-chart panel">
		<figcaption>
			<span class="sf-chart-t">{caption}</span>
			<span class="hint"
				>{counted} issues by {by}, as read now{partial ? '; not every issue was read' : ''}</span
			>
		</figcaption>
		{#if bars.length === 0}
			<p class="hint">No issues to count.</p>
		{:else}
			<ul class="sf-bars" aria-label={caption}>
				{#each bars as bar (bar.key)}
					<li class="sf-bar">
						<span class="sf-bar-l">{bar.label}</span>
						<span class="sf-bar-track" aria-hidden="true">
							<span class="sf-bar-fill" style="width: {(bar.count / max) * 100}%"></span>
						</span>
						<span class="sf-bar-n mono-num">{bar.count}</span>
					</li>
				{/each}
			</ul>
		{/if}
	</figure>
{/if}

<style>
	.sf-chart {
		display: flex;
		flex-direction: column;
		gap: var(--s-3);
		margin: 0;
		padding: var(--s-3) var(--s-4);
		min-width: 0;
	}
	figcaption {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.sf-chart-t {
		color: var(--tx-hi);
		font-size: var(--t-sm);
		font-weight: 600;
	}
	.sf-bars {
		display: flex;
		flex-direction: column;
		gap: var(--s-2);
		list-style: none;
		margin: 0;
		padding: 0;
		font-size: var(--t-xs);
	}
	.sf-bar {
		display: grid;
		grid-template-columns: minmax(0, 12em) minmax(4rem, 1fr) 3.5em;
		gap: var(--s-3);
		align-items: center;
	}
	.sf-bar-l {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--tx-mid);
	}
	.sf-bar-track {
		height: 10px;
		border-radius: var(--r-1);
		background: var(--s3);
		overflow: hidden;
	}
	.sf-bar-fill {
		display: block;
		height: 100%;
		min-width: 2px;
		background: var(--line-3);
	}
	.sf-bar-n {
		color: var(--tx-hi);
		text-align: right;
	}
</style>
