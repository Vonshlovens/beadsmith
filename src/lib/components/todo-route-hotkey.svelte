<script lang="ts">
	/**
	 * The `r` key on a focused todo card. It is a component of its own because
	 * the newest hotkey scope wins a key, and this has to be newer than the page
	 * header's `r` (refresh). With no routable card focused it is switched off
	 * and `r` refreshes as everywhere else.
	 */
	import { useHotkeys } from '$lib/client/hotkeys.svelte';

	let { enabled, onroute }: { enabled: boolean; onroute: () => void } = $props();

	useHotkeys(() => [
		{
			keys: ['r'],
			label: 'Route the focused todo to a project',
			group: 'General',
			when: () => enabled,
			run: onroute
		}
	]);
</script>
