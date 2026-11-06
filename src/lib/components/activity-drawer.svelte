<script lang="ts">
	/**
	 * Recent changes, on demand: a drawer from the top bar instead of a column
	 * on the home page. Events are folded to one line per issue per day
	 * (`activity-groups.ts`) so a busy issue does not flood it; the full
	 * stream stays on /activity. Lines newer than the last visit carry the red
	 * bead. A drawer (docs/design-standards.md §5) so the page underneath and
	 * its scroll position stay where they were.
	 */
	import { untrack } from 'svelte';
	import { Dialog as DialogPrimitive } from 'bits-ui';
	import { page } from '$app/state';
	import ArrowsClockwiseIcon from 'phosphor-svelte/lib/ArrowsClockwiseIcon';
	import XIcon from 'phosphor-svelte/lib/XIcon';
	import IssueId from '#lib/components/issue-id.svelte';
	import { api, errorMessage } from '#lib/client/api.js';
	import { groupActivity } from '#lib/client/activity-groups.js';
	import { absoluteStamp, relativeShort } from '#lib/client/format.js';
	import { currentProject } from '#lib/client/projects.svelte.js';
	import { app_state } from '#lib/client/stores.svelte.js';
	import { tip } from '#lib/client/tooltip.js';
	import type { ActivityEvent } from '#lib/types.js';

	const LIMIT = 120;

	let events = $state<ActivityEvent[]>([]);
	let loaded = $state(false);
	let loading = $state(false);
	let load_error = $state<string | null>(null);
	/** What "new" means for this opening: the previous visit, frozen on open. */
	let seen_before = $state(0);
	let scope = $state<'all' | 'project'>('all');

	const project = $derived(currentProject());
	const scoped = $derived(
		scope === 'project' && project
			? events.filter((event) => event.project_id === project.id)
			: events
	);
	const days = $derived(groupActivity(scoped));
	const issue_count = $derived(days.reduce((sum, day) => sum + day.groups.length, 0));

	async function load() {
		loading = true;
		load_error = null;
		try {
			events = (await api.activity(LIMIT)).events;
			loaded = true;
		} catch (error) {
			load_error = errorMessage(error);
		} finally {
			loading = false;
		}
	}

	function onOpenChange(next: boolean) {
		if (!next) {
			app_state.markActivitySeen();
		}
		app_state.activity_open = next;
	}

	$effect(() => {
		if (!app_state.activity_open) {
			return;
		}
		untrack(() => {
			seen_before = app_state.activity_seen_at;
			scope = project ? 'project' : 'all';
			void load();
		});
	});

	/** A project page scopes to that project; elsewhere there is nothing to scope to. */
	$effect(() => {
		if (!project && scope === 'project') {
			scope = 'all';
		}
	});

	/** Leaving for an issue closes the drawer, as any link out of a dialog would. */
	let last_path = untrack(() => page.url.pathname);
	$effect(() => {
		const path = page.url.pathname;
		if (path === last_path) {
			return;
		}
		last_path = path;
		if (untrack(() => app_state.activity_open)) {
			onOpenChange(false);
		}
	});

	function who(actors: string[]): string {
		if (actors.length <= 2) return actors.join(' and ');
		return `${actors.slice(0, 2).join(', ')} and ${actors.length - 2} more`;
	}
</script>

