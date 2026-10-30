<script lang="ts">
	/**
	 * One board card: identity, title, chips, truncated labels, and counts.
	 * The title block is the issue-detail link (Enter/Space). Send-to-agent is
	 * a sibling control so keyboard users can open the same dispatch confirm
	 * as a drop without nesting buttons inside the link.
	 */
	import SendHorizontalIcon from '@lucide/svelte/icons/send-horizontal';
	import IssueId from '$lib/components/issue-id.svelte';
	import PriorityChip from '$lib/components/priority-chip.svelte';
	import TypeChip from '$lib/components/type-chip.svelte';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import { rememberIssueSummaryHint } from '$lib/client/issue-summary-hint.js';
	import { keyboardDispatchChoices } from '$lib/client/board-dispatch';
	import { boardCardAccessibleName } from '$lib/client/board-keyboard';
	import { relativeShort, statusKey, statusLabel } from '$lib/client/format';
	import { agentAvailability } from '$lib/client/agent';
	import { currentProject, statusSnapshot } from '$lib/client/projects.svelte';
	import { app_state } from '$lib/client/stores.svelte';
	import type { StatusKey } from '$lib/client/format';
	import type { IssueSummary } from '$lib/types';

	interface Props {
		issue: IssueSummary;
		project_id: string;
		dragging?: boolean;
		oncardpointerdown?: (event: PointerEvent) => void;
		onclicksuppress?: (event: MouseEvent) => void;
		ondispatchdestination?: (destination: StatusKey) => void;
	}

	let {
		issue,
		project_id,
		dragging = false,
		oncardpointerdown,
		onclicksuppress,
		ondispatchdestination
	}: Props = $props();

	const href = $derived(`/p/${project_id}/i/${issue.id}`);
	const extra_labels = $derived(Math.max(0, issue.labels.length - 2));
	const source_status = $derived(statusKey(issue.status));
	const choices = $derived(keyboardDispatchChoices(source_status));
	const accessible_name = $derived(boardCardAccessibleName(issue));
	let menu_open = $state(false);
	const agent_visible = $derived(
		agentAvailability(statusSnapshot(), currentProject()?.allow).visible
	);

	function onCardKeyDown(event: KeyboardEvent) {
		if (event.altKey || event.ctrlKey || event.metaKey) {
			return;
		}
		if (event.key !== 'm' && event.key !== 'M') {
			return;
		}
		event.preventDefault();
		menu_open = true;
	}
</script>

<div
	class="board-card-shell{statusKey(issue.status) === 'closed' ? ' is-closed' : ''}{dragging
		? ' is-dragging'
		: ''}"
	role="listitem"
	data-board-card-id={issue.id}
	data-board-status={source_status}
