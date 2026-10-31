<script lang="ts">
	import { onMount } from 'svelte';
	import {
		applyAppearance,
		nextAppearance,
		storedAppearance,
		type Appearance
	} from '#lib/appearance.js';

	let value = $state<Appearance>('auto');

	onMount(() => {
		value = storedAppearance();
		// While on auto, follow the system as it changes.
		const media = window.matchMedia('(prefers-color-scheme: dark)');
		const follow = () => value === 'auto' && applyAppearance('auto');
		media.addEventListener('change', follow);
		return () => media.removeEventListener('change', follow);
	});

	function cycle() {
		value = nextAppearance(value);
		applyAppearance(value);
	}
</script>

<button
	type="button"
	class="toggle"
	onclick={cycle}
	aria-label="Appearance: {value}. Switch to {nextAppearance(value)}."
>
	[{value}]
</button>

<style>
	.toggle {
		padding: 0;
		border: none;
		background: none;
		color: var(--ink);
		font: inherit;
		cursor: pointer;
		text-decoration: underline;
		text-decoration-color: var(--mark);
		text-decoration-thickness: var(--border);
		text-underline-offset: 0.2em;
	}

	.toggle:hover {
		color: var(--mark);
	}
</style>
