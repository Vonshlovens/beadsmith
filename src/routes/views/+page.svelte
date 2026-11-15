<script lang="ts">
	/**
	 * Saved views and catalog surfaces (ADR-0025 rule 9): each row answers
	 * "what does this show, who wrote it, and who can see it". An admin sees
	 * their own and every published one; a member sees only published ones.
	 * Both kinds share one list, newest change first, since both open at
	 * /views/<slug>, where the owner reverts, publishes and deletes them.
	 */
	import { refreshAll } from '$app/navigation';
	import RobotIcon from 'phosphor-svelte/lib/RobotIcon';
	import EmptyState from '#lib/components/empty-state.svelte';
	import PageHeader from '#lib/components/page-header.svelte';
	import ViewStateBadge from '#lib/components/view-state-badge.svelte';
	import { relativeShort } from '#lib/client/format.js';
	import { useHotkeys } from '#lib/client/hotkeys.svelte.js';
	import { stepFocus } from '#lib/client/list-focus.js';
	import { currentViewer, projectList } from '#lib/client/projects.svelte.js';
	import { tip } from '#lib/client/tooltip.js';
	import { describeSurfaceSpec } from '#lib/client/surfaces.js';
	import { describeViewSpec } from '#lib/client/views.js';
	import type { GrownSummary } from '#lib/grown.js';
	import { PRODUCT_NAME } from '#lib/product.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let list_el = $state<HTMLUListElement | null>(null);
	let refreshing = $state(false);

	const is_admin = $derived(currentViewer()?.role === 'admin');
	const names = $derived(new Map(projectList().map((p) => [p.id, p.name])));
	const projectName = (id: string) => names.get(id) ?? id;
	interface Row {
		thing: GrownSummary<unknown>;
		/** The project or scope, or "Surface". */
		where: string;
		what: string;
	}

	const rows = $derived(
		[
			...data.views.map((view): Row => {
				const [where, ...what] = describeViewSpec(view.spec, projectName);
				return { thing: view, where, what: view.description || what.join(' · ') };
			}),
			...data.surfaces.map((surface): Row => ({
				thing: surface,
				where: 'Surface',
				what: surface.description || describeSurfaceSpec(surface.spec)
			}))
		].sort(
			(a, b) =>
				b.thing.updated_at.localeCompare(a.thing.updated_at) ||
				a.thing.slug.localeCompare(b.thing.slug)
		)
	);
	const mine = $derived(rows.filter((row) => row.thing.mine).length);
	const meta = $derived(
		[String(rows.length), is_admin && mine > 0 ? `${mine} yours` : ''].filter(Boolean).join(' · ')
	);

	async function refresh() {
		refreshing = true;
		try {
			await refreshAll();
		} finally {
			refreshing = false;
		}
	}

	useHotkeys(() => [
		{
			keys: ['j', 'ArrowDown'],
			label: 'Next view',
			group: 'Lists',
			run: () => stepFocus(list_el, 'a.v-main', 1)
		},
		{
			keys: ['k', 'ArrowUp'],
			label: 'Previous view',
			group: 'Lists',
			run: () => stepFocus(list_el, 'a.v-main', -1)
		}
	]);
</script>

<svelte:head><title>Views · {PRODUCT_NAME}</title></svelte:head>

<div class="wrap is-wide views">
	<PageHeader
		title="Views"
		{meta}
		meta_label="{rows.length} views and surfaces{is_admin ? `, ${mine} of them yours` : ''}"
		onrefresh={refresh}
		{refreshing}
	/>

	{#each [{ what: 'Views', message: data.error }, { what: 'Surfaces', message: data.surfaces_error }] as failed (failed.what)}
		{#if failed.message}
			<div class="banner banner-err" role="alert">
				<i class="dot dot-blocked" style="margin-top:5px" aria-hidden="true"></i>
				<div class="banner-bd">
					<b>{failed.what} could not be loaded.</b>
					<div class="mt-2">{failed.message}</div>
				</div>
				<div class="banner-acts">
					<button class="btn btn-sm" type="button" onclick={refresh}>Retry now</button>
				</div>
			</div>
		{/if}
	{/each}
	{#if data.error && data.surfaces_error}
		<!-- Both lists failed; the banners say so, and nothing here is an empty catalogue. -->
	{:else if rows.length === 0}
		<EmptyState
			title="No saved views yet"
			description={is_admin
				? 'A view is a named filter of issues, shown as a list or a board. A surface is a dashboard First Mate builds from tiles, lists, boards and charts. Both stay private until you publish them.'
				: 'Views and dashboards an admin publishes show up here.'}
		>
			{#snippet actions()}
				<a class="btn btn-sm" href="/projects">Open projects</a>
			{/snippet}
		</EmptyState>
	{:else}
		<ul class="list panel" aria-label="Saved views and surfaces" bind:this={list_el}>
			{#each rows as { thing: view, where, what } (view.slug)}
				<li class="v-row">
					<a class="v-main" href="/views/{view.slug}">
						<span class="v-name">{view.name}</span>
						<span class="v-what">{what}</span>
					</a>
					<span class="v-proj">{where}</span>
					<span class="v-by">
						{#if view.author_kind === 'first_mate'}
							<span class="v-mate" {@attach tip('First Mate wrote the revision shown')}
								><RobotIcon size={12} aria-hidden="true" />First Mate</span
							>
						{:else}
							{view.mine ? 'You' : 'An admin'}
						{/if}
					</span>
					<span class="v-when mono-num" {@attach tip(view.updated_at)}
						>{relativeShort(view.updated_at)}</span
					>
					<span class="v-state"><ViewStateBadge {view} /></span>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.views {
		max-width: 1480px;
	}
	.list {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.v-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 12em) minmax(0, 8em) 4em 8.5em;
		align-items: center;
		gap: var(--s-3);
		min-height: 44px;
		padding: 4px var(--s-3) 4px var(--s-4);
		border-bottom: 1px solid var(--line);
		font-size: var(--t-xs);
	}
	.v-row:last-child {
		border-bottom: 0;
	}
	.v-row:hover,
	.v-row:focus-within {
		background: var(--s3);
	}
	.v-main {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
		color: inherit;
		outline: none;
	}
	.v-main:hover {
		text-decoration: none;
	}
	.v-main:hover .v-name {
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.v-main:focus-visible {
		box-shadow: -2px 0 0 var(--em-500);
	}
	.v-name {
		color: var(--tx-hi);
		font-size: var(--t-sm);
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.v-what,
	.v-proj,
	.v-by {
		color: var(--tx-dim);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.v-proj {
		color: var(--tx-mid);
	}
	.v-mate {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		color: var(--violet-tx);
	}
	.v-when {
		color: var(--tx-dim);
		text-align: right;
	}
	.v-state {
		justify-self: end;
	}
	@media (max-width: 860px) {
		.v-row {
			grid-template-columns: minmax(0, 1fr) auto auto;
			row-gap: 4px;
			padding: 8px var(--s-3);
		}
		.v-main {
			grid-column: 1 / -1;
		}
		.v-proj {
			grid-column: 1;
		}
		.v-by {
			display: none;
		}
	}
</style>
