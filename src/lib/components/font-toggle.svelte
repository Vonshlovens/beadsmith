<script lang="ts">
	/**
	 * Interface font trial: `[mono]` is JetBrains Mono everywhere, `[sans]`
	 * sets the interface and long Markdown in Commissioner while IDs, keys,
	 * code and numbers stay monospace (app.css, `data-font`). The choice is
	 * per browser (localStorage); app.html applies it before first paint.
	 */
	import { tip } from '#lib/client/tooltip.js';
	import { onMount } from 'svelte';

	const STORAGE_KEY = 'bdui.font';

	let font = $state<'mono' | 'commissioner'>('mono');
	const word = $derived(font === 'commissioner' ? 'sans' : 'mono');
	const label = $derived(
		font === 'commissioner'
			? 'Interface font: Commissioner. Switch to JetBrains Mono'
			: 'Interface font: JetBrains Mono. Switch to Commissioner'
	);

	onMount(() => {
		font = document.documentElement.dataset.font === 'commissioner' ? 'commissioner' : 'mono';
	});

	function toggle() {
		font = font === 'commissioner' ? 'mono' : 'commissioner';
		if (font === 'commissioner') {
			document.documentElement.dataset.font = font;
		} else {
			delete document.documentElement.dataset.font;
		}
		try {
			localStorage.setItem(STORAGE_KEY, font);
		} catch {
			/* storage blocked: the choice lasts until reload */
		}
	}
</script>

<button class="foot-ctl" type="button" aria-label={label} {@attach tip(label)} onclick={toggle}>
	[{word}]
</button>
