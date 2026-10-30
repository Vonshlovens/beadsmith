<script lang="ts">
	/**
	 * Render canonical mission events. The browser never
	 * receives raw runner payloads — only this union.
	 */
	import { reduceMissionEvents, type MissionEvent } from '$lib/mission-events';

	interface Props {
		events: MissionEvent[];
		pending?: boolean;
		error?: string | null;
	}

	let { events, pending = false, error = null }: Props = $props();

	const turns = $derived(reduceMissionEvents(events));
</script>

<ol class="stream" aria-live="polite">
	{#each turns as event (event.id)}
		<li class="evt evt-{event.type}">
			{#if event.type === 'user'}
				<div class="lbl">Operator</div>
				<p>{event.text}</p>
			{:else if event.type === 'assistant'}
				<div class="lbl">Assistant</div>
				<p>{event.text}</p>
			{:else if event.type === 'thinking'}
				<div class="lbl">Thinking</div>
				<p class="dim">{event.text}</p>
			{:else if event.type === 'tool_call'}
				<div class="lbl">Tool</div>
				<p>
					<code>{event.name}</code>
					<span class="status">{event.status}</span>
					{#if event.truncated}<span class="dim">truncated</span>{/if}
				</p>
			{:else if event.type === 'result'}
				<div class="lbl">Result</div>
				<p>
					<span class="status">{event.status}</span>
					{#if event.duration_ms !== undefined}
						<span class="dim">{event.duration_ms} ms</span>
					{/if}
				</p>
				{#if event.text}
					<p>{event.text}</p>
				{/if}
				{#if event.git_pr_url}
					<p>
						<a href={event.git_pr_url} target="_blank" rel="noopener noreferrer">Pull request</a>
					</p>
				{/if}
			{:else if event.type === 'error'}
				<div class="lbl">Error</div>
				<p class="err">{event.message}</p>
			{/if}
		</li>
	{/each}
</ol>
{#if pending}
	<p class="hint">Listening for stream events…</p>
{/if}
{#if error}
	<p class="err" role="status">{error}</p>
{/if}
{#if !pending && turns.length === 0 && !error}
	<p class="hint">No stream events yet.</p>
{/if}

<style>
	.stream {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--s-3);
	}
	.evt {
		padding-bottom: var(--s-3);
		border-bottom: 1px solid var(--line);
	}
	.evt:last-child {
		padding-bottom: 0;
		border-bottom: 0;
	}
	.lbl {
		font-size: var(--t-xs);
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--tx-dim);
		margin-bottom: 4px;
	}
	.evt p {
		margin: 0;
		font-size: var(--t-sm);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.dim {
		color: var(--tx-dim);
	}
	.status {
		font-size: var(--t-xs);
		color: var(--tx-mid);
	}
	.err {
		font-size: var(--t-xs);
		color: var(--em-300);
	}
	.hint {
		margin: var(--s-2) 0 0;
		font-size: var(--t-xs);
		color: var(--tx-dim);
	}
	code {
		font-family: var(--font-mono);
		font-size: var(--t-xs);
	}
</style>
