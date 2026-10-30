<script lang="ts">
	/**
	 * The agent column beside an issue on wide screens: one
	 * button per intent, and the latest thread about this issue live, so the
	 * conversation sits next to what it is about. Narrower screens use the
	 * agent dialog instead.
	 */
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import HammerIcon from '@lucide/svelte/icons/hammer';
	import MessageSquareIcon from '@lucide/svelte/icons/message-square';
	import PencilLineIcon from '@lucide/svelte/icons/pencil-line';
	import AgentThread from '$lib/components/agent-thread.svelte';
	import { AGENT_INTENTS, intentAllowed, type AgentIntent } from '$lib/client/agent';
	import { currentProject } from '$lib/client/projects.svelte';
	import { app_state } from '$lib/client/stores.svelte';
	import type { IssueSummary, Mission } from '$lib/types';

	interface Props {
		project_id: string;
		issue: IssueSummary;
		missions?: Promise<{ missions: Mission[]; error: string | null }>;
	}

	let { project_id, issue, missions }: Props = $props();

	const ICONS = {
		discuss: MessageSquareIcon,
		elaborate: PencilLineIcon,
		close: CircleCheckIcon,
		tackle: HammerIcon
	} as const;

	const allow = $derived(currentProject()?.allow);

	function ask(intent: AgentIntent) {
		app_state.openAgent({ project_id, issue_id: issue.id, issue_title: issue.title, intent });
	}
</script>

<aside class="iap" aria-label="Agent">
	<div class="iap-acts" role="group" aria-label="Ask an agent">
		{#each AGENT_INTENTS as entry (entry.id)}
			{@const Icon = ICONS[entry.id]}
			<button
				class="btn btn-sm"
				type="button"
				disabled={!intentAllowed(entry.id, allow)}
				title={entry.hint}
				onclick={() => ask(entry.id)}
			>
				<Icon size={13} strokeWidth={1.4} aria-hidden="true" />{entry.label}
			</button>
		{/each}
	</div>
	{#if missions}
		{#await missions then state}
			{@const latest = state.missions.find((mission) => mission.issue_id === issue.id)}
			{#if latest}
				<div class="iap-thread">
					{#key latest.id}
						<AgentThread {project_id} request_id={latest.id} initial={latest} />
					{/key}
				</div>
			{:else}
				<p class="hint">No agent has worked on this issue yet.</p>
			{/if}
		{/await}
	{/if}
</aside>

<style>
	.iap {
		display: flex;
		flex-direction: column;
		gap: var(--s-3);
		position: sticky;
		top: calc(var(--topbar-h) + var(--s-4));
		height: calc(100dvh - var(--topbar-h) - var(--s-4) - var(--main-pad-bottom));
		min-height: 360px;
		border-left: 1px solid var(--line);
		padding-left: var(--s-4);
	}
	.iap-acts {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 6px;
	}
	.iap-acts .btn {
		justify-content: flex-start;
	}
	.iap-thread {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
	}
</style>
