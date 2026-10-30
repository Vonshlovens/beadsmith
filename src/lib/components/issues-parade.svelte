<script lang="ts">
	/**
	 * Parade view (after mardi-gras): status-grouped rows on the left, the
	 * selected issue read in a pane on the right. j/k (or ↑/↓) move the
	 * selection, Enter opens the full page. The selection lives in `?issue=`
	 * via shallow routing so it survives reload and can be shared, without
	 * re-running the list load. Below 900px there is no pane and rows are
	 * plain links to the detail page.
	 */
	import { untrack } from 'svelte';
	import { browser } from '$app/environment';
	import { goto, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import IssueDetailView from '$lib/components/issue-detail-view.svelte';
	import PriorityChip from '$lib/components/priority-chip.svelte';
	import { api, errorMessage } from '$lib/client/api';
	import { agentAvailability } from '$lib/client/agent';
	import { useHotkeys } from '$lib/client/hotkeys.svelte';
	import { currentProject, statusSnapshot } from '$lib/client/projects.svelte';
	import { app_state } from '$lib/client/stores.svelte';
	import { relativeShort, splitIssueId, statusKey, statusLabel } from '$lib/client/format';
	import { issueDetailHref } from '$lib/client/issue-view';
	import {
		groupParade,
		PARADE_COLLAPSED_KEY,
		paradeOrder,
		parseCollapsed,
		stepSelection,
		type ParadeSectionId
	} from '$lib/client/parade';
	import type { IssueDetail, IssueSummary, Mission } from '$lib/types.js';

	interface Props {
		issues: IssueSummary[];
		project_id: string;
		tackle_enabled: boolean;
	}

	let { issues, project_id, tackle_enabled }: Props = $props();

	/** Matches the CSS breakpoint that hides the pane. */
	const PANE_QUERY = '(min-width: 900px)';
	/** How long a fetched issue is reused before the pane asks again. */
	const DETAIL_TTL_MS = 30_000;
	/** Holding j shouldn't fire a request per row; wait for the reader to settle. */
	const FETCH_DELAY_MS = 90;

	const sections = $derived(groupParade(issues));
	const agent_visible = $derived(
		agentAvailability(statusSnapshot(), currentProject()?.allow).visible
	);

	let collapsed = $state<Set<ParadeSectionId>>(parseCollapsed(null));
	$effect(() => {
		if (!browser) {
			return;
		}
		untrack(() => {
			try {
				collapsed = parseCollapsed(window.localStorage.getItem(PARADE_COLLAPSED_KEY));
			} catch {
				/* storage disabled — keep the default */
			}
		});
	});

	const order = $derived(paradeOrder(sections, collapsed));

	/** What the reader picked; falls back to the top row when absent or filtered out. */
	let chosen = $state<string | null>(untrack(() => page.url.searchParams.get('issue')));
	const selected_id = $derived(
		chosen !== null && issues.some((issue) => issue.id === chosen) ? chosen : (order[0]?.id ?? null)
	);
	const selected = $derived(issues.find((issue) => issue.id === selected_id));

	let list_el = $state<HTMLDivElement | null>(null);
	let pane_el = $state<HTMLDivElement | null>(null);

	/**
	 * Toggle one section and remember it.
	 *
	 * @param id - Section whose header was clicked.
	 */
	function toggleSection(id: ParadeSectionId) {
		const next = new Set(collapsed);
		if (next.has(id)) {
			next.delete(id);
		} else {
			next.add(id);
		}
		collapsed = next;
		try {
			window.localStorage.setItem(PARADE_COLLAPSED_KEY, JSON.stringify([...next]));
		} catch {
			/* preference is best-effort */
		}
	}

	/**
	 * Select a row: update the pane, the URL, and keep the row on screen.
	 *
	 * @param id - Issue to select.
	 */
	function select(id: string) {
		chosen = id;
		const url = new URL(page.url);
		url.searchParams.set('issue', id);
		replaceState(url, page.state);
		requestAnimationFrame(() => {
			list_el
				?.querySelector<HTMLElement>(`[data-issue="${CSS.escape(id)}"]`)
				?.scrollIntoView({ block: 'nearest' });
			pane_el?.scrollTo({ top: 0 });
		});
	}

	/**
	 * Plain clicks select in place when the pane is showing; modified clicks
	 * and phone widths follow the link.
	 *
	 * @param event - The row click.
	 * @param id - Row's issue id.
	 */
	function onRowClick(event: MouseEvent, id: string) {
		if (
			event.button !== 0 ||
			event.metaKey ||
			event.ctrlKey ||
			event.shiftKey ||
			event.altKey ||
			!window.matchMedia(PANE_QUERY).matches
		) {
			return;
		}
		event.preventDefault();
		select(id);
	}

	/**
	 * Move the selection one row and keep keyboard focus on it.
	 *
	 * @param step - Down (1) or up (-1).
	 */
	function stepRow(step: 1 | -1): boolean {
		const next = stepSelection(order, selected_id, step);
		if (next === null) {
			return false;
		}
		select(next);
		list_el?.querySelector<HTMLElement>(`[data-issue="${CSS.escape(next)}"]`)?.focus();
		return true;
	}

	/** Arrow keys stay native while focus is inside the reading pane, so it scrolls. */
	function inPane(event: KeyboardEvent): boolean {
		const target = event.target as Node | null;
		return pane_el !== null && target !== null && pane_el.contains(target);
	}

	useHotkeys(() => [
		{ keys: ['j'], label: 'Next issue', group: 'Lists', run: () => stepRow(1) },
		{ keys: ['k'], label: 'Previous issue', group: 'Lists', run: () => stepRow(-1) },
		{
			keys: ['ArrowDown'],
			label: 'Next issue',
			group: 'Lists',
			hidden: true,
			run: (event) => !inPane(event) && stepRow(1)
		},
		{
			keys: ['ArrowUp'],
			label: 'Previous issue',
			group: 'Lists',
			hidden: true,
			run: (event) => !inPane(event) && stepRow(-1)
		},
		{
			keys: ['o', 'Enter'],
			label: 'Open the issue page',
			group: 'Lists',
			run: (event) => {
				if (selected_id === null) {
					return false;
				}
				if (
					event.key === 'Enter' &&
					(event.target as HTMLElement | null)?.closest('[data-issue]') === null
				) {
					return false;
				}
				void goto(issueDetailHref(project_id, selected_id));
			}
		},
		{
			keys: ['a'],
			label: 'Ask an agent about the selected issue',
			group: 'Agent',
			when: () => agent_visible,
			run: () => {
				if (selected === undefined) {
					return false;
				}
				app_state.openAgent({
					project_id,
					issue_id: selected.id,
					issue_title: selected.title
				});
			}
		}
	]);

	/* ---- detail pane data ---------------------------------------------- */

	interface CachedDetail {
		issue: IssueDetail;
		at: number;
	}

	const detail_cache = new Map<string, CachedDetail>();

	let detail = $state<IssueDetail | undefined>(undefined);
	let detail_error = $state<string | null>(null);
	let missions = $state<Promise<{ missions: Mission[]; error: string | null }> | undefined>(
		undefined
	);

	$effect(() => {
		const id = selected_id;
		const project = project_id;
		if (!browser || id === null) {
			return;
		}
		const key = `${project}:${id}`;
		const cached = detail_cache.get(key);
		detail_error = null;
		detail = cached?.issue;
		if (cached && Date.now() - cached.at < DETAIL_TTL_MS) {
			missions = loadMissions(project, id);
			return;
		}
		let live = true;
		const timer = setTimeout(() => {
			missions = loadMissions(project, id);
			api
				.issue(project, id)
				.then((response) => {
					detail_cache.set(key, { issue: response.issue, at: Date.now() });
					if (live) {
						detail = response.issue;
					}
				})
				.catch((thrown) => {
					if (live) {
						detail_error = errorMessage(thrown);
					}
				});
		}, FETCH_DELAY_MS);
		return () => {
			live = false;
			clearTimeout(timer);
		};
	});

	/**
	 * File/Tackle/comment runs for one issue. Failure is shown, not thrown.
	 *
	 * @param project - Project id.
	 * @param id - Issue id.
	 */
	async function loadMissions(project: string, id: string) {
		try {
			const response = await api.missions({ project_id: project, issue_id: id, limit: 20 });
			return { missions: response.missions, error: null };
		} catch (thrown) {
			return { missions: [] as Mission[], error: errorMessage(thrown) };
		}
	}
</script>

<div class="parade">
	<div class="lane" bind:this={list_el} role="listbox" aria-label="Issues" tabindex="-1">
		{#each sections as section (section.id)}
			{@const folded = collapsed.has(section.id)}
			<div class="grp" role="group" aria-label={section.label}>
				<button
					class="grp-hd"
					type="button"
					aria-expanded={!folded}
					onclick={() => toggleSection(section.id)}
				>
					<span class="caret" aria-hidden="true">{folded ? '▸' : '▾'}</span>
					<i class="dot dot-{section.bead}" aria-hidden="true"></i>
					<span class="name">{section.label}</span>
					<span class="count">{section.issues.length}</span>
				</button>
				{#if !folded}
					{#each section.issues as issue (issue.id)}
						{@const key = statusKey(issue.status)}
						{@const parts = splitIssueId(issue.id)}
						<a
							class="prow"
							class:is-sel={issue.id === selected_id}
							href={issueDetailHref(project_id, issue.id)}
							data-issue={issue.id}
							role="option"
							aria-selected={issue.id === selected_id}
							onclick={(event) => onRowClick(event, issue.id)}
						>
							<i class="dot dot-{key}" title={statusLabel(issue.status)} aria-hidden="true"></i>
							<span class="rid" title={issue.id}>{parts.suffix}</span>
							<PriorityChip priority={issue.priority} />
							<span class="rti" title={issue.title}>{issue.title}</span>
							{#if issue.dependency_count > 0 && key === 'blocked'}
								<span class="rdep" title="{issue.dependency_count} upstream">⛓</span>
							{/if}
							<span class="rty">{issue.issue_type}</span>
							<span class="rup" title={issue.updated_at}>{relativeShort(issue.updated_at)}</span>
						</a>
					{/each}
				{/if}
			</div>
		{/each}
	</div>

	<div class="pane" bind:this={pane_el} aria-live="polite">
		{#if selected}
			{#if detail_error}
				<div class="banner banner-err" role="alert">
					<div class="banner-bd"><b>Could not load {selected.id}.</b> {detail_error}</div>
				</div>
			{/if}
			<IssueDetailView
				{project_id}
				header={detail?.id === selected.id ? detail : selected}
				issue={detail?.id === selected.id ? detail : undefined}
				{missions}
				{tackle_enabled}
				variant="pane"
			>
				{#snippet lead()}
					<a
						class="open"
						href={issueDetailHref(project_id, selected.id)}
						title="Open the full page (o)">Open ↗</a
					>
				{/snippet}
			</IssueDetailView>
		{:else}
			<p class="hint">Nothing selected.</p>
		{/if}
	</div>
</div>

<style>
	.parade {
		display: grid;
		grid-template-columns: minmax(360px, 42%) minmax(0, 1fr);
		border: 1px solid var(--line);
		border-radius: var(--r-2);
		background: var(--s1);
		overflow: hidden;
		min-height: 0;
	}
	@media (max-width: 899px) {
		.parade {
			grid-template-columns: minmax(0, 1fr);
		}
		.pane {
			display: none;
		}
	}

	.lane {
		overflow-y: auto;
		border-right: 1px solid var(--line);
		min-height: 0;
		outline: none;
	}
	.pane {
		overflow-y: auto;
		min-height: 0;
		padding: var(--s-4) var(--s-5) var(--s-6);
		background: var(--bg);
	}

	.grp-hd {
		position: sticky;
		top: 0;
		z-index: 1;
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		height: 28px;
		padding: 0 var(--s-3);
		background: var(--s2);
		border: 0;
		border-bottom: 1px solid var(--line);
		font-size: var(--t-micro);
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--tx-mid);
		cursor: pointer;
		text-align: left;
	}
	.grp-hd:hover {
		color: var(--tx-hi);
	}
	.grp-hd .caret {
		width: 10px;
		color: var(--tx-faint);
	}
	.grp-hd .count {
		color: var(--tx-faint);
		font-variant-numeric: tabular-nums;
	}

	.prow {
		display: flex;
		align-items: center;
		gap: 8px;
		height: 28px;
		padding: 0 var(--s-3) 0 calc(var(--s-3) + 2px);
		border-bottom: 1px solid var(--line);
		border-left: 2px solid transparent;
		font-size: var(--t-xs);
		color: var(--tx);
		min-width: 0;
		outline: none;
	}
	.prow:hover {
		background: var(--s2);
		text-decoration: none;
		color: var(--tx-hi);
	}
	.prow.is-sel {
		background: var(--em-wash);
		border-left-color: var(--em-500);
		color: var(--tx-hi);
	}
	.prow:focus-visible {
		box-shadow: inset 0 0 0 1px var(--em-700);
	}
	.rid {
		flex: none;
		width: 3.6em;
		color: var(--tx-mid);
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.prow :global(.prio) {
		flex: none;
	}
	.rti {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.rdep {
		flex: none;
		color: var(--amber);
		font-size: 10px;
	}
	.rty,
	.rup {
		flex: none;
		color: var(--tx-faint);
		font-size: var(--t-micro);
		font-variant-numeric: tabular-nums;
	}
	.rty {
		width: 4.6em;
		text-align: right;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.rup {
		width: 2.6em;
		text-align: right;
	}
	@media (max-width: 640px) {
		.rty {
			display: none;
		}
		.prow {
			height: 34px;
		}
	}

	.open {
		font-size: var(--t-xs);
		color: var(--tx-dim);
		margin-right: var(--s-2);
	}
	.open:hover {
		color: var(--em-400);
		text-decoration: none;
	}
</style>
