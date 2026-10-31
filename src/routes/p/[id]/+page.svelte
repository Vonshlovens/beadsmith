<script lang="ts">
	/**
	 * Project issues: parade (grouped rows + reading pane, the default), list
	 * (specs/02) or board. 38px list rows, the status badge is the control,
	 * and only three things may be red: a blocked badge, a P0 chip, and the
	 * selected row's left edge.
	 */
	import { untrack } from 'svelte';
	import { browser } from '$app/environment';
	import { goto, invalidateAll, replaceState, beforeNavigate } from '$app/navigation';
	import { navigating, page } from '$app/state';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import CircleDotIcon from '@lucide/svelte/icons/circle-dot';
	import Columns3Icon from '@lucide/svelte/icons/columns-3';
	import KanbanIcon from '@lucide/svelte/icons/kanban';
	import ListIcon from '@lucide/svelte/icons/list';
	import PanelRightIcon from '@lucide/svelte/icons/panel-right';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import SearchIcon from '@lucide/svelte/icons/search';
	import ShapesIcon from '@lucide/svelte/icons/shapes';
	import SignalHighIcon from '@lucide/svelte/icons/signal-high';
	import XIcon from '@lucide/svelte/icons/x';
	import EmptyState from '$lib/components/empty-state.svelte';
	import FileIssueDialog from '$lib/components/file-issue-dialog.svelte';
	import IssuesBoard from '$lib/components/issues-board.svelte';
	import IssuesDataTable from '$lib/components/issues-data-table/issues-data-table.svelte';
	import IssuesParade from '$lib/components/issues-parade.svelte';
	import PriorityChip from '$lib/components/priority-chip.svelte';
	import SkeletonRows from '$lib/components/skeleton-rows.svelte';
	import {
		clampWidth,
		columnsForWidth,
		COLUMN_IDS,
		COLUMN_LABELS,
		DEFAULT_VISIBLE,
		hiddenByWidth,
		parseVisible,
		parseWidths,
		REQUIRED_COLUMNS,
		resolveWidths,
		serializeVisible,
		serializeWidths,
		stickyLeft,
		tableMinWidth,
		toggleVisible
	} from '$lib/client/columns.js';
	import type { ColumnId } from '$lib/client/columns.js';
	import { boardColumnCreateEnabled } from '$lib/client/board';
	import { statusKey, type StatusKey } from '$lib/client/format';
	import {
		getIssueList,
		issueListCacheKey,
		peekFreshIssueList,
		readListFilters,
		rememberIssueList,
		subscribeIssueListCache
	} from '$lib/client/issue-list-cache.js';
	import { describeIssueListVacancy } from '$lib/client/issue-list-state';
	import { rememberHintIfListed } from '$lib/client/issue-summary-hint.js';
	import {
		DEFAULT_ISSUE_VIEW,
		hasExplicitIssueView,
		ISSUE_VIEWS,
		issueViewStorageKey,
		parseIssueView,
		parseStoredIssueView,
		projectIssuesHref,
		resolveIssueView,
		type IssueView
	} from '$lib/client/issue-view';
	import { useHotkeys } from '$lib/client/hotkeys.svelte';
	import { currentProject, statusSnapshot } from '$lib/client/projects.svelte';
	import { UNSORTED } from '$lib/client/sort';
	import type { SortColumn, SortState } from '$lib/client/sort';
	import { PRODUCT_NAME } from '$lib/product';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/** Bumps when a background list refresh lands so rows replace without a new load. */
	let cache_generation = $state(0);

	$effect(() => {
		if (!browser) {
			return;
		}
		return subscribeIssueListCache(() => {
			cache_generation += 1;
		});
	});

	// Seed the client map after SSR/hydration. Load already remembers on a
	// browser miss; do not overwrite a newer background refresh.
	$effect(() => {
		if (!browser || data.error) {
			return;
		}
		const key = issueListCacheKey(data.project_id, data.filters);
		if (getIssueList(key) === undefined) {
			rememberIssueList(key, {
				project_id: data.project_id,
				issues: data.issues,
				source: data.source,
				readonly: data.readonly,
				error: data.error
			});
		}
	});

	const list_key = $derived(issueListCacheKey(data.project_id, data.filters));
	const cached_list = $derived.by(() => {
		cache_generation;
		return getIssueList(list_key);
	});
	const issues = $derived(cached_list?.issues ?? data.issues);

	beforeNavigate(({ to }) => {
		if (!to) {
			return;
		}
		rememberHintIfListed(to.url.pathname, data.project_id, issues);
	});

	const STATUS_OPTIONS = [
		'open',
		'in_progress',
		'blocked',
		'deferred',
		'closed',
		'pinned',
		'hooked'
	];
	const TYPE_OPTIONS = ['bug', 'feature', 'task', 'epic', 'chore'];
	const PRIORITY_OPTIONS = [0, 1, 2, 3, 4];

	/** Labels for the sortable headers, and the caption they explain. */
	const SORT_LABELS: Record<SortColumn, string> = {
		status: 'status',
		id: 'id',
		title: 'title',
		type: 'type',
		priority: 'priority',
		assignee: 'assignee',
		labels: 'labels',
		deps: 'dependencies',
		updated: 'updated'
	};

	const COLUMNS_KEY = 'bdui:issue-columns';
	const WIDTHS_KEY = 'bdui:issue-column-widths';

	/** How far one arrow key nudges a column edge, and the Shift-held stride. */
	const KEY_STEP = 8;
	const KEY_STEP_FAST = 16;

	let query = $state('');
	let sort = $state<SortState>(UNSORTED);

	/** Which columns the reader has asked for, before the viewport has its say. */
	let visible_columns = $state<Set<ColumnId>>(new Set(DEFAULT_VISIBLE));
	/** Widths the reader has dragged; anything absent falls back to the default. */
	let width_overrides = $state<Partial<Record<ColumnId, number>>>({});
	/** Window width, which decides the phone column set and whether identity pins. */
	let viewport = $state(0);
	/** The list scrollport, so back navigation can restore both axes. */
	let scroll_el = $state<HTMLDivElement | null>(null);
	/** Captured frame scroll, applied once the rows have painted. */
	let restore_scroll = $state<{ top: number; left: number } | null>(null);
	/** The column being dragged right now, or null. */
	let resizing_column = $state<ColumnId | null>(null);

	export const snapshot = {
		capture: () => ({
			top: scroll_el?.scrollTop ?? 0,
			left: scroll_el?.scrollLeft ?? 0
		}),
		restore: (value: { top: number; left: number } | undefined) => {
			restore_scroll = value ?? null;
		}
	};

	/**
	 * Same-route loads (filters, project switch) keep the current rows only when
	 * the destination list is already cached. A different project always
	 * skeletons so we never paint the wrong project's issues.
	 */
	const loading = $derived.by(() => {
		const dest = navigating.to;
		if (dest?.route.id !== page.route.id) {
			return false;
		}
		const dest_id = dest.params?.id;
		if (dest_id && dest_id !== data.project_id) {
			return true;
		}
		const dest_key = issueListCacheKey(
			dest_id ?? data.project_id,
			readListFilters(dest.url.searchParams)
		);
		if (dest_key === list_key) {
			return false;
		}
		return peekFreshIssueList(dest_key) === undefined;
	});
	const dispatch_enabled = $derived(statusSnapshot()?.dispatch.enabled === true);
	let file_open = $state(false);
	let file_initial_status = $state<StatusKey | undefined>(undefined);

	// Keep the free-text box in step with whatever the URL says.
	$effect(() => {
		query = data.filters.q;
	});

	// Read the stored layout once, on the client only. `untrack` because this
	// effect writes the very state it reads, and it must not run again every
	// time a column is toggled — the same trap +layout.svelte handles.
	$effect(() => {
		if (!browser) {
			return;
		}
		untrack(() => {
			try {
				visible_columns = parseVisible(window.localStorage.getItem(COLUMNS_KEY));
				width_overrides = parseWidths(window.localStorage.getItem(WIDTHS_KEY));
			} catch {
				/* private mode or storage disabled — keep the defaults */
			}
		});
	});

	const project = $derived(currentProject());
	const file_enabled = $derived(dispatch_enabled && project?.allow?.file !== false);
	const board_can_create = $derived(boardColumnCreateEnabled(file_enabled));

	/**
	 * Open File, optionally bound to a board column status.
	 *
	 * @param status - Column the operator clicked, or omit for the header File button.
	 */
	function openFile(status?: StatusKey) {
		file_initial_status = status;
		file_open = true;
	}

	/**
	 * Stored list/board choice for this project. Null until the client reads
	 * localStorage so SSR and the first client paint stay on the URL.
	 */
	let remembered_view = $state<IssueView | null>(null);

	const view = $derived(resolveIssueView(page.url.searchParams, remembered_view));
	const is_board = $derived(view === 'board');

	const VIEW_LABELS: Record<IssueView, string> = { parade: 'Parade', list: 'List', board: 'Board' };
	const VIEW_HINTS: Record<IssueView, string> = {
		parade: 'Rows grouped by status beside a reading pane',
		list: 'Sortable table',
		board: 'Columns by status'
	};
	const VIEW_ICONS = { parade: PanelRightIcon, list: ListIcon, board: KanbanIcon } as const;

	useHotkeys(() => [
		...ISSUE_VIEWS.map((option, index) => ({
			keys: [String(index + 1)],
			label: `${VIEW_LABELS[option]} view`,
			group: 'Lists' as const,
			run: () => void applyFilters({ view: option })
		})),
		{
			keys: ['n'],
			label: 'File a new issue',
			group: 'Agent' as const,
			when: () => file_enabled,
			run: () => openFile()
		},
		{
			keys: ['x'],
			label: 'Show or hide closed issues',
			group: 'Lists' as const,
			run: () => void applyFilters({ include_closed: data.filters.include_closed ? '' : '1' })
		}
	]);

	// Restore the last view when the URL omits `view` (project cards, switcher).
	// Explicit `?view=` always wins for that navigation, and is what we store.
	// replaceState avoids a same-route goto that would flash the list skeleton.
	$effect(() => {
		if (!browser) {
			return;
		}
		const project_id = data.project_id;
		const search = page.url.search;
		untrack(() => {
			const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
			let stored: string | null = null;
			try {
				stored = window.localStorage.getItem(issueViewStorageKey(project_id));
			} catch {
				stored = null;
			}
			const remembered = parseStoredIssueView(stored);
			remembered_view = remembered;
			if (hasExplicitIssueView(params)) {
				try {
					window.localStorage.setItem(
						issueViewStorageKey(project_id),
						parseIssueView(params.get('view'))
					);
				} catch {
					/* preference is best-effort */
				}
				return;
			}
			if (remembered !== null && remembered !== DEFAULT_ISSUE_VIEW) {
				replaceState(projectIssuesHref(project_id, remembered, params), {});
			}
		});
	});

	// Server-side filtering is best-effort; re-apply everything here so the
	// visible count and the filter chips always agree.
	const visible = $derived.by(() => {
		const { status, type, priority, q, include_closed } = data.filters;
		const needle = q.trim().toLowerCase();

		return issues.filter((issue) => {
			const key = statusKey(issue.status);
			if (status.length > 0 && !status.includes(key)) {
				return false;
			}
			if (status.length === 0 && !include_closed && key === 'closed') {
				return false;
			}
			if (type.length > 0 && !type.includes((issue.issue_type ?? '').toLowerCase())) {
				return false;
			}
			if (priority.length > 0 && !priority.includes(issue.priority)) {
				return false;
			}
			if (needle) {
				const haystack = `${issue.id} ${issue.title} ${issue.labels.join(' ')}`.toLowerCase();
				if (!haystack.includes(needle)) {
					return false;
				}
			}
			return true;
		});
	});

	/**
	 * What actually reaches the DOM: the requested set minus whatever the
	 * viewport is too narrow to carry. A column dropped here stays checked in the
	 * menu — the reader asked for it, the window is the one saying no.
	 */
	const painted = $derived(columnsForWidth(visible_columns, viewport));

	/** Resolved widths. The title takes the slack; nothing is shrunk to fit. */
	const widths = $derived(resolveWidths(width_overrides));

	/** Minimum table width: painted fixed columns plus the title floor. */
	const table_min_width = $derived(tableMinWidth(widths, painted, viewport));

	/** Left offsets for Status and Id, or null on a phone. */
	const pin_left = $derived(stickyLeft(painted, widths, viewport));

	/** True once the chosen columns differ from the shipped default. */
	const columns_customized = $derived(
		visible_columns.size !== DEFAULT_VISIBLE.length ||
			DEFAULT_VISIBLE.some((column) => !visible_columns.has(column))
	);

	/**
	 * The width one column is currently painted at. Title has no configured
	 * width — it absorbs whatever the others leave — so it reports zero.
	 *
	 * @param column - The column being measured.
	 */
	function columnWidth(column: ColumnId): number {
		if (column === 'title') {
			return 0;
		}
		return widths[column];
	}

	/**
	 * Persist a preference. Best-effort in the same sense as the rail width: a
	 * blocked write leaves the layout on screen, it simply will not survive a
	 * reload.
	 *
	 * @param key - localStorage key to write.
	 * @param value - Serialized preference.
	 */
	function persist(key: string, value: string) {
		if (!browser) {
			return;
		}
		try {
			window.localStorage.setItem(key, value);
		} catch {
			/* preference is best-effort */
		}
	}

	/**
	 * Show or hide one column and remember the choice.
	 *
	 * @param column - The column whose checkbox was clicked.
	 */
	function toggleColumn(column: ColumnId) {
		visible_columns = toggleVisible(visible_columns, column);
		persist(COLUMNS_KEY, serializeVisible(visible_columns));
	}

	/** Return both the column set and every width to the shipped default. */
	function resetColumns() {
		visible_columns = new Set(DEFAULT_VISIBLE);
		width_overrides = {};
		persist(COLUMNS_KEY, serializeVisible(visible_columns));
		persist(WIDTHS_KEY, serializeWidths(width_overrides));
	}

	/**
	 * Give one column a new width. Widening it widens the table.
	 *
	 * @param column - The column being sized.
	 * @param desired - The width the gesture asked for, before clamping.
	 */
	function setColumnWidth(column: ColumnId, desired: number) {
		const next = clampWidth(desired);
		width_overrides = { ...width_overrides, [column]: next };
	}

	/**
	 * Forget one column's override so it returns to its default width.
	 *
	 * @param column - The column being reset.
	 */
	function resetColumnWidth(column: ColumnId) {
		const next = { ...width_overrides };
		delete next[column];
		width_overrides = next;
		persist(WIDTHS_KEY, serializeWidths(width_overrides));
	}

	/** What a drag needs to remember between pointerdown and pointerup. */
	let drag: { column: ColumnId; start_x: number; start_width: number } | null = null;

	/**
	 * Begin a resize. Capturing the pointer means the rest of the gesture is
	 * delivered to the grip even when it runs off the header, so no document
	 * listeners are needed and nothing leaks if the row scrolls away.
	 *
	 * @param event - The pointerdown that started the drag.
	 * @param column - The column the grip belongs to.
	 */
	function startResize(event: PointerEvent, column: ColumnId) {
		// The grip is a sibling of the header's sort button, not a child, but it
		// still shares the header's click target; without this a drag would also
		// reorder the table.
		event.preventDefault();
		event.stopPropagation();
		const grip = event.currentTarget as HTMLElement;
		grip.setPointerCapture(event.pointerId);
		grip.focus();
		drag = { column, start_x: event.clientX, start_width: columnWidth(column) };
		resizing_column = column;
	}

	/**
	 * Track the pointer while a grip is held.
	 *
	 * @param event - The pointermove being followed.
	 */
	function moveResize(event: PointerEvent) {
		if (!drag) {
			return;
		}
		setColumnWidth(drag.column, drag.start_width + (event.clientX - drag.start_x));
	}

	/**
	 * End a resize and write the result down.
	 *
	 * @param event - The pointerup or pointercancel that ended the drag.
	 */
	function endResize(event: PointerEvent) {
		if (!drag) {
			return;
		}
		const grip = event.currentTarget as HTMLElement;
		if (grip.hasPointerCapture(event.pointerId)) {
			grip.releasePointerCapture(event.pointerId);
		}
		drag = null;
		resizing_column = null;
		persist(WIDTHS_KEY, serializeWidths(width_overrides));
	}

	/**
	 * Keyboard resizing: arrows nudge the edge, Shift takes a bigger stride, and
	 * Home puts the column back where it started.
	 *
	 * @param event - The keydown on the grip.
	 * @param column - The column the grip belongs to.
	 */
	function onGripKeydown(event: KeyboardEvent, column: ColumnId) {
		if (event.key === 'Home') {
			event.preventDefault();
			resetColumnWidth(column);
			return;
		}
		if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
			return;
		}
		event.preventDefault();
		const step = event.shiftKey ? KEY_STEP_FAST : KEY_STEP;
		const delta = event.key === 'ArrowLeft' ? -step : step;
		setColumnWidth(column, columnWidth(column) + delta);
		persist(WIDTHS_KEY, serializeWidths(width_overrides));
	}

	// A drag usually wanders off the header, and a cursor that flickers back to
	// the row's pointer mid-gesture reads as a dropped drag. Hold col-resize on
	// the whole document until the pointer comes up.
	$effect(() => {
		if (!browser) {
			return;
		}
		document.body.classList.toggle('is-resizing-col', resizing_column !== null);
		return () => document.body.classList.remove('is-resizing-col');
	});

	// The window no longer scrolls on a desktop list, so SvelteKit's window
	// restore cannot put the reader back in the table. Apply the captured
	// offsets once the scrollport and the rows exist.
	$effect(() => {
		const saved = restore_scroll;
		const el = scroll_el;
		visible.length;
		if (!saved || !el || is_board) {
			return;
		}
		restore_scroll = null;
		el.scrollTop = saved.top;
		el.scrollLeft = saved.left;
	});

	const active_filter_count = $derived(
		(data.filters.status.length > 0 ? 1 : 0) +
			(data.filters.type.length > 0 ? 1 : 0) +
			(data.filters.priority.length > 0 ? 1 : 0) +
			(data.filters.q ? 1 : 0)
	);

	const vacancy = $derived(
		describeIssueListVacancy({
			issues_loaded: issues.length,
			visible: visible.length,
			include_closed: data.filters.include_closed,
			has_filters: active_filter_count > 0,
			counts: project?.counts
		})
	);

	/**
	 * Push a filter change into the URL, which re-runs `load`.
	 *
	 * @param changes - Query parameters to set; empty values are removed.
	 */
	async function applyFilters(changes: Record<string, string>) {
		const params = new URLSearchParams(page.url.searchParams);
		for (const [key, value] of Object.entries(changes)) {
			if (value) {
				params.set(key, value);
			} else {
				params.delete(key);
			}
		}
		await goto(`?${params.toString()}`, { keepFocus: true, noScroll: true, replaceState: true });
	}

	/**
	 * Toggle one value inside a comma-separated multi-select parameter.
	 *
	 * @param key - Query parameter name.
	 * @param current - Values currently selected.
	 * @param value - Value being toggled.
	 */
	function toggleValue(key: string, current: (string | number)[], value: string | number) {
		const set = new Set(current.map(String));
		const token = String(value);
		if (set.has(token)) {
			set.delete(token);
		} else {
			set.add(token);
		}
		return applyFilters({ [key]: [...set].join(',') });
	}

	/** Clear every filter but keep the project. */
	function clearFilters() {
		return applyFilters({ status: '', type: '', priority: '', q: '', include_closed: '' });
	}
