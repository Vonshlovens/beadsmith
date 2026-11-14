<script lang="ts">
	/**
	 * Render canonical mission events. The browser never receives raw runner
	 * payloads, only this union. It reads like the First Mate chat: the
	 * agent's words as prose, thinking behind a disclosure, and each run of
	 * tool calls folded into one line (chips when short, a count that opens
	 * when long), so a long, noisy run stays readable.
	 *
	 * Not a live region: every delta would be read out. The thread announces
	 * status changes instead (agent-thread.svelte).
	 */
	import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon';
	import GitPullRequestIcon from 'phosphor-svelte/lib/GitPullRequestIcon';
	import WarningCircleIcon from 'phosphor-svelte/lib/WarningCircleIcon';
	import MarkdownBody from '#lib/components/markdown-body.svelte';
	import MissionStatus from '#lib/components/mission-status.svelte';
	import { formatElapsed, isSafeRunUrl } from '#lib/client/agent.js';
	import { TOOL_RUN_FOLD, toolRunSummary } from '#lib/client/mate-chat.js';
	import {
		groupMissionEvents,
		type MissionEvent,
		type MissionToolCallStatus
	} from '#lib/mission-events.js';

	interface Props {
		events: MissionEvent[];
		pending?: boolean;
		error?: string | null;
		/** The connection dropped and the browser is retrying on its own. */
		reconnecting?: boolean;
		/** Offered beside `error`: open the stream again. */
		onreconnect?: () => void;
	}

	let {
		events,
		pending = false,
		error = null,
		reconnecting = false,
		onreconnect
	}: Props = $props();

	const items = $derived(groupMissionEvents(events));

	/** Tool names named in a folded group's line, as in a First Mate chat. */
	const TALLY_NAMES = 3;

	const TOOL_STATE: Record<MissionToolCallStatus, string> = {
		running: 'in progress',
		completed: 'done',
		failed: 'failed'
	};
</script>

