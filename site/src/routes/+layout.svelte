<script lang="ts">
	import '../app.css';
	import Footer from '#lib/components/Footer.svelte';
	import Masthead from '#lib/components/Masthead.svelte';

	let { children } = $props();
</script>

<div class="page">
	<Masthead />
	<main>
		{@render children()}
	</main>
	<Footer />
</div>
