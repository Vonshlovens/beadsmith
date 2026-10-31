<script lang="ts">
	import { resolve } from '$app/paths';
	import markDark from '#lib/assets/mark-dark.png';
	import markLight from '#lib/assets/mark-light.png';
	import { REPO_URL } from '#lib/site.js';
	import AppearanceToggle from './AppearanceToggle.svelte';
</script>

<header>
	<table class="masthead">
		<tbody>
			<tr>
				<td rowspan="3" class="brand-cell">
					<a href={resolve('/')} class="brand">
						<img class="mark mark-light" src={markLight} alt="" width="44" height="44" />
						<img class="mark mark-dark" src={markDark} alt="" width="44" height="44" />
						<span>
							<span class="name">Beadsmith</span>
							<span class="tagline">a web UI for Beads</span>
						</span>
					</a>
				</td>
				<th>Docs</th>
				<td><a href={resolve('/docs')}>read</a></td>
			</tr>
			<tr>
				<th>Source</th>
				<td><a href={REPO_URL}>github</a></td>
			</tr>
			<tr>
				<th>Appearance</th>
				<td><AppearanceToggle /></td>
			</tr>
		</tbody>
	</table>
</header>

<style>
	.masthead {
		margin-bottom: calc(var(--lh) * 3);
	}

	.masthead th {
		width: 0;
		white-space: nowrap;
		color: var(--ink-muted);
	}

	.masthead td:not(.brand-cell) {
		width: 0;
		white-space: nowrap;
		text-align: right;
	}

	.brand-cell {
		vertical-align: middle;
	}

	.brand {
		display: inline-flex;
		align-items: center;
		gap: 1.5ch;
		color: var(--ink);
		text-decoration: none;
	}

	.brand:hover .name {
		color: var(--mark);
	}

	.mark {
		display: block;
		width: calc(var(--lh) * 2);
		height: calc(var(--lh) * 2);
		flex-shrink: 0;
	}

	.mark-dark,
	:global(.dark) .mark-light {
		display: none;
	}

	:global(.dark) .mark-dark {
		display: block;
	}

	.name {
		display: block;
		font-weight: 800;
		font-size: 1.25rem;
	}

	.tagline {
		display: block;
		color: var(--ink-muted);
	}

	/* Narrow: the brand on its own line, then label/value pairs. */
	@media (max-width: 640px) {
		.masthead,
		.masthead tbody {
			display: block;
		}

		.masthead tr {
			display: grid;
			grid-template-columns: 12ch minmax(0, 1fr);
		}

		.masthead th,
		.masthead td {
			display: block;
			width: auto;
			padding: 0;
			border: 0;
		}

		.masthead td:not(.brand-cell) {
			text-align: left;
		}

		.brand-cell {
			grid-column: 1 / -1;
			margin-bottom: var(--lh);
		}

		.masthead tr:last-child {
			padding-bottom: calc(var(--lh) / 2);
			border-bottom: var(--border) solid var(--rule);
		}
	}
</style>
