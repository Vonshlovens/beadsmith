<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
</script>

<!--
	Shown for any path that is not a built page: the host serves build/404.html
	(the adapter's fallback), which renders this in the browser.
-->
<svelte:head>
	<title>{page.status} · Beadsmith</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<h1>{page.status === 404 ? 'Not found' : 'Something went wrong'}</h1>

<p class="lede">
	{#if page.status === 404}
		There is no page at <code>{page.url.pathname}</code>. It may have moved when the docs changed.
	{:else}
		{page.error?.message}
	{/if}
</p>

<p><a href={resolve('/')}>Home</a> · <a href={resolve('/docs')}>Docs</a></p>
