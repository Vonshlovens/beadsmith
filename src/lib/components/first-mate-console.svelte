<script lang="ts">
	/**
	 * First Mate's command console: the ⌘K palette body. The `page` variant is
	 * the same console laid out inline, for a host page that wants one.
	 * File and Tackle dialogs stay with the host, because the palette dialog
	 * unmounts this component when it closes.
	 */
	import CaretLeftIcon from 'phosphor-svelte/lib/CaretLeftIcon';
	import { tip } from '#lib/client/tooltip.js';
	import { tick, untrack, type Snippet } from 'svelte';
	import { page } from '$app/state';
	import RobotIcon from 'phosphor-svelte/lib/RobotIcon';
	import { refreshAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { api, errorMessage } from '#lib/client/api.js';
	import { auth, authErrorMessage } from '#lib/client/auth.js';
	import { loadRecentIssues, type RecentIssue } from '#lib/client/recent-issues.js';
	import { agentAvailability } from '#lib/client/agent.js';
	import { app_state } from '#lib/client/stores.svelte.js';
	import {
		catalogFetchForView,
		FIRST_MATE_GROUP_ORDER,
		fileProjectRows,
		filterCommands,
		paletteRows,
		sortByGroup,
		findReadyIssue,
		missionRows,
		parseFirstMateQuery,
		readyRows,
		remainderAfterIntent,
		resolveView,
		type FirstMateCommand,
		type FirstMateMission,
		type FirstMateReadyIssue,
		type FirstMateView
	} from '#lib/client/first-mate.js';
	import {
		currentProject,
		currentViewer,
		projectList,
		statusSnapshot
	} from '#lib/client/projects.svelte.js';

	interface Props {
		variant: 'palette' | 'page';
		/** Fetch and focus only while true. */
		active: boolean;
		initial_query?: string;
		initial_view?: FirstMateView | null;
		/** Bump to refetch the current view. */
		refresh_key?: number;
		/** Bump to focus and select the input. */
		focus_key?: number;
		/** Palette renders this as Dialog.Title; the page renders it as the view crumb. */
		title: Snippet<[heading: string]>;
		onNavigate: (href: string) => void | Promise<void>;
		onFile: (project_id: string) => void;
		onTackle: (t: { project_id: string; issue_id: string; issue_title: string }) => void;
		/** Page writes this back to the URL. */
		onStateChange?: (s: { query: string; view: FirstMateView | null }) => void;
		/** The palette closes after a local action; the page has nothing to close. */
		onClose?: () => void;
	}

	let {
		variant,
		active,
		initial_query = '',
		initial_view = null,
		refresh_key = 0,
		focus_key = 0,
		title,
		onNavigate,
		onFile,
		onTackle,
		onStateChange,
		onClose
	}: Props = $props();

	const on_auth = $derived(page.url.pathname === '/auth');
	const dispatch_enabled = $derived(statusSnapshot()?.dispatch.enabled === true);
	const project = $derived(currentProject());
	const file_allowed = $derived(dispatch_enabled && project?.allow?.file !== false);
	const tackle_allowed = $derived(dispatch_enabled && project?.allow?.tackle !== false);

	const mate_projects = $derived(
		projectList().map((item) => {
			return {
				id: item.id,
				name: item.name,
				file_allowed: dispatch_enabled && item.allow?.file !== false,
				tackle_allowed: dispatch_enabled && item.allow?.tackle !== false
			};
		})
	);

	const tackle_by_project = $derived(
		Object.fromEntries(mate_projects.map((item) => [item.id, item.tackle_allowed]))
	);

	let query = $state(untrack(() => initial_query));
	let pinned_view = $state<FirstMateView | null>(untrack(() => initial_view));
	let selected = $state(0);
	let loading = $state(false);
	let refreshing = $state(false);
	let load_error = $state<string | null>(null);
	let ready_issues = $state<FirstMateReadyIssue[]>([]);
	let missions = $state<FirstMateMission[]>([]);
	let input_el: HTMLInputElement | null = $state(null);
	let recent_issues = $state<RecentIssue[]>([]);
	let working = $state(false);
	let list_el: HTMLDivElement | null = $state(null);

	const intent = $derived(parseFirstMateQuery(query));
	const view = $derived(resolveView(intent, pinned_view));
	const remainder = $derived(remainderAfterIntent(query, intent));

	const command_ctx = $derived({
		current_project_id: project?.id,
		current_project_name: project?.name,
		current_issue_id: page.params.issue_id,
		current_issue_title: recent_issues.find((issue) => {
			return issue.issue_id === page.params.issue_id && issue.project_id === project?.id;
		})?.title,
		dispatch_enabled,
		file_allowed,
		tackle_allowed,
		agent_visible: agentAvailability(statusSnapshot(), project?.allow).visible,
		on_first_mate_page: variant === 'page',
		projects: mate_projects,
		is_admin: currentViewer()?.role === 'admin',
		theme: app_state.theme,
		rail_collapsed: app_state.rail_collapsed,
		page_url: variant === 'palette' ? page.url.href : undefined,
		recent_issues
	});

	const rows = $derived.by(() => sortByGroup(viewRows()));

	function viewRows(): FirstMateCommand[] {
		if (view === 'ready') {
			return filterCommands(readyRows(ready_issues, 'open', tackle_by_project), remainder);
		}
		if (view === 'tackle-pick') {
			const list = filterCommands(readyRows(ready_issues, 'tackle', tackle_by_project), remainder);
			if (intent.kind === 'tackle' && intent.issue_id) {
				const match = findReadyIssue(ready_issues, intent.issue_id);
				if (match && tackle_by_project[match.project_id]) {
					const preferred = list.filter((row) => {
						return row.action.type === 'tackle' && row.action.issue_id === match.id;
					});
					if (preferred.length > 0) {
						return preferred;
					}
				}
			}
			return list;
		}
		if (view === 'missions') {
			return filterCommands(missionRows(missions), remainder);
		}
		if (view === 'file-project') {
			if (project?.id && file_allowed && remainder.length === 0) {
				return [
					{
						id: 'file-current-view',
						group: 'Dispatch',
						title: `File an issue in ${project.name}`,
						hint: 'An agent files it with bd',
						keywords: ['file', project.id, project.name],
						launches_agent: true,
						action: { type: 'file', project_id: project.id }
					},
					...filterCommands(
						fileProjectRows(mate_projects).filter((row) => {
							return row.action.type === 'file' && row.action.project_id !== project.id;
						}),
						remainder
					)
				];
			}
			return filterCommands(fileProjectRows(mate_projects), remainder);
		}
		return paletteRows(command_ctx, query);
	}

	const groups = $derived.by(() => {
		return FIRST_MATE_GROUP_ORDER.map((group) => {
			return { group, items: rows.filter((row) => row.group === group) };
		}).filter((entry) => entry.items.length > 0);
	});

	const active_index = $derived(rows.length === 0 ? 0 : Math.min(selected, rows.length - 1));
	const selected_row = $derived(rows[active_index] ?? null);
	const heading = $derived.by(() => {
		if (view === 'ready') {
			return 'Ready';
		}
		if (view === 'tackle-pick') {
			return 'Tackle';
		}
		if (view === 'missions') {
			return 'Missions';
		}
		if (view === 'file-project') {
			return 'File';
		}
		return 'Commands';
	});
	const placeholder = $derived.by(() => {
		if (view === 'ready') {
			return 'Filter unblocked work…';
		}
		if (view === 'tackle-pick') {
			return 'Pick an issue to tackle…';
		}
		if (view === 'missions') {
			return 'Filter missions…';
		}
		if (view === 'file-project') {
			return 'Pick a project to file in…';
		}
		return 'Go to a page or issue ID, run a command, ask…';
	});
	const palette_hint = $derived(refreshing ? 'Refreshing…' : '');
	const hotkey_label = $derived(
		typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl+K'
	);
	const open_label = $derived(selected_row?.launches_agent ? 'enqueue' : 'open');

	$effect(() => {
		onStateChange?.({ query, view: view === 'commands' ? null : view });
	});

	$effect(() => {
		if (active) {
			recent_issues = loadRecentIssues();
		}
	});

	$effect(() => {
		if (!active || on_auth) {
			return;
		}
		const needed = catalogFetchForView(view);
		const generation = refresh_key;
		void generation;
		if (needed === null) {
			load_error = null;
			loading = false;
			refreshing = false;
			return;
		}
		const ac = new AbortController();
		const had_rows = untrack(() => {
			return needed === 'ready' ? ready_issues.length > 0 : missions.length > 0;
		});
		if (had_rows) {
			refreshing = true;
			loading = false;
		} else {
			loading = true;
			refreshing = false;
		}
		load_error = null;
		void (async () => {
			try {
				if (needed === 'ready') {
					const payload = await api.ready(100, { signal: ac.signal });
					if (ac.signal.aborted) {
						return;
					}
					ready_issues = payload.issues;
				} else {
					const payload = await api.missions({ limit: 50 }, { signal: ac.signal });
					if (ac.signal.aborted) {
						return;
					}
					missions = payload.missions;
				}
			} catch (error) {
				if (ac.signal.aborted) {
					return;
				}
				load_error = errorMessage(error);
			} finally {
				if (!ac.signal.aborted) {
					loading = false;
					refreshing = false;
				}
			}
		})();
		return () => ac.abort();
	});

	$effect(() => {
		if (!active || on_auth) {
			return;
		}
		const key = focus_key;
		void tick().then(() => {
			if (!input_el) {
				return;
			}
			input_el.focus();
			if (key > 0) {
				input_el.select();
			}
		});
	});

	function moveSelection(delta: number) {
		if (rows.length === 0) {
			return;
		}
		selected = (active_index + delta + rows.length) % rows.length;
		void tick().then(() => {
			const current = list_el?.querySelector('[data-selected="true"]');
			if (current instanceof HTMLElement) {
				current.scrollIntoView({ block: 'nearest' });
			}
		});
	}

	function showAllCommands() {
		query = '';
		pinned_view = null;
		selected = 0;
		void tick().then(() => input_el?.focus());
	}

	async function activate(row: FirstMateCommand | null) {
		if (!row) {
			return;
		}
		const { action } = row;
		if (action.type === 'view') {
			pinned_view = action.view;
			query = '';
			selected = 0;
			return;
		}
		if (action.type === 'pick_file_project') {
			pinned_view = 'file-project';
			query = '';
			selected = 0;
			return;
		}
		if (action.type === 'navigate') {
			await onNavigate(action.href);
			return;
		}
		if (action.type === 'file') {
			onFile(action.project_id);
			return;
		}
		if (action.type === 'tackle') {
			onTackle({
				project_id: action.project_id,
				issue_id: action.issue_id,
				issue_title: action.issue_title
			});
			return;
		}
		if (action.type === 'agent') {
			app_state.openAgent({
				project_id: action.project_id,
				issue_id: action.issue_id,
				issue_title: action.issue_title
			});
			return;
		}
		if (action.type === 'copy') {
			try {
				await navigator.clipboard.writeText(action.text);
				toast.success(`${action.what} copied`, { description: action.text });
			} catch {
				toast.error(`Could not copy the ${action.what.toLowerCase()}`, {
					description: 'The browser refused clipboard access.'
				});
			}
			onClose?.();
			return;
		}
		if (action.type === 'todo') {
			if (working) return;
			working = true;
			try {
				await api.createTodo({
					title: action.title,
					priority: action.priority,
					due_at: action.due_at,
					tags: action.tags
				});
				query = '';
				toast.success('Todo added', {
					description: action.title,
					action: { label: 'Open todos', onClick: () => void onNavigate('/todos') }
				});
				if (page.url.pathname === '/todos') await refreshAll();
				onClose?.();
			} catch (error) {
				toast.error('Could not add the todo', { description: errorMessage(error) });
			} finally {
				working = false;
			}
			return;
		}
		if (action.type === 'local') {
			await runLocal(action.action);
		}
	}

	async function runLocal(
		action: Extract<FirstMateCommand['action'], { type: 'local' }>['action']
	) {
		switch (action) {
			case 'activity':
				app_state.openActivity();
				return;
			case 'shortcuts':
				onClose?.();
				app_state.shortcuts_open = true;
				return;
			case 'theme-light':
			case 'theme-dark':
			case 'theme-system':
				void app_state.setTheme(
					action === 'theme-light' ? 'light' : action === 'theme-dark' ? 'dark' : 'system'
				);
				onClose?.();
				return;
			case 'rail':
				app_state.toggleRailForViewport();
				onClose?.();
				return;
			case 'refresh-projects':
				if (working) return;
				working = true;
				try {
					await api.refreshProjects();
					await refreshAll();
					toast.success('Projects refreshed', { description: `${projectList().length} projects` });
					onClose?.();
				} catch (error) {
					toast.error('Could not refresh projects', { description: errorMessage(error) });
				} finally {
					working = false;
				}
				return;
			case 'sign-out':
				if (working) return;
				working = true;
				try {
					await auth.signOut();
					window.location.assign('/auth');
				} catch (error) {
					working = false;
					toast.error('Could not sign out', { description: authErrorMessage(error) });
				}
				return;
		}
	}

	function onQueryKeydown(event: KeyboardEvent) {
		if (variant === 'page' && event.key === 'Escape') {
			event.preventDefault();
			if (query.length > 0) {
				query = '';
				selected = 0;
				return;
			}
			if (pinned_view !== null) {
				pinned_view = null;
				selected = 0;
			}
			return;
		}
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			moveSelection(1);
			return;
		}
		if (event.key === 'ArrowUp') {
			event.preventDefault();
			moveSelection(-1);
			return;
		}
		if (event.key === 'Enter') {
			event.preventDefault();
			void activate(selected_row);
			return;
		}
		if (event.key === 'Backspace' && query.length === 0 && pinned_view !== null) {
			event.preventDefault();
			pinned_view = null;
			selected = 0;
		}
	}

	function rowId(row: FirstMateCommand, index: number): string {
		return `first-mate-opt-${index}-${row.id}`;
	}
