<script lang="ts">
	/**
	 * One issue, laid out for reading (specs/03). Shared by the full detail
	 * page and the parade's detail pane, so the two never drift.
	 *
	 * Density rules: status, priority, type and labels are said once, in the
	 * chip line; empty sections are omitted rather than announced; the side
	 * rail only appears when the container is wide enough to carry it, which
	 * is a container query so the pane and the page share one breakpoint.
	 */
	import type { Snippet } from 'svelte';
	import { toast } from 'svelte-sonner';
	import CommentComposer from '$lib/components/comment-composer.svelte';
	import IssueId from '$lib/components/issue-id.svelte';
	import MarkdownBody from '$lib/components/markdown-body.svelte';
	import MissionsList from '$lib/components/missions-list.svelte';
	import PriorityChip from '$lib/components/priority-chip.svelte';
	import BotIcon from '@lucide/svelte/icons/bot';
	import HammerIcon from '@lucide/svelte/icons/hammer';
	import StatusBadge from '$lib/components/status-badge.svelte';
	import TypeChip from '$lib/components/type-chip.svelte';
	import {
		absoluteStamp,
		depLabel,
		relativeLong,
		statusKey,
		statusLabel
	} from '$lib/client/format';
	import { extractToc } from '$lib/client/markdown';
	import { issueDetailHref } from '$lib/client/issue-view';
	import { agentAvailability, type AgentIntent } from '$lib/client/agent';
	import { currentProject, statusSnapshot } from '$lib/client/projects.svelte';
	import { app_state } from '$lib/client/stores.svelte';
	import type { IssueDetail, IssueRef, IssueSummary, Mission } from '$lib/types.js';

	interface MissionState {
		missions: Mission[];
		error: string | null;
	}

	interface Props {
		project_id: string;
		/** Whatever is known right now: the full issue, or a list row's summary. */
		header: IssueSummary;
		/** The full issue once it has loaded. */
		issue: IssueDetail | undefined;
		missions?: Promise<MissionState>;
		tackle_enabled?: boolean;
		comment_enabled?: boolean;
		/** `page` gets the big title; `pane` is the parade's reading pane. */
		variant?: 'page' | 'pane';
		/** Rendered at the start of the chip line (breadcrumb, open-in-page link). */
		lead?: Snippet;
	}

	let {
		project_id,
		header,
		issue,
		missions,
		tackle_enabled = false,
		comment_enabled = false,
		variant = 'page',
		lead
	}: Props = $props();

	const agent = $derived(agentAvailability(statusSnapshot(), currentProject()?.allow));

	/**
	 * Open the agent dialog on this issue.
	 *
	 * @param intent - Preselected intent.
	 */
	function askAgent(intent?: AgentIntent) {
		app_state.openAgent({
			project_id,
			issue_id: header.id,
			issue_title: header.title,
			...(intent === undefined ? {} : { intent })
		});
	}

	/** A table of contents earns its rail space only for a sectioned body. */
	const TOC_MIN_ENTRIES = 3;

	const pending = $derived(issue === undefined);
	const closed = $derived(statusKey(header.status) === 'closed');
	const toc = $derived(extractToc(issue?.description));
	const ups = $derived(issue?.dependencies ?? []);
	const downs = $derived(issue?.dependents ?? []);
	const has_relationships = $derived(
		issue !== undefined
			? ups.length + downs.length > 0
			: header.dependency_count + header.dependent_count > 0
	);

	/** Copy the issue id to the clipboard. */
	async function copyId() {
		try {
			await navigator.clipboard.writeText(header.id);
			toast.success('Copied the id', { description: header.id });
		} catch {
			toast.error('Could not copy the id');
		}
	}

	const AGENT_HINTS = ['agent', 'claude', 'bot', 'codex', 'cursor'];

	/**
	 * True when the author looks like an automated agent.
	 *
	 * @param author - Author name.
	 */
	function isAgent(author: string): boolean {
		const name = author.toLowerCase();
		return AGENT_HINTS.some((hint) => name.includes(hint));
	}

	/**
	 * Two-letter avatar mark for a comment author.
	 *
	 * @param author - Author name.
	 */
	function initials(author: string): string {
		return author.slice(0, 2).toUpperCase();
	}
</script>