{#snippet chip(call: { name: string; status: MissionToolCallStatus; truncated?: boolean })}
	<li
		class="tool"
		class:is-running={call.status === 'running'}
		class:is-failed={call.status === 'failed'}
	>
		<code>{call.name}</code>
		{#if call.status !== 'completed'}<span class="tool-st" aria-hidden="true"
				>{call.status === 'running' ? 'running' : 'failed'}</span
			>{/if}
		{#if call.truncated}<span class="tool-st">output cut</span>{/if}
		<span class="sr-only">, {TOOL_STATE[call.status]}</span>
	</li>
{/snippet}

<ol class="stream">
	{#each items as item, index (index)}
		<li class="evt">
			{#if item.type === 'user'}
				<details class="fold">
					<summary class="fold-row">
						<CaretRightIcon class="caret" size={11} aria-hidden="true" />
						<span class="fold-lbl">Message sent to the agent</span>
					</summary>
					<p class="fold-body">{item.text}</p>
				</details>
			{:else if item.type === 'assistant'}
				<MarkdownBody source={item.text} class="ev-md" />
			{:else if item.type === 'thinking'}
				<details class="fold">
					<summary class="fold-row">
						<CaretRightIcon class="caret" size={11} aria-hidden="true" />
						<span class="fold-lbl">Thinking</span>
					</summary>
					<p class="fold-body">{item.text}</p>
				</details>
			{:else if item.type === 'tool_group'}
				{#if item.calls.length <= TOOL_RUN_FOLD}
					<ul class="tools" aria-label="Tool calls">
						{#each item.calls as call (call.call_id)}{@render chip(call)}{/each}
					</ul>
				{:else}
					{@const summary = toolRunSummary(item.calls)}
					<details class="fold">
						<summary class="fold-row">
							<CaretRightIcon class="caret" size={11} aria-hidden="true" />
							<span class="fold-lbl">
								<span><span class="mono-num">{item.calls.length}</span> tool calls</span>
								<span class="grp-tally"
									>{summary.counts
										.slice(0, TALLY_NAMES)
										.map((entry) => `${entry.name} ${entry.count}`)
										.join(' · ')}{summary.counts.length > TALLY_NAMES ? ' …' : ''}</span
								>
								{#if summary.failed > 0}<span class="grp-failed"
										><WarningCircleIcon size={12} aria-hidden="true" />{summary.failed} failed</span
									>{/if}
								{#if summary.running}<span class="grp-now"
										><i class="grp-dot" aria-hidden="true"></i><code>{summary.running}</code><span
											class="sr-only">, in progress</span
										></span
									>{/if}
							</span>
						</summary>
						<ul class="tools fold-body" aria-label="Tool calls">
							{#each item.calls as call (call.call_id)}{@render chip(call)}{/each}
						</ul>
					</details>
				{/if}
			{:else if item.type === 'result'}
				<p class="result">
					<span class="lbl">Run</span>
					<MissionStatus status={item.status} />
					{#if item.duration_ms !== undefined}
						<span class="dim mono-num">{formatElapsed(item.duration_ms)}</span>
					{/if}
					{#if isSafeRunUrl(item.git_pr_url)}
						<a
							class="btn btn-sm btn-ghost pr"
							href={item.git_pr_url}
							target="_blank"
							rel="noopener noreferrer"
							><GitPullRequestIcon size={13} aria-hidden="true" />Pull request</a
						>
					{/if}
				</p>
				{#if item.text}
					<MarkdownBody source={item.text} class="ev-md" />
				{/if}
			{:else if item.type === 'error'}
				<p class="err">
					<WarningCircleIcon size={13} aria-hidden="true" /><span>{item.message}</span>
				</p>
			{/if}
		</li>
	{/each}
</ol>
{#if reconnecting}
	<p class="hint" role="status">
		<span class="chat-dots" aria-hidden="true"><i></i><i></i><i></i></span>Live output dropped.
		Reconnecting…
	</p>
{:else if error}
	<p class="err" role="status">
		<WarningCircleIcon size={13} aria-hidden="true" /><span>{error}</span>
		{#if onreconnect}
			<button class="btn btn-sm btn-ghost" type="button" onclick={onreconnect}>Reconnect</button>
		{/if}
	</p>
{:else if pending && items.length === 0}
	<p class="hint">
		<span class="chat-dots" aria-hidden="true"><i></i><i></i><i></i></span>Waiting for the agent's
		first output…
	</p>
{:else if !pending && items.length === 0}
	<p class="hint">No live output from this run.</p>
{/if}

<style>
	.stream {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--s-2);
	}
	.evt {
		min-width: 0;
	}
	.evt :global(.ev-md) {
		max-width: none;
	}
	.evt :global(.ev-md > :first-child) {
		margin-top: 0;
	}
	.evt :global(.ev-md > :last-child) {
		margin-bottom: 0;
	}
	/* Disclosures keep the line's look; the caret and hover say they open,
	   and the row is tall enough to tap. Same as First Mate's crew lines. */
	.fold {
		font-size: var(--t-xs);
		color: var(--tx-dim);
	}
	.fold-row {
		display: flex;
		align-items: center;
		gap: 6px;
		width: fit-content;
		max-width: 100%;
		min-height: 28px;
		margin-left: -4px;
		padding: 0 4px;
		border-radius: var(--r-2);
		list-style: none;
		cursor: pointer;
	}
	.fold-row::-webkit-details-marker {
		display: none;
	}
	.fold-row:hover {
		background: var(--s2);
		color: var(--tx-hi);
	}
	.fold-row :global(.caret) {
		flex: none;
		transition: transform 120ms ease-out;
	}
	.fold[open] > .fold-row :global(.caret) {
		transform: rotate(90deg);
	}
	.fold-lbl {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0 var(--s-2);
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.fold-body {
		margin: 4px 0 var(--s-1) 17px;
	}
	p.fold-body {
		max-height: 16rem;
		overflow: auto;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.grp-failed {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		color: var(--danger-tx);
	}
	.grp-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--tx-hi);
		animation: bdui-pulse 1.2s ease-in-out infinite;
	}
	.grp-tally {
		color: var(--tx-dim);
	}
	.grp-now {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		color: var(--tx-hi);
	}
	/* The agent's own tools: chips, as in a First Mate chat. */
	.tools {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		padding: 0;
		list-style: none;
	}
	ul.tools:not(.fold-body) {
		margin: 0;
	}
	.tool {
		display: inline-flex;
		align-items: baseline;
		gap: 6px;
		min-width: 0;
		max-width: 100%;
		padding: 1px 6px;
		border: 1px solid var(--line);
		border-radius: var(--r-1);
		background: var(--s1);
		color: var(--tx-mid);
		overflow-wrap: anywhere;
	}
	.tool.is-running {
		border-color: var(--line-3);
		color: var(--tx-hi);
	}
	.tool.is-failed {
		border-color: var(--danger-line);
	}
	.tool.is-failed .tool-st {
		color: var(--danger-tx);
	}
	.tool-st {
		font-size: var(--t-xs);
		color: var(--tx-dim);
	}
	code {
		font-family: var(--font-mono);
		font-size: var(--t-xs);
	}
	.result {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-2);
		margin: 0;
		font-size: var(--t-xs);
	}
	.lbl,
	.dim {
		color: var(--tx-dim);
	}
	.pr {
		gap: 5px;
	}
	.err {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		margin: 0;
		font-size: var(--t-xs);
		color: var(--danger-tx);
		overflow-wrap: anywhere;
	}
	.hint {
		margin: var(--s-2) 0 0;
		font-size: var(--t-xs);
		color: var(--tx-dim);
	}
	@media (pointer: coarse) {
		.fold-row,
		.pr,
		.err .btn {
			min-height: 44px;
		}
	}
</style>
