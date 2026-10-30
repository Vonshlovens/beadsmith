<script lang="ts">
	/**
	 * Three-state theme control in the top bar: system → light → dark → system.
	 * The icon shows the *preference*, not the resolved theme, so `system` stays
	 * distinguishable from whichever theme it currently resolves to.
	 */
	import MonitorIcon from '@lucide/svelte/icons/monitor';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import SunIcon from '@lucide/svelte/icons/sun';
	import { app_state } from '$lib/client/stores.svelte';
	import { themeToggleLabel } from '$lib/client/theme';

	const label = $derived(themeToggleLabel(app_state.theme));
</script>

<button
	class="rail-toggle"
	type="button"
	aria-label={label}
	title={label}
	onclick={() => app_state.cycleTheme()}
>
	{#if app_state.theme === 'system'}
		<MonitorIcon size={15} strokeWidth={1.2} />
	{:else if app_state.theme === 'light'}
		<SunIcon size={15} strokeWidth={1.2} />
	{:else}
		<MoonIcon size={15} strokeWidth={1.2} />
	{/if}
</button>
