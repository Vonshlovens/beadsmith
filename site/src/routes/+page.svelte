<script lang="ts">
	import { resolve } from '$app/paths';
	import Head from '#lib/components/Head.svelte';
	import Shot from '#lib/components/Shot.svelte';
	import { parade_shot, view_shots } from '#lib/shots.js';
	import { BEADS_URL, REPO_URL } from '#lib/site.js';

	const doc = (slug: string) => resolve('/docs/[slug]', { slug });

	const features = [
		{
			title: 'Every project at once',
			body: 'Parade, list and board views per project, a Ready deck of unblocked work across all of them, and an activity log.',
			href: doc('overview')
		},
		{
			title: 'Read-only by design',
			body: 'Beadsmith never runs bd or writes issue rows. It needs SELECT on your Dolt server and nothing else.',
			href: doc('contract')
		},
		{
			title: 'Accounts',
			body: 'Email and password sign-in with admin and member roles. Sign-up stays closed unless an admin opens it.',
			href: doc('overview') + '#accounts'
		},
		{
			title: 'Backups',
			body: 'Scheduled dumps of every project to any S3-compatible bucket, optionally encrypted with your passphrase.',
			href: doc('backups')
		},
		{
			title: 'Agents, optionally',
			body: 'Send an issue to an agent to discuss, elaborate, close or tackle it, through any runner that accepts a signed webhook.',
			href: doc('agents')
		},
		{
			title: 'Keyboard first',
			body: 'Press ? on any page for the keys it answers. Usable at phone width.',
			href: doc('keyboard')
		}
	];

	const diagram = `   people                              people and agents
      │ browser                                │ bd
      ▼                                        ▼
┌───────────┐     read-only SQL      ┌──────────────────┐
│ Beadsmith │ ─────────────────────▶ │ Dolt sql-server  │
└─────┬─────┘                        │ one database per │
      │                              │ Beads project    │
      │ signed webhook               └──────────────────┘
      │ (optional)                             ▲
      ▼                                        │ bd
┌─────────────┐                                │
│ your runner │ ──── starts an agent ──────────┘
└─────────────┘`;
</script>

<Head
	title="Beadsmith: a web UI for Beads"
	description="Beadsmith reads your Beads issue databases from a Dolt SQL server and shows every project, issue, dependency and recent change in one place. Open source, self-hosted."
/>

<h1>A web dashboard for Beads</h1>

<p class="lede">
	Beadsmith reads your <a href={BEADS_URL}>Beads</a> issue databases from a Dolt SQL server and
	shows every project, issue, dependency and recent change in one place, for you and the people you
	work with. Agents keep doing the work with <code>bd</code>; Beadsmith only reads.
</p>

<table class="facts">
	<tbody>
		<tr>
			<th>Status</th>
			<td>
				<span class="bead rolling" aria-hidden="true"></span> Early. No versioned releases yet:
				<code>main</code> is what ships, and anything can change.
			</td>
		</tr>
		<tr>
			<th>Reads</th>
			<td>Beads databases on a Dolt sql-server, written by bd 1.1 to 1.3</td>
		</tr>
		<tr>
			<th>Runs</th>
			<td>On your own machine or server, with Docker Compose or NixOS</td>
		</tr>
		<tr>
			<th>Try it</th>
			<td>Two commands and a sample dataset: <a href="#try-it">quickstart</a></td>
		</tr>
		<tr>
			<th>License</th>
			<td>MIT, <a href={REPO_URL}>source on GitHub</a></td>
		</tr>
	</tbody>
</table>

<Shot shot={parade_shot} n={1} eager class="wide hero" />

<h2>What's in it<span class="count">{features.length}</span></h2>

<ol class="index-list">
	{#each features as feature, i (feature.title)}
		<li>
			<span class="n">{String(i + 1).padStart(2, '0')}</span>
			<span>
				<a class="title" href={feature.href}>{feature.title}</a>
				<span class="body">{feature.body}</span>
			</span>
		</li>
	{/each}
</ol>

<h2>Views<span class="count">{view_shots.length}</span></h2>

<p class="muted">
	The UI is still moving, so these are sketches until it settles. Figure 1 is a real capture.
</p>

<div class="shot-grid wide">
	{#each view_shots as shot, i (shot.id)}
		<Shot {shot} n={i + 2} />
	{/each}
</div>

<h2>How it fits</h2>

<pre
	class="diagram"
	role="img"
	aria-label="People use Beadsmith in a browser. Beadsmith reads the Dolt sql-server with a read-only account. People and agents write to Dolt with bd. Optionally, Beadsmith sends a signed webhook to your runner, which starts an agent that uses bd.">{diagram}</pre>

<p>
	Beads keeps each project's issues in a Dolt database. People and agents change them with
	<code>bd</code>, as they do today. Beadsmith connects to the same sql-server with an account that
	can only read, and shows every database on it.
</p>
<p>
	When an admin sends an issue to an agent, Beadsmith records the request and hands it to your
	runner over a signed webhook. The agent then changes Beads with <code>bd</code> like any other contributor.
	Beadsmith itself has no Beads CLI, no project checkout and no way to write to Beads.
</p>

<h2 id="try-it">Try it</h2>

<p>You need Docker with Compose v2.</p>

<pre>git clone {REPO_URL}
cd beadsmith
docker compose -f quickstart/compose.yaml up -d --build --wait
docker compose -f quickstart/compose.yaml exec beadsmith cat /state/setup-token</pre>

<p>
	Open <code>http://localhost:4321</code>, paste the token and create your admin account. Three
	sample projects (<code>lighthouse</code>, <code>pantry</code>, <code>trailhead</code>) are
	waiting, with a few weeks of made-up history and two agents mid-task.
</p>
<p>
	Everything stays on your machine: Beadsmith listens on <code>127.0.0.1</code> only, Dolt is not published
	at all, and every secret is generated on first start. The first start builds the image, usually one
	to three minutes.
</p>
<p>
	Then point it at your own projects: <a href="{doc('overview')}#use-your-own-beads-projects"
		>use your own Beads projects</a
	>.
</p>

<style>
	.facts {
		margin-top: var(--lh);
	}

	:global(.hero) {
		margin-top: calc(var(--lh) * 2);
	}

	.shot-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 26rem), 1fr));
		gap: 0 3ch;
	}

	.diagram {
		background: var(--paper-2);
		color: var(--ink);
		border-color: var(--rule-faint);
		line-height: 1.3;
	}
</style>
