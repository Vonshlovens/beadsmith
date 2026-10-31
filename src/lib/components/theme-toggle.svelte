<script lang="ts">
	/**
	 * Three-state theme control, as the website shows it: `[auto]`, `[light]`,
	 * `[dark]`, cycling system → light → dark → system. The word names the
	 * *preference*, not the resolved theme, so `auto` stays distinguishable
	 * from whichever theme it currently resolves to.
	 */
	import { app_state } from '$lib/client/stores.svelte';
	import { themeToggleLabel } from '$lib/client/theme';

	const label = $derived(themeToggleLabel(app_state.theme));
	const word = $derived(app_state.theme === 'system' ? 'auto' : app_state.theme);
</script>

<button
	class="foot-ctl"
	type="button"
	aria-label={label}
	title={label}
	onclick={() => app_state.cycleTheme()}
>
	[{word}]
</button>
