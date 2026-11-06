<script lang="ts">
	/**
	 * The top bar (specs/00 §5, §7–9). The rail toggle is the first control
	 * after the skip link so keyboard users reach navigation immediately.
	 * Below 640px the brand keeps only its mark, search becomes an icon, and
	 * First Mate drops its label, so the bar fits a 375px phone. The theme and
	 * keyboard-shortcut controls live in the sidebar footer: both are rarely
	 * used, and both keep their keys (`?` for shortcuts).
	 */
	import { tip } from '#lib/client/tooltip.js';
	import { tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import SidebarSimpleIcon from 'phosphor-svelte/lib/SidebarSimpleIcon';
	import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';
	import ClockCounterClockwiseIcon from 'phosphor-svelte/lib/ClockCounterClockwiseIcon';
	import SteeringWheelIcon from 'phosphor-svelte/lib/SteeringWheelIcon';
	import { newestStamp } from '#lib/client/activity-groups.js';
	import ProjectSwitcher from '#lib/components/project-switcher.svelte';
	import StatusCluster from '#lib/components/status-cluster.svelte';
	import BrandMark from '#lib/components/brand-mark.svelte';
	import { currentProject, projectList } from '#lib/client/projects.svelte.js';
	import { app_state } from '#lib/client/stores.svelte.js';
	import { FIRST_MATE_PATH } from '#lib/client/first-mate.js';
	import { PRODUCT_NAME } from '#lib/product.js';

	let query = $state(page.url.searchParams.get('q') ?? '');

	const rail_expanded = $derived(app_state.rail_open || !app_state.rail_collapsed);
	const on_first_mate_page = $derived(page.url.pathname === FIRST_MATE_PATH);
	/** Something changed since this browser last opened Recent changes. */
	const activity_unseen = $derived(
		app_state.activity_seen_at > 0 &&
			newestStamp(projectList().map((project) => project.last_activity)) >
				app_state.activity_seen_at
	);

	/** Open a new First Mate chat with its question box focused. */
	async function onFirstMate() {
		if (!on_first_mate_page || page.url.search !== '') {
			await goto(FIRST_MATE_PATH);
		}
		app_state.focusFirstMatePage();
	}

	function searchTarget() {
		return currentProject() ?? projectList()[0];
	}

	/**
	 * Route a search to the issues list of the project in view, falling back
	 * to the first project.
	 *
	 * @param event - The form submit event.
	 */
	async function submitSearch(event: SubmitEvent) {
		event.preventDefault();
		const target = searchTarget();
		if (!target) {
			return;
		}
		const search = query.trim();
		await goto(search ? `/p/${target.id}?q=${encodeURIComponent(search)}` : `/p/${target.id}`);
	}

	/** Phone: open the project's list and focus its filter box. */
	async function searchOnPhone() {
		const target = searchTarget();
		if (!target) {
			app_state.openFirstMate();
			return;
		}
		if (page.params.id !== target.id || page.params.issue_id) {
			await goto(`/p/${target.id}`);
		}
		await tick();
		document.querySelector<HTMLInputElement>('main [data-hotkey="search"]')?.focus();
	}
</script>

<header class="topbar">
	<button
		class="rail-toggle"
		type="button"
		aria-expanded={rail_expanded}
		aria-controls="sidebar"
		aria-label="Toggle navigation"
		{@attach tip('Navigation ([)')}
		onclick={() => app_state.toggleRailForViewport()}
	>
		<SidebarSimpleIcon size={17} />
	</button>

	<a class="brand" href="/" aria-label="{PRODUCT_NAME}, home">
		<BrandMark size={30} />
		<span class="brand-tx">{PRODUCT_NAME}</span>
	</a>

	<ProjectSwitcher />

	<form class="search" onsubmit={submitSearch} role="search">
		<MagnifyingGlassIcon size={13} aria-hidden="true" />
		<input
			type="search"
			placeholder="Search issues"
			aria-label="Search issues"
			data-hotkey="search"
			bind:value={query}
		/>
		<span class="kbd" aria-hidden="true" {@attach tip('Press / to search')}>/</span>
	</form>

	<span class="bar-spacer"></span>

	<button
		class="rail-toggle search-phone"
		type="button"
		aria-label="Search issues"
		{@attach tip('Search issues (/)')}
		onclick={searchOnPhone}
	>
		<MagnifyingGlassIcon size={17} />
	</button>

	<button
		class="rail-toggle activity-open"
		type="button"
		aria-haspopup="dialog"
		aria-expanded={app_state.activity_open}
		aria-label={activity_unseen ? 'Recent changes, new since your last look' : 'Recent changes'}
		{@attach tip(
			activity_unseen ? 'Recent changes: new since your last look (.)' : 'Recent changes (.)'
		)}
		onclick={() => app_state.openActivity()}
	>
		<ClockCounterClockwiseIcon size={17} />
		{#if activity_unseen}<i class="unseen" aria-hidden="true"></i>{/if}
	</button>

	<button
		class="fm-open"
		type="button"
		onclick={onFirstMate}
		aria-label="First Mate"
		{@attach tip('First Mate (g f)')}
		aria-current={on_first_mate_page ? 'page' : undefined}
	>
		<SteeringWheelIcon size={15} aria-hidden="true" />
		<span class="fm-tx">First Mate</span>
	</button>

	<StatusCluster />
</header>

<style>
	.activity-open {
		position: relative;
	}
	/* The red bead: something changed since you last looked. */
	.unseen {
		position: absolute;
		top: 5px;
		right: 5px;
		width: 7px;
		height: 7px;
		border-radius: 99px;
		background: var(--em-500);
		box-shadow: 0 0 0 2px var(--bg);
	}
</style>