<DialogPrimitive.Root open={app_state.activity_open} {onOpenChange}>
	<DialogPrimitive.Portal>
		<DialogPrimitive.Overlay class="ui-overlay sheet-overlay" />
		<DialogPrimitive.Content class="sheet" aria-describedby="activity-sheet-desc">
			<header class="sheet-hd">
				<DialogPrimitive.Title class="sheet-t">Recent changes</DialogPrimitive.Title>
				<span class="sheet-sp"></span>
				<button
					class="btn btn-sm btn-ghost btn-icon"
					type="button"
					aria-label="Refresh"
					disabled={loading}
					class:is-spinning={loading}
					onclick={() => void load()}
					{@attach tip('Refresh')}
				>
					<ArrowsClockwiseIcon size={15} />
				</button>
				<DialogPrimitive.Close class="btn btn-sm btn-ghost btn-icon" aria-label="Close">
					<XIcon size={15} />
				</DialogPrimitive.Close>
			</header>
			<p class="sheet-sub" id="activity-sheet-desc">
				One line per issue per day, newest first.
				{#if seen_before > 0}<span class="new-key"
						><i class="dot dot-blocked" aria-hidden="true"></i> new since your last look</span
					>{/if}
			</p>

			{#if project}
				<div class="seg" role="radiogroup" aria-label="Which projects">
					<button
						type="button"
						role="radio"
						aria-checked={scope === 'project'}
						class:is-on={scope === 'project'}
						onclick={() => (scope = 'project')}>{project.name}</button
					>
					<button
						type="button"
						role="radio"
						aria-checked={scope === 'all'}
						class:is-on={scope === 'all'}
						onclick={() => (scope = 'all')}>All projects</button
					>
				</div>
			{/if}

			<div class="sheet-bd" aria-busy={loading}>
				{#if load_error}
					<div class="banner banner-err" role="alert">
						<div class="banner-bd">
							<b>Recent changes could not be loaded.</b>
							<div class="mt-2">{load_error}</div>
						</div>
						<div class="banner-acts">
							<button
								class="btn btn-sm"
								type="button"
								disabled={loading}
								onclick={() => void load()}>{loading ? 'Retrying…' : 'Retry'}</button
							>
						</div>
					</div>
				{:else if !loaded}
					<p class="hint">Loading recent changes…</p>
				{:else if days.length === 0}
					<p class="hint">
						{#if scope === 'project' && project}
							Nothing has changed in {project.name} recently.
							<button class="linkish" type="button" onclick={() => (scope = 'all')}
								>Show all projects</button
							>
						{:else}
							Nothing has changed yet. Changes appear here as soon as an issue is created or
							updated.
						{/if}
					</p>
				{:else}
					{#each days as day (day.day)}
						<section class="day" aria-label={day.label}>
							<h3 class="day-hd">{day.label}</h3>
							<ul class="grp">
								{#each day.groups as group (group.key)}
									{@const fresh = seen_before > 0 && Date.parse(group.latest_at) > seen_before}
									<li class="gi" class:is-new={fresh}>
										<span class="gi-mark" aria-hidden="true"
											><i class="dot {fresh ? 'dot-blocked' : 'dot-closed'}"></i></span
										>
										<div class="gi-bd">
											<div class="gi-top">
												<IssueId
													id={group.issue_id}
													href="/p/{group.project_id}/i/{group.issue_id}"
													abbreviate={scope === 'project'}
												/>
												<a class="gi-title" href="/p/{group.project_id}/i/{group.issue_id}"
													>{group.issue_title ?? 'Untitled issue'}</a
												>
												<time
													class="gi-when mono-num"
													datetime={group.latest_at}
													{@attach tip(absoluteStamp(group.latest_at))}
													>{relativeShort(group.latest_at)}</time
												>
											</div>
											<div class="gi-what">
												{#if scope === 'all'}<span class="gi-proj">{group.project_name}{' · '}</span
													>{/if}<span class="gi-who">{who(group.actors)}</span>
												{group.verbs.join(', ')}
												{#if group.count > group.verbs.length}<span class="gi-n"
														>({group.count} changes)</span
													>{/if}
												{#if fresh}<span class="sr-only">, new</span>{/if}
											</div>
										</div>
									</li>
								{/each}
							</ul>
						</section>
					{/each}
				{/if}
			</div>

			<footer class="sheet-ft">
				<span class="xs faint mono-num"
					>{#if loaded}{events.length} changes on {issue_count} issues{/if}</span
				>
				<span class="sheet-sp"></span>
				<a class="btn btn-sm" href="/activity">Open the activity log</a>
			</footer>
		</DialogPrimitive.Content>
	</DialogPrimitive.Portal>
</DialogPrimitive.Root>

<style>
	:global(.sheet-overlay) {
		position: fixed;
		inset: 0;
		z-index: 50;
	}
	:global(.sheet) {
		position: fixed;
		top: 0;
		right: 0;
		bottom: 0;
		z-index: 51;
		display: flex;
		flex-direction: column;
		width: min(440px, 100vw);
		background: var(--bg);
		border-left: 2px solid var(--rule);
		box-shadow: var(--shadow-modal);
		color: var(--tx);
		outline: none;
	}
	:global(.sheet[data-state='open']) {
		animation: sheet-in 0.18s ease-out;
	}
	@keyframes sheet-in {
		from {
			transform: translateX(24px);
			opacity: 0;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		:global(.sheet[data-state='open']) {
			animation: none;
		}
	}
	.sheet-hd {
		display: flex;
		align-items: center;
		gap: var(--s-1);
		height: var(--topbar-h);
		flex: none;
		padding: 0 var(--s-3) 0 var(--s-5);
		border-bottom: 1px solid var(--line);
	}
	:global(.sheet-t) {
		font-size: var(--t-md);
		font-weight: 600;
		color: var(--tx-hi);
	}
	.sheet-sp {
		flex: 1;
	}
	.sheet-sub {
		margin: var(--s-3) var(--s-5) 0;
		font-size: var(--t-xs);
		color: var(--tx-dim);
		display: flex;
		flex-wrap: wrap;
		gap: 4px var(--s-3);
	}
	.new-key {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.seg {
		display: inline-flex;
		margin: var(--s-3) var(--s-5) 0;
		align-self: flex-start;
		border: 1px solid var(--line-2);
		border-radius: var(--r-1);
		overflow: hidden;
	}
	.seg button {
		height: 28px;
		padding: 0 var(--s-3);
		border: 0;
		background: transparent;
		color: var(--tx-mid);
		font: inherit;
		font-size: var(--t-xs);
		cursor: pointer;
		max-width: 220px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.seg button + button {
		border-left: 1px solid var(--line-2);
	}
	.seg button:hover {
		background: var(--s3);
		color: var(--tx-hi);
	}
	.seg button.is-on {
		background: var(--s4);
		color: var(--tx-hi);
		font-weight: 600;
	}
	.sheet-bd {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: var(--s-3) var(--s-5) var(--s-5);
	}
	.day + .day {
		margin-top: var(--s-4);
	}
	.day-hd {
		position: sticky;
		top: calc(-1 * var(--s-3));
		z-index: 1;
		margin: 0 calc(-1 * var(--s-5));
		padding: var(--s-2) var(--s-5) 6px;
		background: var(--bg);
		border-bottom: 1px solid var(--line-2);
		font-size: var(--t-xs);
		font-weight: 600;
		color: var(--tx-mid);
	}
	.grp {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.gi {
		display: flex;
		gap: var(--s-3);
		padding: 10px 0;
		border-bottom: 1px solid var(--line);
	}
	.gi:last-child {
		border-bottom: 0;
	}
	.gi-mark {
		flex: none;
		padding-top: 6px;
	}
	.gi-bd {
		flex: 1;
		min-width: 0;
	}
	.gi-top {
		display: flex;
		align-items: baseline;
		gap: var(--s-2);
		font-size: var(--t-sm);
	}
	.gi-top :global(.id) {
		flex: none;
	}
	.gi-title {
		flex: 1;
		min-width: 0;
		color: var(--tx-hi);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.gi-title:hover {
		text-decoration: underline;
		text-decoration-color: var(--em-500);
	}
	.gi-when {
		flex: none;
		font-size: var(--t-xs);
		color: var(--tx-dim);
	}
	.gi-what {
		margin-top: 3px;
		font-size: var(--t-xs);
		color: var(--tx-mid);
		line-height: 1.5;
	}
	.gi-proj {
		color: var(--tx-dim);
	}
	.gi-who {
		color: var(--tx);
		font-weight: 500;
	}
	.gi-n {
		color: var(--tx-dim);
	}
	.gi.is-new .gi-title {
		font-weight: 600;
	}
	.linkish {
		border: 0;
		background: none;
		padding: 0;
		font: inherit;
		color: var(--em-400);
		cursor: pointer;
		text-decoration: underline;
	}
	.sheet-ft {
		white-space: nowrap;
		display: flex;
		align-items: center;
		gap: var(--s-3);
		flex: none;
		padding: var(--s-3) var(--s-5);
		border-top: 1px solid var(--line);
	}
	.faint {
		color: var(--tx-dim);
	}
	.is-spinning :global(svg) {
		animation: sheet-spin 0.9s linear infinite;
	}
	@keyframes sheet-spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.is-spinning :global(svg) {
			animation: none;
		}
	}
</style>
