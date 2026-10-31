<script lang="ts">
	/**
	 * The rail (specs/00 §5–6). Beads hang on a thread: the thread marks the
	 * section, the lit bead marks where you are. Collapses to a 56px icon rail
	 * on the desktop and overlays the content below 900px.
	 */
	import { page } from '$app/state';
	import { auth, authErrorMessage } from '$lib/client/auth';
	import { currentProject, currentViewer } from '$lib/client/projects.svelte';
	import { toast } from 'svelte-sonner';
	import ThemeToggle from '$lib/components/theme-toggle.svelte';
	import { app_state } from '$lib/client/stores.svelte';
	import {
		boardNavActive,
		issuesNavActive,
		parseIssueView,
		projectIssuesHref
	} from '$lib/client/issue-view';

	const current = $derived(currentProject());
	const path = $derived(page.url.pathname);
	const view = $derived(parseIssueView(page.url.searchParams.get('view')));
	const on_issues_list = $derived(current !== null && path === `/p/${current.id}`);
	const list_params = $derived(on_issues_list ? page.url.searchParams : undefined);
	const issues_active = $derived(current !== null && issuesNavActive(path, current.id, view));
	const board_active = $derived(current !== null && boardNavActive(path, current.id, view));
	const issues_href = $derived(
		current ? projectIssuesHref(current.id, 'parade', list_params) : '/'
	);
	const board_href = $derived(current ? projectIssuesHref(current.id, 'board', list_params) : '/');

	const issue_count = $derived(current?.counts?.total ?? null);
	const host = $derived(page.url.host);
	const viewer = $derived(currentViewer());

	let signing_out = $state(false);

	/** End the account session and return to the sign-in page. */
	async function signOut() {
		if (signing_out) return;
		signing_out = true;
		try {
			await auth.signOut();
			window.location.assign('/auth');
		} catch (error) {
			signing_out = false;
			toast.error('Could not sign out', { description: authErrorMessage(error) });
		}
	}
</script>

<aside
	class="sidebar{app_state.rail_collapsed ? ' is-collapsed' : ''}{app_state.rail_open
		? ' is-open'
		: ''}"
	id="sidebar"
	aria-label="Primary"
>
	<div class="nav">
		<div class="nav-thread" aria-hidden="true"></div>
		<a
			class="nav-item{path === '/' ? ' is-active' : ''}"
			href="/"
			title="Projects"
			aria-current={path === '/' ? 'page' : undefined}
		>
			<i class="nav-bead" aria-hidden="true"></i><span class="nav-tx">Projects</span>
		</a>
	</div>

	{#if current}
		<div class="nav-sec"><span class="lbl">{current.name}</span></div>
		<div class="nav">
			<div class="nav-thread" aria-hidden="true"></div>
			<a
				class="nav-item{issues_active ? ' is-active' : ''}"
				href={issues_href}
				title="Issues"
				aria-current={issues_active ? 'page' : undefined}
			>
				<i class="nav-bead" aria-hidden="true"></i><span class="nav-tx">Issues</span>
				{#if issue_count !== null}
					<span class="nav-count mono-num">{issue_count}</span>
				{/if}
			</a>
			<a
				class="nav-item{board_active ? ' is-active' : ''}"
				href={board_href}
				title="Board"
				aria-current={board_active ? 'page' : undefined}
			>
				<i class="nav-bead" aria-hidden="true"></i><span class="nav-tx">Board</span>
			</a>
		</div>
	{/if}

	<div class="nav-sec"><span class="lbl">System</span></div>
	<div class="nav">
		<div class="nav-thread" aria-hidden="true"></div>
		<a
			class="nav-item{path === '/first-mate' ? ' is-active' : ''}"
			href="/first-mate"
			title="First Mate"
			aria-current={path === '/first-mate' ? 'page' : undefined}
		>
			<i class="nav-bead" aria-hidden="true"></i><span class="nav-tx">First Mate</span>
		</a>
		<a
			class="nav-item{path === '/ready' ? ' is-active' : ''}"
			href="/ready"
			title="Ready"
			aria-current={path === '/ready' ? 'page' : undefined}
		>
			<i class="nav-bead" aria-hidden="true"></i><span class="nav-tx">Ready</span>
		</a>
		<a
			class="nav-item{path === '/missions' ? ' is-active' : ''}"
			href="/missions"
			title="Missions"
			aria-current={path === '/missions' ? 'page' : undefined}
		>
			<i class="nav-bead" aria-hidden="true"></i><span class="nav-tx">Missions</span>
		</a>
		<a
			class="nav-item{path === '/activity' ? ' is-active' : ''}"
			href="/activity"
			title="Activity log"
			aria-current={path === '/activity' ? 'page' : undefined}
		>
			<i class="nav-bead" aria-hidden="true"></i><span class="nav-tx">Activity log</span>
		</a>
		{#if viewer?.role === 'admin'}
			<a
				class="nav-item{path === '/todos' ? ' is-active' : ''}"
				href="/todos"
				title="Todos"
				aria-current={path === '/todos' ? 'page' : undefined}
			>
				<i class="nav-bead" aria-hidden="true"></i><span class="nav-tx">Todos</span>
			</a>
			<a
				class="nav-item{path === '/console' ? ' is-active' : ''}"
				href="/console"
				title="Console"
				aria-current={path === '/console' ? 'page' : undefined}
			>
				<i class="nav-bead" aria-hidden="true"></i><span class="nav-tx">Console</span>
			</a>
		{/if}
	</div>

	<!-- Who you are, where, and the two rarely used controls (theme, keys). -->
	<div class="sidebar-foot">
		{#if viewer?.email}
			<a class="foot-account" href="/account" title="Account">{viewer.email}</a>
			<span>
				{viewer.role} ·
				<button class="foot-ctl" type="button" disabled={signing_out} onclick={signOut}>
					{signing_out ? 'signing out…' : 'sign out'}
				</button>
			</span>
		{/if}
		<span class="foot-faint" title="Beadsmith only reads; agents change Beads with bd">{host}</span>
		<span class="foot-ctls">
			<ThemeToggle />
			<button
				class="foot-ctl keys-open"
				type="button"
				aria-label="Keyboard shortcuts"
				title="Keyboard shortcuts (?)"
				onclick={() => (app_state.shortcuts_open = true)}>[? keys]</button
			>
		</span>
	</div>
</aside>

<style>
	.foot-account {
		color: var(--tx-hi);
		overflow-wrap: anywhere;
	}
	.foot-account:hover {
		text-decoration: underline;
		text-decoration-color: var(--em-500);
	}
	.foot-faint {
		color: var(--tx-dim);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.foot-ctls {
		display: flex;
		gap: var(--s-2);
		margin-top: var(--s-1);
	}
	/* The theme toggle's button is the same control. */
	.sidebar-foot :global(.foot-ctl) {
		background: none;
		border: 0;
		padding: 0;
		font: inherit;
		color: var(--tx-mid);
		cursor: pointer;
	}
	.sidebar-foot :global(.foot-ctl:hover) {
		color: var(--tx-hi);
		text-decoration: underline;
		text-decoration-color: var(--em-500);
	}
</style>
