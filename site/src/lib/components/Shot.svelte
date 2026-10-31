<script lang="ts">
	import type { Shot } from '#lib/shots.js';

	interface Props {
		shot: Shot;
		/** Figure number for the caption. */
		n: number;
		eager?: boolean;
		class?: string;
	}

	let { shot, n, eager = false, class: className = '' }: Props = $props();

	const BEADS: Record<string, string> = { r: 'stalled', y: 'rolling', g: 'lined-up' };

	// Split the sketch into text runs and beads; `{g}` and friends stand for one bead.
	const parts = $derived(
		(shot.sketch ?? '')
			.replace(/^\n/, '')
			.split(/(\{[ryg]\})/)
			.map((text) => {
				const bead = /^\{([ryg])\}$/.exec(text);
				return bead ? { bead: BEADS[bead[1]], text: '●' } : { bead: null, text };
			})
	);
</script>

<figure class="shot {className}">
	{#if shot.src}
		<img
			src={shot.src}
			alt={shot.alt}
			width={shot.width}
			height={shot.height}
			loading={eager ? 'eager' : 'lazy'}
			decoding="async"
		/>
	{:else}
		<div class="pending" class:phone={shot.frame === 'phone'} role="img" aria-label={shot.alt}>
			<span class="label">[screenshot pending] {shot.id}</span>
			<pre aria-hidden="true">{#each parts as part, i (i)}{#if part.bead}<span
							class="bead-char {part.bead}">{part.text}</span
						>{:else}{part.text}{/if}{/each}</pre>
		</div>
	{/if}
	<figcaption><span class="fig">fig. {n}</span> {shot.caption}</figcaption>
</figure>

<style>
	.shot {
		margin: 0 0 calc(var(--lh) * 2);
	}

	img {
		display: block;
		width: 100%;
		border: var(--border) solid var(--rule);
	}

	figcaption {
		margin-top: calc(var(--lh) / 2);
		color: var(--ink-muted);
	}

	.fig {
		color: var(--ink);
		font-weight: 700;
		margin-right: 1ch;
	}

	/* Same 16:10 frame as a real capture, with a bead grid where the pixels go. */
	.pending {
		container-type: inline-size;
		display: grid;
		grid-template-rows: auto 1fr;
		justify-items: center;
		align-items: center;
		aspect-ratio: 16 / 10;
		border: var(--border) dashed var(--rule);
		background-color: var(--paper-2);
		background-image: radial-gradient(circle, var(--rule-faint) 1px, transparent 1.5px);
		background-size: 1.5ch 1.5ch;
	}

	/* On a phone a 16:10 frame is too short for the sketch: fit the sketch instead. */
	@media (max-width: 640px) {
		.pending {
			aspect-ratio: auto;
		}
	}

	.label {
		justify-self: start;
		padding: calc(var(--lh) / 4) 1ch;
		color: var(--mark);
		font-size: 0.8125rem;
	}

	/* Sized to the frame: a 46-column sketch fills about three quarters of it. */
	pre {
		margin: 0 0 calc(var(--lh) / 2);
		padding: calc(var(--lh) / 2) 1.5ch;
		overflow: hidden;
		background: var(--paper);
		color: var(--ink-muted);
		border: var(--border) solid var(--rule-faint);
		font-size: clamp(0.4rem, 2.6cqi, 0.8rem);
		line-height: 1.35;
	}

	/* A phone: narrow, tall, rounded the only place on the site. */
	.phone pre {
		border-radius: 1.4em;
		border-width: calc(var(--border) * 2);
		border-color: var(--rule);
		padding: 1.2em 1.5ch 1.6em;
		font-size: clamp(0.35rem, 2.1cqi, 0.7rem);
	}

	.bead-char {
		color: var(--bead-lined-up);
	}

	.bead-char.rolling {
		color: var(--bead-rolling);
	}

	.bead-char.stalled {
		color: var(--bead-stalled);
		text-shadow: var(--glow);
	}
</style>
