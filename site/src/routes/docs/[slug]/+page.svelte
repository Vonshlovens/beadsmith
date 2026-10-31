<script lang="ts">
	import { resolve } from '$app/paths';

	let { data } = $props();
</script>

<svelte:head>
	<title>{data.title} · Beadsmith docs</title>
</svelte:head>

<p class="kicker">
	<a href={resolve('/docs')}>docs</a> <span class="muted">/ {data.group.toLowerCase()}</span>
</p>

<h1>{data.title}</h1>

<table class="meta">
	<tbody>
		<tr>
			<th>Source</th>
			<td><a href={data.sourceUrl}>{data.sourcePath}</a></td>
		</tr>
		{#if data.sections.length >= 3}
			<tr>
				<th>Contents</th>
				<td>
					<ol class="contents">
						{#each data.sections as section (section.id)}
							<li><a href="#{section.id}">{section.text}</a></li>
						{/each}
					</ol>
				</td>
			</tr>
		{/if}
	</tbody>
</table>

<article class="prose">
	<!-- The repository's own Markdown, rendered at build time. -->
	{@html data.html}
</article>

<hr />

<nav class="pager" aria-label="More docs">
	{#if data.prev}
		<a href={resolve('/docs/[slug]', { slug: data.prev.slug })}>← {data.prev.title}</a>
	{:else}
		<span></span>
	{/if}
	{#if data.next}
		<a class="next" href={resolve('/docs/[slug]', { slug: data.next.slug })}>{data.next.title} →</a>
	{/if}
</nav>

<style>
	.kicker {
		margin-bottom: var(--lh);
	}

	.kicker a {
		color: var(--ink-muted);
	}

	.meta {
		margin-bottom: calc(var(--lh) * 2);
	}

	.meta th {
		width: 0;
		white-space: nowrap;
		color: var(--ink-muted);
		font-weight: 500;
	}

	.contents {
		margin: 0;
		padding-left: 3ch;
	}

	.contents li::marker {
		color: var(--ink-faint);
	}

	.pager {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: var(--lh) 2ch;
	}

	.next {
		margin-left: auto;
		text-align: right;
	}
</style>
