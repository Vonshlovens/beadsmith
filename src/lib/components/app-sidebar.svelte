<script lang="ts">
	/**
	 * The rail (specs/00 §5–6). An icon and a word per destination; the
	 * filled icon marks where you are. Collapses to a 56px icon rail on the
	 * desktop, where each icon names itself in a tooltip, and overlays the
	 * content below 900px.
	 *
	 * Order follows use: your own work first (Todos for admins, First Mate,
	 * Ready, Projects), then the project in view, then agents and history.
	 */
	import type { Component } from 'svelte';
	import { page } from '$app/state';
	import ClockCounterClockwiseIcon from 'phosphor-svelte/lib/ClockCounterClockwiseIcon';
	import FoldersIcon from 'phosphor-svelte/lib/FoldersIcon';
	import KanbanIcon from 'phosphor-svelte/lib/KanbanIcon';
	import LightningIcon from 'phosphor-svelte/lib/LightningIcon';
	import ListBulletsIcon from 'phosphor-svelte/lib/ListBulletsIcon';
	import ListChecksIcon from 'phosphor-svelte/lib/ListChecksIcon';
	import RobotIcon from 'phosphor-svelte/lib/RobotIcon';
	import SteeringWheelIcon from 'phosphor-svelte/lib/SteeringWheelIcon';
	import TerminalWindowIcon from 'phosphor-svelte/lib/TerminalWindowIcon';
	import { auth, authErrorMessage } from '#lib/client/auth.js';
	import { currentProject, currentViewer } from '#lib/client/projects.svelte.js';
	import { tip } from '#lib/client/tooltip.js';
	import { toast } from 'svelte-sonner';
	import ThemeToggle from '#lib/components/theme-toggle.svelte';
	import FontToggle from '#lib/components/font-toggle.svelte';
	import { app_state } from '#lib/client/stores.svelte.js';
	import {
		boardNavActive,
		issuesNavActive,
		parseIssueView,
		projectIssuesHref
	} from '#lib/client/issue-view.js';
	import { PROJECTS_PATH } from '#lib/client/home.js';

	interface NavItem {
		href: string;
		label: string;
		icon: Component<{ size?: number; weight?: 'regular' | 'fill' }>;
		active: boolean;
		/** Shortcut shown in the collapsed rail's tooltip. */
		keys?: string;
		count?: number | null;
	}

	interface NavSection {
		label?: string;
		items: NavItem[];
	}

	const current = $derived(currentProject());
	const path = $derived(page.url.pathname);
	const view = $derived(parseIssueView(page.url.searchParams.get('view')));
	const on_issues_list = $derived(current !== null && path === `/p/${current.id}`);
	const list_params = $derived(on_issues_list ? page.url.searchParams : undefined);
	const issues_active = $derived(current !== null && issuesNavActive(path, current.id, view));
	const board_active = $derived(current !== null && boardNavActive(path, current.id, view));
	const viewer = $derived(currentViewer());
	const is_admin = $derived(viewer?.role === 'admin');

	const sections = $derived.by((): NavSection[] => {
		const mine: NavItem[] = [];
		if (is_admin) {
			mine.push({
				href: '/todos',
				label: 'Todos',
				icon: ListChecksIcon,
				active: path === '/todos',
				keys: 'g t'
			});
		}
		mine.push(
			{
				href: '/first-mate',
				label: 'First Mate',
				icon: SteeringWheelIcon,
				active: path === '/first-mate',
				keys: 'g f'
			},
			{
				href: '/ready',
				label: 'Ready',
				icon: LightningIcon,
				active: path === '/ready',
				keys: 'g r'
			},
			{
				href: PROJECTS_PATH,
				label: 'Projects',
				icon: FoldersIcon,
				active: path === PROJECTS_PATH,
				keys: 'g p'
			}
		);
		const result: NavSection[] = [{ items: mine }];
		if (current) {
			result.push({
				label: current.name,
				items: [
					{
						href: projectIssuesHref(current.id, 'parade', list_params),
						label: 'Issues',
						icon: ListBulletsIcon,
						active: issues_active,
						keys: 'g i',
						count: current.counts?.total ?? null
					},
					{
						href: projectIssuesHref(current.id, 'board', list_params),
						label: 'Board',
						icon: KanbanIcon,
						active: board_active,
						keys: 'g b'
					}
				]
			});
		}
		const system: NavItem[] = [
			{
				href: '/missions',
				label: 'Missions',
				icon: RobotIcon,
				active: path === '/missions',
				keys: 'g m'
			},
			{
				href: '/activity',
				label: 'Activity log',
				icon: ClockCounterClockwiseIcon,
				active: path === '/activity',
				keys: 'g a'
			}
		];
		if (is_admin) {
			system.push({
				href: '/console',
				label: 'Console',
				icon: TerminalWindowIcon,
				active: path === '/console',
				keys: 'g c'
			});
		}
		result.push({ label: 'Agents and history', items: system });
		return result;
	});

	/** Labels hide only in the desktop's collapsed rail; the phone drawer shows them. */
	function railCollapsed(): boolean {
		return (
			app_state.rail_collapsed &&
			typeof window !== 'undefined' &&
			window.matchMedia('(min-width: 901px)').matches
		);
	}

	const host = $derived(page.url.host);

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
	{#each sections as section, index (section.label ?? index)}
		{#if section.label}
			<div class="nav-sec"><span class="lbl">{section.label}</span></div>
		{/if}
		<div class="nav" class:nav-first={index === 0}>
			{#each section.items as item (item.href + item.label)}
				{@const Icon = item.icon}
				<a
					class="nav-item{item.active ? ' is-active' : ''}"
					href={item.href}
					aria-current={item.active ? 'page' : undefined}
					aria-label={item.count != null ? `${item.label}, ${item.count} issues` : item.label}
					{@attach tip(item.keys ? `${item.label} (${item.keys})` : item.label, {
						side: 'right',
						when: railCollapsed
					})}
				>
					<span class="nav-ic" aria-hidden="true"
						><Icon size={18} weight={item.active ? 'fill' : 'regular'} /></span
					><span class="nav-tx">{item.label}</span>
					{#if item.count !== undefined && item.count !== null}
						<span class="nav-count mono-num">{item.count}</span>
					{/if}
				</a>
			{/each}
		</div>
	{/each}

	<!-- Who you are, where, and the two rarely used controls (theme, keys). -->
	<div class="sidebar-foot">
		{#if viewer?.email}
			<a class="foot-account" href="/account" {@attach tip('Account settings')}>{viewer.email}</a>
			<span>
				{viewer.role} ·
				<button class="foot-ctl" type="button" disabled={signing_out} onclick={signOut}>
					{signing_out ? 'signing out…' : 'sign out'}
				</button>
			</span>
		{/if}
		<span class="foot-faint" {@attach tip('Beadsmith only reads; agents change Beads with bd')}
			>{host}</span
		>
		<span class="foot-ctls">
			<ThemeToggle />
			<FontToggle />
			<button
				class="foot-ctl keys-open"
				type="button"
				aria-label="Keyboard shortcuts"
				{@attach tip('Keyboard shortcuts (?)')}
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
		flex-wrap: wrap;
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