</script>

<svelte:head>
	<title>{project?.name ?? 'Issues'} · {VIEW_LABELS[view]} · {PRODUCT_NAME}</title>
</svelte:head>

<svelte:window bind:innerWidth={viewport} />

<div class="wrap is-wide" class:is-grid={!is_board}>
	<div class="filters" role="toolbar" aria-label="Filter issues">
		<h1 class="proj" title={project?.dolt_database}>{project?.name ?? 'Issues'}</h1>
		<span class="meta" aria-live="polite">
			{visible.length === issues.length ? issues.length : `${visible.length}/${issues.length}`}
		</span>
		<div class="view-seg" role="radiogroup" aria-label="Issue view">
			{#each ISSUE_VIEWS as option, index (option)}
				{@const Icon = VIEW_ICONS[option]}
				<button
					class="view-opt"
					class:is-on={view === option}
					type="button"
					role="radio"
					aria-checked={view === option}
					aria-label={VIEW_LABELS[option]}
					aria-keyshortcuts={String(index + 1)}
					title="{VIEW_LABELS[option]}: {VIEW_HINTS[option]} ({index + 1})"
					onclick={() => applyFilters({ view: option })}
				>
					<Icon size={14} strokeWidth={1.4} aria-hidden="true" />
					<span class="view-tx">{VIEW_LABELS[option]}</span>
				</button>
			{/each}
		</div>

		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<button
						{...props}
						class="filt {data.filters.status.length > 0 ? 'is-on' : 'is-off'}"
						type="button"
						aria-label="Status filter: {data.filters.status.length > 0
							? data.filters.status.map((s) => s.replace('_', ' ')).join(', ')
							: 'any'}"
						title="Status"
					>
						<CircleDotIcon size={13} strokeWidth={1.4} aria-hidden="true" />
						{#if data.filters.status.length > 0}
							<span class="v">
								{#each data.filters.status as option (option)}<i
										class="dot dot-{option}"
										aria-hidden="true"
									></i>{/each}
								{data.filters.status.length === 1 ? data.filters.status[0]?.replace('_', ' ') : ''}
							</span>
						{/if}
						<span class="caret" aria-hidden="true">▾</span>
					</button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content class="ui-menu ui-menu-narrow" align="start" sideOffset={6}>
				{#each STATUS_OPTIONS as option (option)}
					<DropdownMenu.CheckboxItem
						class="ui-menu-item"
						closeOnSelect={false}
						checked={data.filters.status.includes(option)}
						onCheckedChange={() => toggleValue('status', data.filters.status, option)}
					>
						<i class="dot dot-{option}" aria-hidden="true"></i>{option.replace('_', ' ')}
					</DropdownMenu.CheckboxItem>
				{/each}
			</DropdownMenu.Content>
		</DropdownMenu.Root>

		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<button
						{...props}
						class="filt {data.filters.type.length > 0 ? 'is-on' : 'is-off'}"
						type="button"
						aria-label="Type filter: {data.filters.type.length > 0
							? data.filters.type.join(', ')
							: 'any'}"
						title="Type"
					>
						<ShapesIcon size={13} strokeWidth={1.4} aria-hidden="true" />
						{#if data.filters.type.length > 0}
							<span class="v">{data.filters.type.join(' · ')}</span>
						{/if}
						<span class="caret" aria-hidden="true">▾</span>
					</button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content class="ui-menu ui-menu-narrow" align="start" sideOffset={6}>
				{#each TYPE_OPTIONS as option (option)}
					<DropdownMenu.CheckboxItem
						class="ui-menu-item"
						closeOnSelect={false}
						checked={data.filters.type.includes(option)}
						onCheckedChange={() => toggleValue('type', data.filters.type, option)}
					>
						{option}
					</DropdownMenu.CheckboxItem>
				{/each}
			</DropdownMenu.Content>
		</DropdownMenu.Root>

		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<button
						{...props}
						class="filt {data.filters.priority.length > 0 ? 'is-on' : 'is-off'}"
						type="button"
						aria-label="Priority filter: {data.filters.priority.length > 0
							? data.filters.priority.map((p) => `P${p}`).join(', ')
							: 'any'}"
						title="Priority"
					>
						<SignalHighIcon size={13} strokeWidth={1.4} aria-hidden="true" />
						{#if data.filters.priority.length > 0}
							<span class="v">{data.filters.priority.map((p) => `P${p}`).join(' ')}</span>
						{/if}
						<span class="caret" aria-hidden="true">▾</span>
					</button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content class="ui-menu ui-menu-narrow" align="start" sideOffset={6}>
				{#each PRIORITY_OPTIONS as option (option)}
					<DropdownMenu.CheckboxItem
						class="ui-menu-item"
						closeOnSelect={false}
						checked={data.filters.priority.includes(option)}
						onCheckedChange={() => toggleValue('priority', data.filters.priority, option)}
					>
						<PriorityChip priority={option} />
					</DropdownMenu.CheckboxItem>
				{/each}
			</DropdownMenu.Content>
		</DropdownMenu.Root>

		<button
			class="filt {data.filters.include_closed ? 'is-on' : 'is-off'}"
			type="button"
			aria-pressed={data.filters.include_closed}
			aria-label="Include closed issues"
			title={data.filters.include_closed ? 'Closed issues shown (x)' : 'Closed issues hidden (x)'}
			onclick={() => applyFilters({ include_closed: data.filters.include_closed ? '' : '1' })}
		>
			<ArchiveIcon size={13} strokeWidth={1.4} aria-hidden="true" />
		</button>

		<form
			class="search filt-search"
			onsubmit={(event) => {
				event.preventDefault();
				void applyFilters({ q: query.trim() });
			}}
		>
			<SearchIcon size={13} strokeWidth={1.4} aria-hidden="true" />
			<input
				type="search"
				placeholder="Filter"
				aria-label="Filter issues by title, id or label"
				data-hotkey="search"
				bind:value={query}
			/>
		</form>

		{#if view === 'list'}
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<button
							{...props}
							class="filt {columns_customized ? 'is-on' : 'is-off'}"
							type="button"
							aria-label="Columns: {visible_columns.size} of {COLUMN_IDS.length}"
							title="Columns"
						>
							<Columns3Icon size={13} strokeWidth={1.4} aria-hidden="true" />
							{#if visible_columns.size !== COLUMN_IDS.length}
								<span class="v">{visible_columns.size}/{COLUMN_IDS.length}</span>
							{/if}
							<span class="caret" aria-hidden="true">▾</span>
						</button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content class="ui-menu ui-menu-narrow" align="start" sideOffset={6}>
					<!-- GroupHeading reads the Group context with .get(), which throws when
					     there is no Group ancestor, so the whole menu fails to render. -->
					<DropdownMenu.Group>
						<DropdownMenu.GroupHeading class="ui-menu-heading">Columns</DropdownMenu.GroupHeading>
						{#each COLUMN_IDS as column (column)}
							<DropdownMenu.CheckboxItem
								class="ui-menu-item"
								closeOnSelect={false}
								disabled={REQUIRED_COLUMNS.has(column)}
								checked={REQUIRED_COLUMNS.has(column) || visible_columns.has(column)}
								onCheckedChange={() => toggleColumn(column)}
							>
								{COLUMN_LABELS[column]}
								{#if visible_columns.has(column) && hiddenByWidth(column, viewport)}
									<!-- A checked column that never appears looks broken; say why. -->
									<span class="hint">narrow</span>
								{/if}
							</DropdownMenu.CheckboxItem>
						{/each}
					</DropdownMenu.Group>
					<DropdownMenu.Separator class="ui-menu-sep" />
					<DropdownMenu.Item class="ui-menu-item" onSelect={resetColumns}>
						<span class="dim">Reset columns</span>
					</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		{/if}

		{#if active_filter_count > 0}
			<button
				class="filt-clear"
				type="button"
				onclick={clearFilters}
				aria-label="Clear {active_filter_count} {active_filter_count === 1 ? 'filter' : 'filters'}"
				title="Clear filters"
			>
				<XIcon size={12} strokeWidth={1.6} aria-hidden="true" />{active_filter_count}
			</button>
		{/if}

		<span class="spacer"></span>
		{#if view === 'list' && sort.column !== null}
			<button
				class="filt-clear"
				type="button"
				onclick={() => (sort = UNSORTED)}
				aria-label="Sorted by {SORT_LABELS[sort.column]}, {sort.direction === 'asc'
					? 'ascending'
					: 'descending'}. Reset sort"
				title="Reset sort"
			>
				{sort.direction === 'asc' ? '↑' : '↓'}
				{SORT_LABELS[sort.column]}
				<XIcon size={12} strokeWidth={1.6} aria-hidden="true" />
			</button>
		{/if}
		{#if file_enabled}
			<button
				class="btn btn-sm btn-primary"
				type="button"
				onclick={() => openFile()}
				aria-keyshortcuts="n"
				title="File a new issue (n)"
			>
				<PlusIcon size={14} strokeWidth={1.6} aria-hidden="true" /><span class="file-tx">File</span>
			</button>
		{/if}
	</div>

	{#if data.error}
		<div class="banner banner-err" role="alert">
			<i class="dot dot-blocked" style="margin-top:5px" aria-hidden="true"></i>
			<div class="banner-bd">
				<b>The issue list could not be loaded.</b>
				<div class="mt-2">{data.error}</div>
			</div>
			<div class="banner-acts">
				<button class="btn btn-sm" type="button" onclick={() => invalidateAll()}>Retry now</button>
			</div>
		</div>
	{:else if loading}
		<SkeletonRows rows={8} label="Loading issues" />
	{:else if vacancy?.kind === 'partial'}
		<div class="banner banner-err" role="alert">
			<i class="dot dot-blocked" style="margin-top:5px" aria-hidden="true"></i>
			<div class="banner-bd">
				<b>{vacancy.title}</b>
				<div class="mt-2">{vacancy.description}</div>
			</div>
			<div class="banner-acts">
				<button class="btn btn-sm" type="button" onclick={() => invalidateAll()}>Retry now</button>
			</div>
		</div>
	{:else if vacancy}
		<EmptyState title={vacancy.title} description={vacancy.description}>
			{#snippet actions()}
				{#if vacancy.action === 'clear_filters'}
					<button class="btn btn-sm" type="button" onclick={clearFilters}>Clear filters</button>
				{:else if vacancy.action === 'include_closed'}
					<button
						class="btn btn-sm"
						type="button"
						onclick={() => applyFilters({ include_closed: '1' })}>Include closed issues</button
					>
				{/if}
			{/snippet}
		</EmptyState>
	{:else if view === 'parade'}
		<IssuesParade
			issues={visible}
			project_id={data.project_id}
			tackle_enabled={dispatch_enabled && project?.allow?.tackle !== false}
		/>
	{:else if is_board}
		<IssuesBoard
			issues={visible}
			project_id={data.project_id}
			status_filter={data.filters.status}
			include_closed={data.filters.include_closed}
			{dispatch_enabled}
			tackle_enabled={dispatch_enabled && project?.allow?.tackle !== false}
			can_create={board_can_create}
			oncreate={openFile}
		/>
	{:else}
		<IssuesDataTable
			issues={visible}
			project_id={data.project_id}
			project_name={project?.name ?? 'this project'}
			total_count={issues.length}
			{painted}
			{resizing_column}
			bind:sort
			{table_min_width}
			{pin_left}
			bind:scroll_el
			{columnWidth}
			onStartResize={startResize}
			onMoveResize={moveResize}
			onEndResize={endResize}
			{onGripKeydown}
			onResetColumnWidth={resetColumnWidth}
		/>
	{/if}
</div>

{#if file_enabled}
	<FileIssueDialog
		project_id={data.project_id}
		bind:open={file_open}
		initial_status={file_initial_status}
	/>
{/if}

<style>
	.filters {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-2);
		align-items: center;
		padding: 0 0 var(--s-3);
	}
	.proj {
		font-size: var(--t-lg);
		font-weight: 650;
		letter-spacing: -0.01em;
		color: var(--tx-hi);
		margin: 0 0 0 2px;
	}
	.meta {
		font-size: var(--t-sm);
		color: var(--tx-dim);
		font-variant-numeric: tabular-nums;
		margin-right: var(--s-2);
	}
	.view-seg {
		display: inline-flex;
		height: 30px;
		border: 1px solid var(--line-2);
		border-radius: var(--r-1);
		overflow: hidden;
		background: var(--bg);
	}
	.view-opt {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 0 11px;
		border: 0;
		border-right: 1px solid var(--line-2);
		background: transparent;
		color: var(--tx-mid);
		font-size: var(--t-sm);
		cursor: pointer;
	}
	.view-opt:last-child {
		border-right: 0;
	}
	.view-opt:hover:not(.is-on) {
		background: var(--s3);
		color: var(--tx-hi);
	}
	/* The chosen view is set in ink, like the website's code blocks. */
	.view-opt.is-on {
		background: var(--tx-hi);
		color: var(--bg);
		font-weight: 600;
	}
	.filt {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 30px;
		min-width: 30px;
		justify-content: center;
		padding: 0 8px;
		background: var(--bg);
		border: 1px solid var(--line-2);
		border-radius: var(--r-1);
		font-size: var(--t-sm);
		cursor: pointer;
		white-space: nowrap;
	}
	.filt:hover {
		border-color: var(--line-3);
		background: var(--s2);
	}
	.filt .v {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		color: var(--tx-hi);
	}
	.filt :global(svg) {
		color: var(--tx-mid);
		flex: none;
	}
	.filt.is-on :global(svg) {
		color: var(--em-300);
	}
	.filt-search {
		flex: 0 1 240px;
		height: 30px;
		min-width: 110px;
		max-width: 260px;
	}
	.filt .caret {
		font-size: 10px;
		color: var(--tx-dim);
	}
	.filt.is-on {
		border-color: var(--em-700);
		background: var(--em-wash);
	}
	.filt.is-on .v {
		color: var(--em-300);
	}
	.filt.is-off .v {
		color: var(--tx-dim);
	}
	.filt-clear {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		height: 30px;
		background: none;
		border: 0;
		color: var(--tx-mid);
		font-size: var(--t-sm);
		cursor: pointer;
		padding: 0 4px;
	}
	@media (max-width: 1100px) {
		.view-tx {
			display: none;
		}
	}
	@media (max-width: 640px) {
		.file-tx {
			display: none;
		}
		.filt-search {
			flex: 1 1 120px;
			max-width: none;
		}
	}
	.filt-clear:hover {
		color: var(--em-400);
	}

	/* The menu's "this is checked but the window is too narrow" aside. */
	.hint {
		margin-left: auto;
		font-size: var(--t-xs);
		color: var(--tx-dim);
	}

	/*
	 * A drag wanders off the header, and rows set their own cursor. Overriding
	 * both for the length of the gesture keeps the pointer from flickering back
	 * to a hand, which reads as a dropped drag.
	 */
	:global(body.is-resizing-col),
	:global(body.is-resizing-col *) {
		cursor: col-resize !important;
		user-select: none;
	}
</style>
