<script lang="ts">
	/**
	 * Horizontal status board for the already-filtered issue set. Columns are
	 * keyed by status; cards navigate to issue detail. Collapse is local
	 * presentation and column create is File dispatch. Dragging a card onto another column, or choosing Send to
	 * agent from the keyboard, opens a confirm modal to dispatch an agent; the
	 * card stays put until Beads changes.
	 */
	import { tick, untrack } from 'svelte';
	import { browser } from '$app/environment';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import BoardCard from '$lib/components/board-card.svelte';
	import BoardDispatchDialog from '$lib/components/board-dispatch-dialog.svelte';
	import { boardCreateHeading, groupBoardColumns } from '$lib/client/board';
	import { boardDropIntent, type BoardDispatchPending } from '$lib/client/board-dispatch';
	import {
		boardColumnAccessibleName,
		isBoardNavKey,
		moveBoardFocus,
		VIM_BOARD_KEYS,
		type BoardNavTarget
	} from '$lib/client/board-keyboard';
	import { agentAvailability } from '$lib/client/agent';
	import { useHotkeys } from '$lib/client/hotkeys.svelte';
	import { currentProject, statusSnapshot } from '$lib/client/projects.svelte';
	import { app_state } from '$lib/client/stores.svelte';
	import {
		boardCollapsedStorageKey,
		expandCollapsedColumn,
		parseCollapsed,
		serializeCollapsed,
		toggleCollapsed
	} from '$lib/client/board-prefs';
	import { statusKey, type StatusKey } from '$lib/client/format';
	import type { IssueSummary } from '$lib/types';

	interface Props {
		issues: IssueSummary[];
		project_id: string;
		status_filter: string[];
		include_closed: boolean;
		dispatch_enabled?: boolean;
		tackle_enabled?: boolean;
		can_create?: boolean;
		oncreate?: (status: StatusKey) => void;
	}

	let {
		issues,
		project_id,
		status_filter,
		include_closed,
		dispatch_enabled = false,
		tackle_enabled = false,
		can_create = false,
		oncreate
	}: Props = $props();

	const columns = $derived(groupBoardColumns(issues, { status_filter, include_closed }));
	const nav_columns = $derived(
		columns.map((column) => ({
			status: column.status,
			issue_ids: column.issues.map((issue) => issue.id),
			collapsed: collapsed.has(column.status)
		}))
	);

	/** Statuses whose cards are hidden; header + count stay visible. */
	let collapsed = $state<Set<StatusKey>>(new Set());
	let board_el = $state<HTMLElement | null>(null);
	let dragging = $state<{ issue_id: string; source_status: StatusKey } | null>(null);
	let drop_status = $state<StatusKey | null>(null);
	let suppress_click = $state(false);
	let pending = $state<BoardDispatchPending | null>(null);
	let press = $state<{
		pointer_id: number;
		x: number;
		y: number;
		issue: IssueSummary;
	} | null>(null);

	const DRAG_THRESHOLD_PX = 6;

	$effect(() => {
		const id = project_id;
		if (!browser) {
			return;
		}
		untrack(() => {
			try {
				collapsed = parseCollapsed(window.localStorage.getItem(boardCollapsedStorageKey(id)));
			} catch {
				collapsed = new Set();
			}
		});
	});

	/**
	 * Persist a collapsed set. Best-effort: a blocked write leaves the
	 * presentation on screen, it simply will not survive a reload.
	 *
	 * @param next - Statuses that should stay collapsed.
	 */
	function persistCollapsed(next: Set<StatusKey>) {
		collapsed = next;
		if (!browser) {
			return;
		}
		try {
			window.localStorage.setItem(boardCollapsedStorageKey(project_id), serializeCollapsed(next));
		} catch {
			/* preference is best-effort */
		}
	}

	/**
	 * Collapse or expand one column from the header control.
	 *
	 * @param status - Column being toggled.
	 */
	function toggleColumn(status: StatusKey) {
		persistCollapsed(toggleCollapsed(collapsed, status));
	}

	function findIssue(issue_id: string): IssueSummary | undefined {
		return issues.find((issue) => issue.id === issue_id);
	}

	function requestDispatch(issue: IssueSummary, destination: StatusKey) {
		const source = statusKey(issue.status);
		const intent = boardDropIntent(source, destination);
		if (intent.kind !== 'dispatch') {
			return;
		}
		pending = {
			issue,
			source_status: source,
			action: intent.action
		};
	}

	function currentNavTarget(node: EventTarget | null): BoardNavTarget | null {
		if (!(node instanceof Element)) {
			return null;
		}
		const card = node.closest('[data-board-card-id]');
		if (card instanceof HTMLElement) {
			const issue_id = card.getAttribute('data-board-card-id');
			const raw_status = card.getAttribute('data-board-status');
			if (issue_id && raw_status) {
				return { kind: 'card', status: statusKey(raw_status), issue_id };
			}
		}
		const toggle = node.closest('[data-board-col-toggle]');
		if (toggle instanceof HTMLElement) {
			const raw_status = toggle.getAttribute('data-board-col-toggle');
			if (raw_status) {
				return { kind: 'column', status: statusKey(raw_status) };
			}
		}
		return null;
	}

	function focusNavTarget(target: BoardNavTarget) {
		if (!browser || board_el === null) {
			return;
		}
		if (target.kind === 'card') {
			const card = board_el.querySelector(
				`[data-board-card-id="${CSS.escape(target.issue_id)}"] a.board-card`
			);
			if (card instanceof HTMLElement) {
				card.focus();
				card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
			}
			return;
		}
		const header = board_el.querySelector(`[data-board-col-toggle="${CSS.escape(target.status)}"]`);
		if (header instanceof HTMLElement) {
			header.focus();
			header.scrollIntoView({ block: 'nearest', inline: 'nearest' });
		}
	}

	async function onBoardKeyDown(event: KeyboardEvent) {
		if (event.altKey || event.ctrlKey || event.metaKey) {
			return;
		}
		const key = VIM_BOARD_KEYS[event.key] ?? event.key;
		if (!isBoardNavKey(key)) {
			return;
		}
		const node = event.target;
		if (!(node instanceof Element)) {
			return;
		}
		if (
			node.closest('[role="menu"]') ||
			node.closest('[role="dialog"]') ||
			node.closest('[data-slot="dropdown-menu-content"]')
		) {
			return;
		}
		const current = currentNavTarget(node);
		if (current === null) {
			return;
		}
		const result = moveBoardFocus(nav_columns, current, key);
		if (result === null) {
			return;
		}
		event.preventDefault();
		if (result.expand) {
			persistCollapsed(expandCollapsedColumn(collapsed, result.expand));
			await tick();
		}
		focusNavTarget(result.target);
	}

	const agent_visible = $derived(
		agentAvailability(statusSnapshot(), currentProject()?.allow).visible
	);

	/** The card that has keyboard focus, if any. */
	function focusedIssue(): IssueSummary | undefined {
		const card = document.activeElement?.closest('[data-board-card-id]');
		const id = card?.getAttribute('data-board-card-id');
		return id ? findIssue(id) : undefined;
	}

	// The board moves focus itself (below); these entries put it in the overlay.
	useHotkeys(() => [
		{
			keys: ['h', 'j', 'k', 'l'],
			label: 'Move between cards (or the arrow keys)',
			group: 'Board',
			display_only: true
		},
		{ keys: ['m'], label: 'Send the focused card to an agent', group: 'Board', display_only: true },
		{
			keys: ['a'],
			label: 'Ask an agent about the focused card',
			group: 'Agent',
			when: () => agent_visible,
			run: () => {
				const issue = focusedIssue();
				if (issue === undefined) {
					return false;
				}
				app_state.openAgent({ project_id, issue_id: issue.id, issue_title: issue.title });
			}
		}
	]);

	$effect(() => {
		if (!browser) {
			return;
		}
		const on_key = (event: KeyboardEvent) => {
			if (board_el === null || !board_el.contains(document.activeElement)) {
				return;
			}
			void onBoardKeyDown(event);
		};
		window.addEventListener('keydown', on_key);
		return () => window.removeEventListener('keydown', on_key);
	});

	function statusFromPoint(client_x: number, client_y: number): StatusKey | undefined {
		if (!browser) {
			return undefined;
		}
		const node = document.elementFromPoint(client_x, client_y);
		if (!(node instanceof Element)) {
			return undefined;
		}
		const column = node.closest('[data-board-status]');
		const raw = column?.getAttribute('data-board-status');
		if (raw === null || raw === undefined) {
			return undefined;
		}
		return statusKey(raw);
	}

	function highlightDestination(source: StatusKey, destination: StatusKey | undefined) {
		if (destination === undefined) {
			drop_status = null;
			return;
		}
		if (collapsed.has(destination)) {
			persistCollapsed(expandCollapsedColumn(collapsed, destination));
		}
		if (boardDropIntent(source, destination).kind === 'dispatch') {
			drop_status = destination;
			return;
		}
		drop_status = null;
	}

	function endPointerDrag() {
		press = null;
		dragging = null;
		drop_status = null;
	}

	function suppressCardClick(event: MouseEvent) {
		if (!suppress_click) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		suppress_click = false;
	}

	function onCardPointerDown(issue: IssueSummary, event: PointerEvent) {
		if (event.button !== 0) {
			return;
		}
		press = {
			pointer_id: event.pointerId,
			x: event.clientX,
			y: event.clientY,
			issue
		};
	}

	function onPointerMove(event: PointerEvent) {
		if (press === null || event.pointerId !== press.pointer_id) {
			return;
		}
		const dx = event.clientX - press.x;
		const dy = event.clientY - press.y;
		if (dragging === null) {
			if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) {
				return;
			}
			dragging = {
				issue_id: press.issue.id,
				source_status: statusKey(press.issue.status)
			};
			suppress_click = true;
		}
		event.preventDefault();
		highlightDestination(dragging.source_status, statusFromPoint(event.clientX, event.clientY));
	}

	function onPointerUp(event: PointerEvent) {
		if (press === null || event.pointerId !== press.pointer_id) {
			return;
		}
		const source = dragging?.source_status ?? statusKey(press.issue.status);
		const issue = findIssue(press.issue.id) ?? press.issue;
		const destination =
			dragging === null ? undefined : statusFromPoint(event.clientX, event.clientY);
		endPointerDrag();
		if (destination === undefined) {
			return;
		}
		const intent = boardDropIntent(source, destination);
		if (intent.kind !== 'dispatch') {
			return;
		}
		pending = {
			issue,
			source_status: source,
			action: intent.action
		};
	}

	function onPointerCancel(event: PointerEvent) {
		if (press === null || event.pointerId !== press.pointer_id) {
			return;
		}
		endPointerDrag();
	}

	$effect(() => {
		if (!browser || press === null) {
			return;
		}
		const move = (event: PointerEvent) => onPointerMove(event);
		const up = (event: PointerEvent) => onPointerUp(event);
		const cancel = (event: PointerEvent) => onPointerCancel(event);
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		window.addEventListener('pointercancel', cancel);
		return () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			window.removeEventListener('pointercancel', cancel);
		};
	});
