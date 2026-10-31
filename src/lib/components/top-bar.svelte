<script lang="ts">
	/**
	 * The top bar (specs/00 §5, §7–9). The rail toggle is the first control
	 * after the skip link so keyboard users reach navigation immediately.
	 * Below 640px the brand keeps only its mark, search becomes an icon, and
	 * First Mate drops its label, so the bar fits a 375px phone. The theme and
	 * keyboard-shortcut controls live in the sidebar footer: both are rarely
	 * used, and both keep their keys (`?` for shortcuts).
	 */
	import { tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import PanelLeftIcon from '@lucide/svelte/icons/panel-left';
	import SearchIcon from '@lucide/svelte/icons/search';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import ProjectSwitcher from '$lib/components/project-switcher.svelte';
	import StatusCluster from '$lib/components/status-cluster.svelte';
	import BrandMark from '$lib/components/brand-mark.svelte';
	import { currentProject, projectList } from '$lib/client/projects.svelte';
	import { app_state } from '$lib/client/stores.svelte';
	import { FIRST_MATE_PATH } from '$lib/client/first-mate';
	import { PRODUCT_NAME } from '$lib/product';

	let query = $state(page.url.searchParams.get('q') ?? '');

	const rail_expanded = $derived(app_state.rail_open || !app_state.rail_collapsed);
	const on_first_mate_page = $derived(page.url.pathname === FIRST_MATE_PATH);

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
		title="Navigation ([)"
		onclick={() => app_state.toggleRailForViewport()}
	>
		<PanelLeftIcon size={15} strokeWidth={1.2} />
	</button>

	<a class="brand" href="/" aria-label="{PRODUCT_NAME}, projects" title={PRODUCT_NAME}>
		<BrandMark size={30} />
		<span class="brand-tx">{PRODUCT_NAME}</span>
	</a>

	<ProjectSwitcher />

	<form class="search" onsubmit={submitSearch} role="search">
		<SearchIcon size={13} strokeWidth={1.4} aria-hidden="true" />
		<input
			type="search"
			placeholder="Search issues"
			aria-label="Search issues"
			data-hotkey="search"
			bind:value={query}
		/>
		<span class="kbd" aria-hidden="true" title="Press / to search">/</span>
	</form>

	<span class="bar-spacer"></span>

	<button
		class="rail-toggle search-phone"
		type="button"
		aria-label="Search issues"
		title="Search issues (/)"
		onclick={searchOnPhone}
	>
		<SearchIcon size={15} strokeWidth={1.2} />
	</button>

	<button
		class="fm-open"
		type="button"
		onclick={onFirstMate}
		aria-label="First Mate"
		title="First Mate (g f)"
		aria-current={on_first_mate_page ? 'page' : undefined}
	>
		<SparklesIcon size={14} strokeWidth={1.3} aria-hidden="true" />
		<span class="fm-tx">First Mate</span>
	</button>

	<StatusCluster />
</header>
