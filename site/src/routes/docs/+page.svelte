<script lang="ts">
	import { resolve } from '$app/paths';
	import Head from '#lib/components/Head.svelte';
	import { REPO_URL, repoFile } from '#lib/site.js';

	let { data } = $props();

	// One running number across the groups: 01, 02, …
	const numbered = $derived.by(() => {
		let n = 0;
		return data.groups.map((group) => ({
			...group,
			docs: group.docs.map((doc) => ({ ...doc, n: String(++n).padStart(2, '0') }))
		}));
	});
</script>

<Head title="Docs · Beadsmith" description="Running, using and understanding Beadsmith." />

<h1>Docs</h1>

<p class="lede">
	These pages are the Markdown in the repository's <code>docs/</code> folder, built with the code
	they describe. Where they disagree with the code, the code wins: please say so in
	<a href="{REPO_URL}/discussions">Discussions</a>.
</p>

{#each numbered as group (group.name)}
	<h2>{group.name}<span class="count">{group.docs.length}</span></h2>
	<ol class="index-list">
		{#each group.docs as doc (doc.slug)}
			<li>
				<span class="n">{doc.n}</span>
				<span>
					<a class="title" href={resolve('/docs/[slug]', { slug: doc.slug })}>{doc.title}</a>
					<span class="body">{doc.summary}</span>
				</span>
			</li>
		{/each}
	</ol>
{/each}

<h2>In the repository</h2>

<ul>
	<li>
		<a href={repoFile('specs/README.md')}>Architecture</a>, with the numbered
		<a href={repoFile('specs/decisions')}>decisions</a> behind it.
	</li>
	<li>
		<a href={repoFile('docs/operations/README.md')}>Operations</a>: running Beadsmith on a NixOS
		host built from the repository's flake.
	</li>
	<li>
		<a href={repoFile('docs/dependency-audit.md')}>Dependency audit</a>: why each pin and override
		exists.
	</li>
</ul>
