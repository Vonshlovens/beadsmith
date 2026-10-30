<script lang="ts">
	/**
	 * App shell (specs/00 §5): skip link, top bar, rail, scrim, main. The rail
	 * collapses in place on the desktop and overlays the content below 900px.
	 * Signed out (ADR-0011) there is no shell: the sign-in page renders alone
	 * and nothing polls the API.
	 */
	import '../app.css';
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import brandMarkDark from '$lib/assets/beadsmith-mark.png';
	import brandMarkLight from '$lib/assets/beadsmith-mark-light.png';
	import AppSidebar from '$lib/components/app-sidebar.svelte';
	import FirstMate from '$lib/components/first-mate.svelte';
	import TopBar from '$lib/components/top-bar.svelte';
	import { Toaster } from '$lib/components/ui/sonner/index.js';
	import { app_state, startStatusPolling } from '$lib/client/stores.svelte';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	const signed_in = $derived(page.data.viewer != null);

	$effect(() => {
		app_state.loadRailPreference();
		if (!signed_in) {
			return;
		}
		return startStatusPolling();
	});

	// `untrack`: loadThemePreference reads the theme state it also writes, and
	// this effect must run once — not again on every toggle.
	$effect(() => {
		untrack(() => app_state.loadThemePreference());
		return app_state.watchSystemTheme();
	});

	/** Escape closes the overlay drawer. */
	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && app_state.rail_open) {
			app_state.closeDrawer();
		}
	}
</script>

<svelte:head>
	<link
		rel="icon"
		type="image/png"
		href={app_state.resolved_theme === 'dark' ? brandMarkDark : brandMarkLight}
	/>
	<link rel="apple-touch-icon" href={brandMarkLight} />
</svelte:head>

<svelte:window onkeydown={onKeydown} />

{#if signed_in}
	<a class="skip" href="#main">Skip to content</a>

	<div class="app">
		<TopBar />
		<div class="shell">
			<AppSidebar />
			<div
				class="scrim{app_state.rail_open ? ' is-on' : ''}"
				role="presentation"
				onclick={() => app_state.closeDrawer()}
			></div>
			<main class="main" id="main">
				{@render children?.()}
			</main>
		</div>
	</div>

	<FirstMate />
{:else}
	{@render children?.()}
{/if}

<Toaster
	theme={app_state.resolved_theme}
	position="bottom-right"
	closeButton
	duration={6000}
	toastOptions={{ classes: { toast: 'bdui-toast' } }}
/>
