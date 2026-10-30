<script lang="ts">
	/**
	 * Beads on a thread, ordered by time (specs/01). Agent actors get a
	 * distinct bead so automated work is legible at a glance.
	 */
	import IssueId from '$lib/components/issue-id.svelte';
	import { relativeShort } from '$lib/client/format';
	import type { ActivityEvent } from '$lib/types';

	interface Props {
		events: ActivityEvent[];
		/** Show which project each event came from. */
		show_project?: boolean;
	}

	let { events, show_project = false }: Props = $props();

	const AGENT_HINTS = ['agent', 'claude', 'bot', 'codex', 'copilot'];

	/**
	 * True when the actor looks like an automated agent rather than a person.
	 *
	 * @param actor - Event actor name.
	 */
	function isAgent(actor: string): boolean {
		const name = actor.toLowerCase();
		return AGENT_HINTS.some((hint) => name.includes(hint));
	}

	/**
	 * Map an event type onto one of the status beads.
	 *
	 * @param event_type - Raw event type from the server.
	 * @param actor - Event actor, used to mark agent work.
	 */
	function beadClass(event_type: string, actor: string): string {
		const key = event_type.toLowerCase();
		if (isAgent(actor)) {
			return 'dot-hooked';
		}
		if (key.includes('close')) {
			return 'dot-closed';
		}
		if (key.includes('block')) {
			return 'dot-blocked';
		}
		if (key.includes('start') || key.includes('progress') || key.includes('update')) {
			return 'dot-in_progress';
		}
		return 'dot-open';
	}

	/**
	 * Read an event type as a verb.
	 *
	 * @param event_type - Raw event type from the server.
	 */
	function verb(event_type: string): string {
		return event_type.replace(/[_.]/g, ' ').toLowerCase();
	}
</script>

<ul class="feed">
	{#each events as event, index (`${event.project_id}:${event.issue_id}:${event.created_at}:${index}`)}
		<li class="fitem">
			<i class="dot {beadClass(event.event_type, event.actor)}" aria-hidden="true"></i>
			<span class="tm mono-num">{relativeShort(event.created_at)}</span>
			<span class="who">{event.actor}</span>
			<span class="verb">{verb(event.event_type)}</span>
			<IssueId
				id={event.issue_id}
				href="/p/{event.project_id}/i/{event.issue_id}"
				abbreviate={!show_project}
			/>
			<span class="ti">
				{#if show_project}<span class="proj"
						>{event.project_name} ·
					</span>{/if}{event.issue_title ?? ''}
			</span>
		</li>
	{/each}
</ul>

<style>
	.feed {
		position: relative;
		padding-left: 20px;
	}
	.feed::before {
		content: '';
		position: absolute;
		left: 3px;
		top: 8px;
		bottom: 12px;
		width: 1px;
		background: var(--line);
	}
	.fitem {
		position: relative;
		padding: 9px 0 10px;
		border-bottom: 1px solid var(--line);
		font-size: var(--t-xs);
		line-height: 1.55;
	}
	.fitem:last-child {
		border-bottom: 0;
	}
	.fitem > :global(.dot) {
		position: absolute;
		left: -20px;
		top: 15px;
	}
	.who {
		color: var(--tx-hi);
	}
	.verb {
		color: var(--tx-mid);
	}
	.ti {
		display: block;
		color: var(--tx-mid);
		margin-top: 3px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tm {
		float: right;
		color: var(--tx-faint);
		margin-left: 8px;
	}
	.proj {
		color: var(--tx-faint);
	}
</style>