</script>

<div class="console" class:is-page={variant === 'page'}>
	{#if variant === 'palette'}
		<div class="modal-hd">
			{@render title(heading)}
			<span class="hint-inline">{palette_hint}</span>
			<span class="kbd">{hotkey_label}</span>
		</div>
	{/if}
	<div class="search-row">
		<input
			bind:this={input_el}
			class="palette-input"
			type="search"
			role="combobox"
			aria-label="First Mate"
			aria-autocomplete="list"
			aria-expanded="true"
			aria-controls="first-mate-results"
			aria-activedescendant={selected_row ? rowId(selected_row, active_index) : undefined}
			{placeholder}
			autocomplete="off"
			spellcheck="false"
			bind:value={query}
			onkeydown={onQueryKeydown}
		/>
	</div>
	{#if variant === 'page'}
		{#if view !== 'commands'}
			<div class="crumb">
				<button class="crumb-back" type="button" onclick={showAllCommands}
					><CaretLeftIcon size={11} weight="bold" aria-hidden="true" /> All commands</button
				>
				<span aria-hidden="true">·</span>
				{@render title(heading)}
			</div>
		{/if}
	{/if}
	<div
		class="results"
		class:modal-bd={variant === 'palette'}
		id="first-mate-results"
		role="listbox"
		bind:this={list_el}
	>
		{#if loading}
			<div class="empty-row">Loading…</div>
		{:else if load_error}
			<div class="empty-row" role="alert">{load_error}</div>
		{:else if rows.length === 0}
			<div class="empty-row">
				{#if view === 'ready'}
					Nothing is ready. No agent was launched.
				{:else if view === 'tackle-pick'}
					No allowed ready issue matches.
				{:else if view === 'missions'}
					No missions match.
				{:else if view === 'file-project'}
					No project is allowed to File.
				{:else}
					No matching commands.
				{/if}
			</div>
		{:else}
			{#each groups as group (group.group)}
				<div class="group-lbl">{group.group}</div>
				{#each group.items as row (`${group.group}-${row.id}`)}
					{@const index = rows.indexOf(row)}
					<button
						class="row"
						type="button"
						role="option"
						id={rowId(row, index)}
						aria-selected={index === active_index}
						data-selected={index === active_index ? 'true' : undefined}
						onmouseenter={() => (selected = index)}
						onclick={() => void activate(row)}
					>
						<span class="row-title">{row.title}</span>
						<span class="row-hint">{row.hint}</span>
						{#if row.shortcut}
							<span class="row-keys" aria-label="shortcut {row.shortcut}">
								{#each row.shortcut.split(' ') as key, at (at)}<kbd class="kbd">{key}</kbd>{/each}
							</span>
						{/if}
						{#if row.launches_agent}
							<span
								class="row-agent"
								{@attach tip('Launches an agent')}
								aria-label="launches an agent"
							>
								<RobotIcon size={13} />
							</span>
						{/if}
					</button>
				{/each}
			{/each}
		{/if}
	</div>
	{#if variant === 'palette'}
		<div class="modal-ft">
			<span class="xs faint">
				<span class="kbd">↑↓</span> move
				<span class="kbd">⏎</span>
				{open_label}
				<span class="kbd">esc</span> close
			</span>
			<span class="spacer"></span>
			<span class="xs faint"><span class="kbd">?</span> all keys</span>
		</div>
	{/if}
</div>

<style>
	.console {
		display: flex;
		flex-direction: column;
		min-height: 0;
		flex: 1;
	}
	.hint-inline {
		margin-left: auto;
		font-size: var(--t-xs);
		color: var(--tx-dim);
	}
	.search-row {
		padding: var(--s-3) var(--s-5) 0;
	}
	.console.is-page .search-row {
		padding: 0;
	}
	.palette-input {
		width: 100%;
		height: 36px;
		padding: 0 10px;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: var(--r-1);
		color: var(--tx-hi);
		font-size: var(--t-sm);
		outline: none;
	}
	.console.is-page .palette-input {
		height: 44px;
	}
	.palette-input:focus {
		border-color: var(--line-2);
	}
	.crumb {
		display: flex;
		align-items: baseline;
		gap: 8px;
		padding: var(--s-3) 0 0;
		font-size: var(--t-xs);
		color: var(--tx-dim);
	}
	.crumb-back {
		border: 0;
		background: none;
		padding: 0;
		color: var(--tx-dim);
		font: inherit;
		cursor: pointer;
	}
	.crumb-back:hover {
		color: var(--tx-hi);
	}
	.results {
		padding: var(--s-3) var(--s-4) var(--s-4);
		max-height: min(420px, 52dvh);
	}
	.console.is-page .results {
		max-height: none;
		overflow: visible;
		padding: var(--s-3) 0 var(--s-4);
	}
	.group-lbl {
		font-size: var(--t-xs);
		color: var(--tx-dim);
		padding: var(--s-2) 8px 4px;
	}
	.row {
		display: flex;
		align-items: baseline;
		gap: var(--s-3);
		width: 100%;
		text-align: left;
		padding: 8px 10px;
		border: 0;
		border-radius: var(--r-1);
		background: transparent;
		color: var(--tx);
		font: inherit;
		cursor: pointer;
	}
	.console.is-page .row {
		min-height: 36px;
	}
	.row[data-selected='true'] {
		background: var(--s4);
		color: var(--tx-hi);
	}
	.row-title {
		flex: none;
		max-width: 58%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.row-hint {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--t-xs);
		color: var(--tx-dim);
	}
	.row-agent {
		flex: none;
		align-self: center;
		color: var(--em-400);
	}
	.row-keys {
		flex: none;
		align-self: center;
		display: inline-flex;
		gap: 3px;
	}
	.row-keys .kbd {
		font-family: var(--font);
	}
	.empty-row {
		padding: var(--s-5);
		color: var(--tx-dim);
		font-size: var(--t-sm);
	}
	.spacer {
		flex: 1;
	}
	@media (max-width: 640px) {
		.console.is-page .row {
			min-height: 44px;
		}
	}
</style>