>
	<a
		class="board-card"
		{href}
		draggable="false"
		aria-label={accessible_name}
		aria-keyshortcuts="m"
		onmouseenter={() => rememberIssueSummaryHint(issue)}
		onfocusin={() => rememberIssueSummaryHint(issue)}
		onkeydown={onCardKeyDown}
		onpointerdown={(event) => {
			rememberIssueSummaryHint(issue);
			oncardpointerdown?.(event);
		}}
		onclick={onclicksuppress}
	>
		<div class="card-top">
			<IssueId id={issue.id} />
			<span class="when">{relativeShort(issue.updated_at)}</span>
		</div>
		<div class="card-title">{issue.title}</div>
		<div class="card-chips">
			<PriorityChip priority={issue.priority} />
			<TypeChip type={issue.issue_type} />
			{#each issue.labels.slice(0, 2) as label (label)}
				<span class="tag">{label}</span>
			{/each}
			{#if extra_labels > 0}
				<span class="faint">+{extra_labels}</span>
			{/if}
		</div>
		<div class="card-meta">
			<span
				class="deps"
				title="{issue.dependency_count} blocking, {issue.dependent_count} dependent"
			>
				<span class={issue.dependency_count > 0 ? 'up' : 'faint'}>↑{issue.dependency_count}</span>
				<b>↓{issue.dependent_count}</b>
			</span>
			{#if issue.comment_count > 0}
				<span class="faint">{issue.comment_count}c</span>
			{/if}
		</div>
	</a>
	<DropdownMenu.Root bind:open={menu_open}>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<button
					{...props}
					class="board-card-send"
					type="button"
					aria-label="Send {issue.id} to an agent"
					aria-keyshortcuts="m"
					title="Send to an agent (m)"
				>
					<SendHorizontalIcon size={13} strokeWidth={1.4} aria-hidden="true" />
				</button>
			{/snippet}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content class="ui-menu ui-menu-narrow" align="start" sideOffset={4}>
			{#if agent_visible}
				<DropdownMenu.Item
					class="ui-menu-item"
					onSelect={() =>
						app_state.openAgent({ project_id, issue_id: issue.id, issue_title: issue.title })}
				>
					Discuss, elaborate or close… <span class="kbd menu-kbd">a</span>
				</DropdownMenu.Item>
				<DropdownMenu.Separator class="ui-menu-sep" />
			{/if}
			<DropdownMenu.Label class="ui-menu-heading">Send toward</DropdownMenu.Label>
			{#each choices as action (action.destination)}
				<DropdownMenu.Item
					class="ui-menu-item"
					onSelect={() => ondispatchdestination?.(action.destination)}
				>
					{statusLabel(action.destination)}
				</DropdownMenu.Item>
			{/each}
		</DropdownMenu.Content>
	</DropdownMenu.Root>
</div>

<style>
	.board-card-shell {
		position: relative;
		display: flex;
		flex-direction: column;
		background: var(--s2);
		border: 1px solid var(--line);
		border-radius: var(--r-1);
		min-width: 0;
	}
	.board-card-shell.is-dragging {
		opacity: 0.55;
	}
	.board-card-shell:hover,
	.board-card-shell:focus-within {
		border-color: var(--line-2);
		background: var(--s3);
	}

	.board-card {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: var(--s-3);
		color: inherit;
		text-decoration: none;
		min-width: 0;
		cursor: grab;
		user-select: none;
		-webkit-user-select: none;
		touch-action: none;
		border-radius: var(--r-1);
	}
	.board-card-shell.is-dragging .board-card {
		cursor: grabbing;
	}
	.board-card:hover {
		text-decoration: none;
	}
	.board-card:focus-visible {
		outline: 2px solid var(--em-400);
		outline-offset: -2px;
	}
	.board-card-shell.is-closed .card-title {
		color: var(--tx-dim);
	}

	/* A sibling of the card link, laid over its meta row, so no button nests in a link. */
	.board-card-send {
		position: absolute;
		right: 6px;
		bottom: 6px;
		display: grid;
		place-items: center;
		width: 24px;
		height: 24px;
		margin: 0;
		padding: 0;
		border: 1px solid transparent;
		border-radius: var(--r-1);
		background: transparent;
		color: var(--tx-faint);
		cursor: pointer;
	}
	.board-card-shell:hover .board-card-send {
		color: var(--tx-dim);
		border-color: var(--line);
	}
	.menu-kbd {
		margin-left: auto;
	}
	.board-card-send:hover,
	.board-card-send:focus-visible {
		color: var(--tx-hi);
		background: var(--s2);
	}
	.board-card-send:focus-visible {
		outline: 2px solid var(--em-400);
		outline-offset: -2px;
	}

	.card-top {
		display: flex;
		align-items: baseline;
		gap: var(--s-2);
		min-width: 0;
	}
	.card-top :global(.id) {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.when {
		margin-left: auto;
		flex: none;
		font-size: var(--t-micro);
		color: var(--tx-dim);
		font-variant-numeric: tabular-nums;
	}

	.card-title {
		font-size: var(--t-sm);
		color: var(--tx-hi);
		line-height: 1.35;
		display: -webkit-box;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.card-chips {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}

	.card-meta {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		min-height: 18px;
		padding-right: 26px;
		font-size: var(--t-xs);
		color: var(--tx-faint);
		font-variant-numeric: tabular-nums;
	}
	.deps b {
		color: var(--tx-mid);
		font-weight: 400;
		margin-left: 4px;
	}
	.deps .up {
		color: var(--em-400);
	}
</style>
