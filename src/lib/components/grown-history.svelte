<script lang="ts">
	/**
	 * A grown thing's history for its owner (ADR-0025 rules 8 and 9), newest
	 * first: who wrote each revision (a person or First Mate), what a revert
	 * copied, which one is current and which one members see, with publish
	 * and revert per revision. Views and surfaces share it, so both kinds
	 * read and act the same way.
	 */
	import ArrowCounterClockwiseIcon from 'phosphor-svelte/lib/ArrowCounterClockwiseIcon';
	import EyeIcon from 'phosphor-svelte/lib/EyeIcon';
	import RobotIcon from 'phosphor-svelte/lib/RobotIcon';
	import { absoluteStamp, relativeShort } from '#lib/client/format.js';
	import { tip } from '#lib/client/tooltip.js';
	import type { GrownRevisionView } from '#lib/grown.js';

	interface Props {
		revisions: GrownRevisionView<unknown>[];
		busy: boolean;
		/** What a revert copies forward, for its tooltip. */
		revert_help: string;
		onrevert: (number: number) => void;
		onpublish: (number: number) => void;
	}

	let { revisions, busy, revert_help, onrevert, onpublish }: Props = $props();

	const latest = $derived(revisions[0]?.number);
</script>

<section class="sec" aria-labelledby="grown-history">
	<div class="sec-hd">
		<h2 class="lbl" id="grown-history">History</h2>
		<span class="rule"></span>
		<span class="meta">newest first</span>
	</div>
	{#if revisions.length === 0}
		<p class="hint">The history could not be loaded. Refresh to try again.</p>
	{:else}
		<ol class="panel revs">
			{#each revisions as rev (rev.number)}
				<li class="rev">
					<span class="rev-n mono-num">r{rev.number}</span>
					<span class="rev-what">
						<span class="rev-name">{rev.name}</span>
						<span class="rev-how">
							{#if rev.author_kind === 'first_mate'}
								<span class="v-mate"><RobotIcon size={12} aria-hidden="true" />First Mate</span>
							{:else}
								You
							{/if}
							{#if rev.reverted_from !== undefined}
								· reverted to r{rev.reverted_from}
							{/if}
						</span>
					</span>
					<span class="rev-when mono-num" {@attach tip(absoluteStamp(rev.created_at))}
						>{relativeShort(rev.created_at)}</span
					>
					<span class="rev-tags">
						{#if rev.number === latest}
							<span class="badge badge-closed">Current</span>
						{/if}
						{#if rev.published}
							<span class="badge badge-open"
								><i class="dot dot-open" aria-hidden="true"></i>Published</span
							>
						{/if}
					</span>
					<span class="rev-acts">
						{#if !rev.published}
							<button
								class="btn btn-sm btn-ghost"
								type="button"
								disabled={busy}
								aria-label="Publish r{rev.number}"
								onclick={() => onpublish(rev.number)}
							>
								<EyeIcon size={13} aria-hidden="true" />Publish
							</button>
						{/if}
						{#if rev.number !== latest}
							<button
								class="btn btn-sm btn-ghost"
								type="button"
								disabled={busy}
								aria-label="Revert to r{rev.number}"
								{@attach tip(revert_help)}
								onclick={() => onrevert(rev.number)}
							>
								<ArrowCounterClockwiseIcon size={13} aria-hidden="true" />Revert
							</button>
						{/if}
					</span>
				</li>
			{/each}
		</ol>
	{/if}
</section>

<style>
	.sec-hd h2.lbl {
		margin: 0;
	}
	.v-mate {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		color: var(--violet-tx);
	}
	.revs {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.rev {
		display: grid;
		grid-template-columns: 3em minmax(0, 1fr) 4em auto auto;
		align-items: center;
		gap: var(--s-3);
		min-height: 44px;
		padding: 4px var(--s-3) 4px var(--s-4);
		border-bottom: 1px solid var(--line);
		font-size: var(--t-xs);
	}
	.rev:last-child {
		border-bottom: 0;
	}
	.rev:hover,
	.rev:focus-within {
		background: var(--s3);
	}
	.rev-n {
		color: var(--tx-dim);
	}
	.rev-what {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
	}
	.rev-name {
		color: var(--tx-hi);
		font-size: var(--t-sm);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.rev-how,
	.rev-when {
		color: var(--tx-dim);
	}
	.rev-when {
		text-align: right;
	}
	.rev-tags,
	.rev-acts {
		display: inline-flex;
		gap: var(--s-2);
		justify-content: flex-end;
	}
	@media (max-width: 720px) {
		.rev {
			grid-template-columns: 3em minmax(0, 1fr) auto;
			row-gap: 4px;
			padding: 8px var(--s-3);
		}
		.rev-tags {
			grid-column: 2;
			justify-content: flex-start;
		}
		.rev-acts {
			grid-column: 2 / -1;
			justify-content: flex-start;
		}
	}
</style>
