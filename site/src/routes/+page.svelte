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
			title: 'Agents write, Beadsmith reads',
			body: 'Beadsmith never runs bd or writes issue rows. It reads with SELECT; agents it launches change Beads with bd, like any contributor.',
			href: doc('contract')
		},
		{
			title: 'Todos and saved views',
			body: 'A private agenda for each admin, and project filters saved as views you can publish to members.',
			href: doc('views')
		},
		{
			title: 'Missions',
			body: 'Send an issue to an agent to discuss, elaborate, close or tackle it, on your own webhook runner or on Sand. Needs a runtime.',
			href: doc('agents')
		},
		{
			title: 'First Mate',
			body: 'One orchestrator agent you chat with. On Sand it reads projects, routes todos, starts missions and remembers across chats. Needs a runtime.',
			href: doc('first-mate')
		},
		{
			title: 'Sand and agent terminals',
			body: 'Each mission or chat in its own E2B sandbox, keys kept outside it. Agents run in an hc terminal admins can watch or take over.',
			href: doc('sand')
		},
		{
			title: 'Grown views, surfaces and apps',
			body: 'Dashboards and sandboxed no-network apps First Mate builds, run as the viewer and private until an admin publishes. \\ asks for a code change instead.',
			href: doc('views')
		},
		{
			title: 'Loops and automations',
			body: 'ralph loop missions you steer and stop from the thread, and saved launches on a cron schedule.',
			href: doc('overview') + '#agents'
		},
		{
			title: 'Accounts and backups',
			body: 'Email and password sign-in with admin and member roles; scheduled, optionally encrypted dumps to any S3-compatible bucket.',
			href: doc('backups')
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
│ state.db: │                        │ one database per │
│ todos,    │                        │ Beads project    │
│ chats,    │                        └──────────────────┘
│ views     │                                  ▲
└─────┬─────┘                                  │ bd
      │ missions, First Mate chats             │
      │ (optional)                             │
      ▼                                        │
┌──────────────────────────────┐               │
│ agent runtime: Sand (E2B) or │ ──────────────┘
│ your own webhook/mate runner │
└──────────────────────────────┘`;
</script>

<Head
	title="Beadsmith: a web UI and agent launcher for Beads"
	description="Beadsmith reads your Beads issue databases from a Dolt SQL server and shows every project, issue, dependency and recent change in one place, and hands work to agents that change Beads with bd. Open source, self-hosted."
/>

<h1>A web dashboard and agent launcher for Beads</h1>

<p class="lede">
	Beadsmith reads your <a href={BEADS_URL}>Beads</a> issue databases from a Dolt SQL server and
	shows every project, issue, dependency and recent change in one place, for you and the people you
	work with, and hands work to agents: missions, loops, schedules, and First Mate, an orchestrator
	you chat with. Agents change Beads with <code>bd</code>; Beadsmith itself only reads.
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
	Captured from the quickstart's sample projects. The quickstart has no agent runtime, so First Mate
	says no model is connected.
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
	aria-label="People use Beadsmith in a browser. Beadsmith reads the Dolt sql-server with a read-only account and keeps its own state (todos, chats, views) in a local database. People and agents write to Dolt with bd. Optionally, Beadsmith sends missions and First Mate chats to an agent runtime, Sand or your own runner, whose agents use bd.">{diagram}</pre>

<p>
	Beads keeps each project's issues in a Dolt database. People and agents change them with
	<code>bd</code>, as they do today. Beadsmith connects to the same sql-server with an account that
	can only read, and shows every database on it.
</p>
<p>
	When an admin sends work to an agent, Beadsmith records the request, checks the arm switch and the
	project's allow-list, and hands it to an agent runtime: Sand, one hosted E2B sandbox per mission
	or chat, or a runner of your own. The agent changes Beads with <code>bd</code> like any other contributor.
	Beadsmith itself has no Beads CLI, no project checkout and no way to write to Beads; what it writes
	is its own state, such as todos, chats and saved views.
</p>
<p>
	Without a runtime you still get every read view, todos, saved views, accounts and backups.
	Missions, First Mate, loops and automations each need the pieces listed in the
	<a href="{doc('overview')}#agents">overview</a>. Still being built: First Mate's per-turn memory
	recall and a page for reviewing its memory.
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
