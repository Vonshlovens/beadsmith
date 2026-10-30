<script lang="ts">
	/**
	 * The top bar (specs/00 §5, §7–9). The rail toggle is the first control
	 * after the skip link so keyboard users reach navigation immediately.
	 * Below 640px the brand keeps only its mark, search becomes an icon, and
	 * First Mate drops its label, so the bar fits a 375px phone.
	 */
	import { tick } from 'svelte';
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import KeyboardIcon from '@lucide/svelte/icons/keyboard';
	import PanelLeftIcon from '@lucide/svelte/icons/panel-left';
	import SearchIcon from '@lucide/svelte/icons/search';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import ProjectSwitcher from '$lib/components/project-switcher.svelte';
	import StatusCluster from '$lib/components/status-cluster.svelte';
	import ThemeToggle from '$lib/components/theme-toggle.svelte';
	import brandMarkDark from '$lib/assets/beadsmith-mark.png';
	import brandMarkLight from '$lib/assets/beadsmith-mark-light.png';
	import { currentProject, projectList } from '$lib/client/projects.svelte';
	import { app_state } from '$lib/client/stores.svelte';
	import { FIRST_MATE_PATH } from '$lib/client/first-mate';
	import { PRODUCT_NAME } from '$lib/product';

	let query = $state(page.url.searchParams.get('q') ?? '');

	const rail_expanded = $derived(app_state.rail_open || !app_state.rail_collapsed);
	const on_first_mate_page = $derived(page.url.pathname === FIRST_MATE_PATH);
	const hotkey_label = $derived(
		browser && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'
	);

	/** On the First Mate page the same control focuses the input. */
	function onFirstMate() {
		if (on_first_mate_page) {
			app_state.focusFirstMatePage();
			return;
		}
		app_state.openFirstMate();
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
		<span class="brand-mark" aria-hidden="true">
			<img class="brand-mark-image brand-mark-image-light" src={brandMarkLight} alt="" />
			<img class="brand-mark-image brand-mark-image-dark" src={brandMarkDark} alt="" />
		</span>
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
		title="First Mate ({hotkey_label})"
		aria-haspopup={on_first_mate_page ? undefined : 'dialog'}
		aria-expanded={on_first_mate_page ? undefined : app_state.first_mate_open}
	>
		<SparklesIcon size={14} strokeWidth={1.3} aria-hidden="true" />
		<span class="fm-tx">First Mate</span>
		<span class="kbd fm-kbd" aria-hidden="true">{hotkey_label}</span>
	</button>

	<button
		class="rail-toggle keys-open"
		type="button"
		aria-label="Keyboard shortcuts"
		title="Keyboard shortcuts (?)"
		onclick={() => (app_state.shortcuts_open = true)}
	>
		<KeyboardIcon size={15} strokeWidth={1.2} />
	</button>

	<ThemeToggle />

	<StatusCluster />
</header>
