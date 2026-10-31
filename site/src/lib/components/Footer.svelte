<script lang="ts">
	import { resolve } from '$app/paths';
	import { BEADS_URL, REPO_URL, repoFile } from '#lib/site.js';
</script>

<footer>
	<hr />
	<p>
		Beadsmith · <a href={repoFile('LICENSE')}>MIT</a> ·
		<a href={REPO_URL}>source</a> ·
		<a href={resolve('/docs')}>docs</a> ·
		<a href="{REPO_URL}/discussions">discussions</a> ·
		<a href={repoFile('SECURITY.md')}>security</a>
	</p>
	<p>
		An independent project, built for <a href={BEADS_URL}>Beads</a>.
	</p>
</footer>

<style>
	footer {
		margin-top: calc(var(--lh) * 3);
		color: var(--ink-muted);
	}

	footer p {
		margin: 0;
	}

	footer a {
		color: var(--ink-muted);
	}

	footer a:hover {
		color: var(--mark);
	}
</style>