{#snippet relation(ref: IssueRef, direction: 'up' | 'down')}
	<li
		class="rel-item{direction === 'up' && (ref.dep_type ?? '') === 'blocks' ? ' blocked-by' : ''}"
	>
		<span class="kind">{depLabel(ref.dep_type, direction)}</span>
		<i class="dot dot-{statusKey(ref.status)}" title={statusLabel(ref.status)} aria-hidden="true"
		></i>
		<IssueId id={ref.id} href={issueDetailHref(project_id, ref.id)} abbreviate />
		<a class="ti" href={issueDetailHref(project_id, ref.id)} title={ref.title}>{ref.title ?? ''}</a>
	</li>
{/snippet}

<article class="iv iv-{variant}" aria-busy={pending}>
	<header class="iv-hd">
		<div class="iv-line">
			{@render lead?.()}
			<button class="iv-id" type="button" title="Copy {header.id}" onclick={copyId}>
				<IssueId id={header.id} strong />
			</button>
			<StatusBadge status={header.status} />
			<PriorityChip priority={header.priority} />
			<TypeChip type={header.issue_type} />
			{#each header.labels as label (label)}
				<span class="tag">{label}</span>
			{/each}
			<span class="spacer"></span>
			{#if agent.visible}
				<span class="agent-acts">
					{#if tackle_enabled && !closed}
						<button
							class="btn btn-sm btn-icon"
							type="button"
							aria-label="Tackle {header.id}"
							aria-keyshortcuts={variant === 'page' ? 't' : undefined}
							title="Tackle: an agent claims and does the work{variant === 'page' ? ' (t)' : ''}"
							onclick={() => askAgent('tackle')}
						>
							<HammerIcon size={14} strokeWidth={1.4} />
						</button>
					{/if}
					<button
						class="btn btn-sm btn-primary"
						type="button"
						aria-keyshortcuts="a"
						title="Discuss, elaborate, close or tackle with an agent (a)"
						onclick={() => askAgent()}
					>
						<BotIcon size={14} strokeWidth={1.6} aria-hidden="true" />
						<span class="agent-lbl">Agent</span>
						<kbd class="kbd agent-kbd" aria-hidden="true">a</kbd>
					</button>
				</span>
			{/if}
		</div>
		<h1 class={variant === 'page' ? 'h1' : 'h2'}>{header.title}</h1>
	</header>

	<div class="iv-cols">
		<aside class="iv-rail">
			<dl class="facts">
				<dt>Assignee</dt>
				<dd>
					{#if header.assignee}
						<i class="dot {isAgent(header.assignee) ? 'dot-hooked' : 'dot-open'}" aria-hidden="true"
						></i>{header.assignee}
					{:else}
						<span class="faint">—</span>
					{/if}
				</dd>
				{#if header.owner && header.owner !== header.assignee}
					<dt>Owner</dt>
					<dd>{header.owner}</dd>
				{/if}
				<dt>Created</dt>
				<dd title={absoluteStamp(header.created_at)}>{relativeLong(header.created_at)}</dd>
				{#if issue?.created_by && !header.owner}
					<dt>Creator</dt>
					<dd>{issue.created_by}</dd>
				{/if}
				<dt>Updated</dt>
				<dd title={absoluteStamp(header.updated_at)}>{relativeLong(header.updated_at)}</dd>
				{#if issue?.due_at}
					<dt>Due</dt>
					<dd>{absoluteStamp(issue.due_at)}</dd>
				{/if}
				{#if issue?.defer_until}
					<dt>Deferred</dt>
					<dd>until {absoluteStamp(issue.defer_until)}</dd>
				{/if}
				{#if issue?.estimate}
					<dt>Estimate</dt>
					<dd>{issue.estimate} min</dd>
				{/if}
				{#if issue?.external_ref}
					<dt>Ref</dt>
					<dd class="clip" title={issue.external_ref}>{issue.external_ref}</dd>
				{/if}
			</dl>

			{#if has_relationships}
				<section class="rail-sec" aria-label="Relationships">
					{#if pending}
						<p class="hint">Loading relationships…</p>
					{:else}
						{#if ups.length > 0}
							<div class="rail-hd">
								<span class="lbl caps">Upstream</span><span class="n">{ups.length}</span>
							</div>
							<ul class="rel">
								{#each ups as ref (ref.id)}{@render relation(ref, 'up')}{/each}
							</ul>
						{/if}
						{#if downs.length > 0}
							<div class="rail-hd">
								<span class="lbl caps">Downstream</span><span class="n">{downs.length}</span>
							</div>
							<ul class="rel">
								{#each downs as ref (ref.id)}{@render relation(ref, 'down')}{/each}
							</ul>
						{/if}
					{/if}
				</section>
			{/if}

			{#if toc.length >= TOC_MIN_ENTRIES}
				<nav class="rail-sec toc" aria-label="Description sections">
					<div class="rail-hd"><span class="lbl caps">Contents</span></div>
					{#each toc as entry (entry.id)}
						<a href="#{entry.id}" style="padding-left:{(entry.depth - 1) * 10}px">{entry.text}</a>
					{/each}
				</nav>
			{/if}
		</aside>

		<div class="iv-main">
			{#if pending}
				<p class="hint">Loading…</p>
			{:else if issue}
				{#if issue.description}
					<MarkdownBody source={issue.description} />
				{:else}
					<p class="hint">No description.</p>
				{/if}

				{#if issue.acceptance_criteria}
					<section class="blk">
						<div class="blk-hd"><span class="lbl caps">Acceptance criteria</span></div>
						<MarkdownBody source={issue.acceptance_criteria} />
					</section>
				{/if}
				{#if issue.design}
					<section class="blk">
						<div class="blk-hd"><span class="lbl caps">Design</span></div>
						<MarkdownBody source={issue.design} />
					</section>
				{/if}
				{#if issue.notes}
					<section class="blk">
						<div class="blk-hd"><span class="lbl caps">Notes</span></div>
						<MarkdownBody source={issue.notes} />
					</section>
				{/if}

				{#if missions}
					{#await missions then state}
						{#if state.error}
							<section class="blk">
								<div class="blk-hd"><span class="lbl caps">Agent threads</span></div>
								<p class="hint">{state.error}</p>
							</section>
						{:else if state.missions.length > 0}
							<section class="blk">
								<div class="blk-hd">
									<span class="lbl caps">Agent threads</span><span class="n"
										>{state.missions.length}</span
									>
								</div>
								<MissionsList missions={state.missions} compact />
							</section>
						{/if}
					{/await}
				{/if}

				{#if issue.comments.length > 0 || comment_enabled}
					<section class="blk">
						<div class="blk-hd">
							<span class="lbl caps">Comments</span><span class="n">{issue.comments.length}</span>
						</div>
						{#each issue.comments as comment (comment.id)}
							<div class="cmt">
								<div class="av{isAgent(comment.author) ? ' av-agent' : ''}" aria-hidden="true">
									{initials(comment.author)}
								</div>
								<div class="cmt-bd">
									<div class="cmt-hd">
										<b>{comment.author}</b>
										<span class="t" title={absoluteStamp(comment.created_at)}
											>{relativeLong(comment.created_at)}</span
										>
									</div>
									<MarkdownBody source={comment.text} class="cmt-prose" />
								</div>
							</div>
						{/each}
						{#if comment_enabled}
							<CommentComposer
								{project_id}
								issue_id={issue.id}
								known_comment_ids={issue.comments.map((comment) => comment.id)}
							/>
						{/if}
					</section>
				{/if}
			{/if}
		</div>
	</div>
</article>

<style>
	.iv {
		container-type: inline-size;
		min-width: 0;
	}

	.iv-hd {
		margin-bottom: var(--s-4);
	}
	.iv-line {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		margin-bottom: var(--s-2);
		min-height: 28px;
	}
	.iv-line .spacer {
		flex: 1;
	}
	.agent-acts {
		display: inline-flex;
		gap: 6px;
		align-items: center;
	}
	.agent-kbd {
		background: transparent;
		border-color: color-mix(in srgb, var(--on-em) 35%, transparent);
		color: var(--on-em);
		padding: 0 4px;
	}
	@container (max-width: 420px) {
		.agent-lbl,
		.agent-kbd {
			display: none;
		}
	}
	.iv-id {
		background: none;
		border: 0;
		padding: 0 4px 0 0;
		cursor: copy;
		font: inherit;
	}
	.iv-hd :global(h1) {
		overflow-wrap: anywhere;
	}
	.iv-pane .iv-hd :global(h1) {
		line-height: 1.3;
	}
	@container (max-width: 520px) {
		.iv-hd :global(h1) {
			font-size: var(--t-lg);
		}
	}

	/*
	 * Narrow: one column, the rail's facts first because they are short.
	 * Wide: body left, rail right, and the rail sticks while the body scrolls.
	 */
	.iv-cols {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--s-4);
		align-items: start;
	}
	@container (min-width: 760px) {
		.iv-cols {
			grid-template-columns: minmax(0, 1fr) 248px;
			gap: var(--s-6);
		}
		.iv-rail {
			grid-column: 2;
			grid-row: 1;
			position: sticky;
			top: var(--s-4);
			border-left: 1px solid var(--line);
			padding-left: var(--s-4);
		}
		.iv-main {
			grid-column: 1;
			grid-row: 1;
		}
		/* The page scrolls under the sticky top bar; the pane scrolls itself. */
		.iv-page .iv-rail {
			top: calc(var(--topbar-h) + var(--s-4));
		}
	}

	.iv-main {
		min-width: 0;
	}
	.iv-main :global(.prose) {
		max-width: 96ch;
	}

	.blk {
		margin-top: var(--s-6);
	}
	.blk-hd,
	.rail-hd {
		display: flex;
		align-items: baseline;
		gap: var(--s-2);
		padding-bottom: 6px;
		margin-bottom: var(--s-3);
		border-bottom: 2px solid var(--rule);
	}
	.n {
		font-size: var(--t-xs);
		color: var(--tx-dim);
		font-variant-numeric: tabular-nums;
	}

	/* Facts: a tight two-column definition list. */
	.facts {
		display: grid;
		grid-template-columns: 80px minmax(0, 1fr);
		gap: 6px var(--s-3);
		margin: 0;
		font-size: var(--t-sm);
	}
	.facts dt {
		font-size: var(--t-xs);
		color: var(--tx-dim);
		line-height: 20px;
	}
	.facts dd {
		margin: 0;
		color: var(--tx-hi);
		min-width: 0;
		line-height: 20px;
		overflow-wrap: anywhere;
	}
	.facts dd .dot {
		margin-right: 6px;
	}
	.facts .clip {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.rail-sec {
		margin-top: var(--s-4);
	}

	.rel {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.rel-item {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 0;
		font-size: var(--t-sm);
		min-width: 0;
	}
	.rel-item .kind {
		flex: none;
		width: 72px;
		font-size: var(--t-xs);
		color: var(--tx-dim);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.rel-item.blocked-by .kind {
		color: var(--amber);
	}
	.rel-item .ti {
		flex: 1;
		min-width: 0;
		color: var(--tx);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.rel-item .ti:hover {
		color: var(--tx-hi);
		text-decoration: none;
	}

	.toc {
		display: flex;
		flex-direction: column;
	}
	@container (max-width: 759px) {
		.toc {
			display: none;
		}
	}
	.toc a {
		font-size: var(--t-sm);
		color: var(--tx-mid);
		padding: 2px 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.toc a:hover {
		color: var(--tx-hi);
		text-decoration: none;
	}

	/* Comments */
	.cmt {
		display: flex;
		gap: var(--s-3);
		padding: var(--s-4) 0;
		border-bottom: 1px solid var(--line);
	}
	.cmt:last-of-type {
		border-bottom: 0;
	}
	.av {
		width: 26px;
		height: 26px;
		flex: none;
		border-radius: var(--r-1);
		background: var(--s3);
		display: grid;
		place-items: center;
		font-size: var(--t-micro);
		color: var(--tx-mid);
		font-weight: 600;
	}
	.av-agent {
		color: var(--cyan-tx);
		background: var(--s3);
		box-shadow: inset 0 0 0 1px var(--cyan-line);
	}
	.cmt-bd {
		flex: 1;
		min-width: 0;
	}
	.cmt-hd {
		display: flex;
		align-items: baseline;
		gap: var(--s-2);
		margin-bottom: 4px;
		font-size: var(--t-sm);
	}
	.cmt-hd b {
		color: var(--tx-hi);
		font-weight: 600;
	}
	.cmt-hd .t {
		color: var(--tx-dim);
		font-size: var(--t-xs);
	}
	.cmt :global(.cmt-prose) {
		font-size: 14.5px;
	}
</style>