</script>

<p id="board-kbd-help" class="sr-only">
	Arrow keys move between cards and columns. M or Send to agent opens the same dispatch confirm as
	dropping a card. Enter opens the issue. Status does not change until an agent updates Beads.
</p>
<div
	class="board"
	role="region"
	aria-label="Issue board"
	aria-describedby="board-kbd-help"
	bind:this={board_el}
>
	{#each columns as column (column.status)}
		{@const is_collapsed = collapsed.has(column.status)}
		<section
			class="board-col"
			class:is-collapsed={is_collapsed}
			class:is-drop-target={drop_status === column.status}
			data-board-status={column.status}
			aria-label={boardColumnAccessibleName(column.label, column.issues.length)}
		>
			<header class="board-col-hd">
				<button
					class="board-col-toggle"
					type="button"
					id="board-col-{column.status}"
					data-board-col-toggle={column.status}
					aria-expanded={!is_collapsed}
					aria-controls={is_collapsed ? undefined : `board-col-bd-${column.status}`}
					aria-label="{is_collapsed ? 'Expand' : 'Collapse'} {column.label} column, {column.issues
						.length} {column.issues.length === 1 ? 'issue' : 'issues'}"
					onclick={() => toggleColumn(column.status)}
				>
					<span class="name">
						<i class="dot dot-{column.status}" aria-hidden="true"></i>
						{column.label}
					</span>
					<span class="count mono-num">{column.issues.length}</span>
					<ChevronDownIcon class="caret" aria-hidden="true" />
				</button>
				{#if can_create && !is_collapsed}
					<button
						class="board-col-new"
						type="button"
						aria-label={boardCreateHeading(column.status)}
						title={boardCreateHeading(column.status)}
						onclick={() => oncreate?.(column.status)}
					>
						<PlusIcon class="plus" aria-hidden="true" />
					</button>
				{/if}
			</header>
			{#if !is_collapsed}
				<div
					class="board-col-bd"
					id="board-col-bd-{column.status}"
					role={column.issues.length > 0 ? 'list' : undefined}
				>
					{#if column.issues.length === 0}
						<p class="board-empty">None</p>
					{:else}
						{#each column.issues as issue (issue.id)}
							<BoardCard
								{issue}
								{project_id}
								dragging={dragging?.issue_id === issue.id}
								oncardpointerdown={(event) => onCardPointerDown(issue, event)}
								onclicksuppress={suppressCardClick}
								ondispatchdestination={(destination) => requestDispatch(issue, destination)}
							/>
						{/each}
					{/if}
				</div>
			{/if}
		</section>
	{/each}
</div>

<BoardDispatchDialog {project_id} bind:pending {dispatch_enabled} {tackle_enabled} />

<style>
	.board {
		display: flex;
		align-items: stretch;
		gap: var(--s-3);
		overflow-x: auto;
		min-height: 240px;
		height: calc(100dvh - var(--topbar-h) - 12.5rem);
		padding-bottom: 2px;
	}

	.board-col {
		flex: 0 0 272px;
		display: flex;
		flex-direction: column;
		min-height: 0;
		max-height: 100%;
		background: var(--s1);
		border: 1px solid var(--line-2);
		border-radius: var(--r-2);
	}

	.board-col.is-drop-target {
		border-color: var(--em-400);
		box-shadow: 0 0 0 1px var(--em-400);
	}

	.board-col.is-collapsed {
		flex: 0 0 2.75rem;
		width: 2.75rem;
	}

	.board-col-hd {
		display: flex;
		align-items: stretch;
		flex: none;
		border-bottom: 1px solid var(--line-2);
		background: var(--s2);
		border-radius: var(--r-2) var(--r-2) 0 0;
	}

	.board-col.is-collapsed .board-col-hd {
		flex: 1;
		border-bottom: 0;
		border-radius: var(--r-2);
	}

	.board-col-toggle {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		flex: 1;
		min-width: 0;
		padding: 10px var(--s-3);
		border: 0;
		background: transparent;
		color: inherit;
		text-align: left;
		cursor: pointer;
		border-radius: inherit;
	}
	.board-col-toggle:hover {
		background: var(--s3);
	}
	.board-col-toggle:focus-visible {
		outline: 2px solid var(--em-400);
		outline-offset: -2px;
	}

	.board-col.is-collapsed .board-col-toggle {
		flex-direction: column;
		justify-content: flex-start;
		align-items: center;
		gap: var(--s-2);
		padding: var(--s-3) 4px;
	}

	.board-col.is-collapsed .name {
		writing-mode: vertical-rl;
		transform: rotate(180deg);
	}

	/* Column names are section headings: the website's h2 style. */
	.board-col-hd .name {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		font-size: var(--t-xs);
		font-weight: 600;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--tx-hi);
		min-width: 0;
	}
	.board-col-hd .count {
		margin-left: auto;
		font-size: var(--t-xs);
		color: var(--tx-dim);
	}

	.board-col-new {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: none;
		margin: 6px 8px 6px 0;
		padding: 0;
		width: 26px;
		height: 26px;
		border: 1px solid var(--line-2);
		border-radius: var(--r-1);
		background: var(--bg);
		color: var(--tx);
		font: inherit;
		font-size: var(--t-xs);
		cursor: pointer;
	}
	.board-col-new:hover {
		background: var(--s3);
		border-color: var(--line-2);
	}
	.board-col-new:focus-visible {
		outline: 2px solid var(--em-400);
		outline-offset: 1px;
	}
	.board-col-new :global(.plus) {
		width: 14px;
		height: 14px;
	}

	.board-col-toggle :global(.caret) {
		flex: none;
		width: 14px;
		height: 14px;
		color: var(--tx-dim);
		transition: transform 0.12s ease;
	}
	.board-col.is-collapsed .board-col-toggle :global(.caret) {
		order: -2;
		transform: rotate(-90deg);
	}
	.board-col.is-collapsed .count {
		order: -1;
		margin-left: 0;
	}

	.board-col-bd {
		display: flex;
		flex-direction: column;
		gap: var(--s-2);
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: var(--s-2);
	}

	.board-empty {
		margin: var(--s-3) var(--s-2);
		font-size: var(--t-xs);
		color: var(--tx-dim);
	}
</style>
