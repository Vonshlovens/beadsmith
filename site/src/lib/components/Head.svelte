<script lang="ts">
	import { page } from '$app/state';
	import { parade_shot } from '#lib/shots.js';
	import { SITE_URL } from '#lib/site.js';

	let { title, description }: { title: string; description: string } = $props();

	// Link previews need absolute URLs. The pathname already carries BASE_PATH.
	const url = $derived(new URL(page.url.pathname, SITE_URL).href);
	const image = new URL(parade_shot.src!, SITE_URL).href;
</script>

<svelte:head>
	<title>{title}</title>
	<meta name="description" content={description} />
	<link rel="canonical" href={url} />
	<meta property="og:type" content="website" />
	<meta property="og:site_name" content="Beadsmith" />
	<meta property="og:title" content={title} />
	<meta property="og:description" content={description} />
	<meta property="og:url" content={url} />
	<meta property="og:image" content={image} />
	<meta property="og:image:width" content={String(parade_shot.width)} />
	<meta property="og:image:height" content={String(parade_shot.height)} />
	<meta property="og:image:alt" content={parade_shot.alt} />
	<meta name="twitter:card" content="summary_large_image" />
</svelte:head>
