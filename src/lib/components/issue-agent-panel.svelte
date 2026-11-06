<script lang="ts">
	/**
	 * The agent column beside an issue on wide screens: one
	 * button per intent, and the latest thread about this issue live, so the
	 * conversation sits next to what it is about. Narrower screens use the
	 * agent dialog instead.
	 */
	import { tip } from '#lib/client/tooltip.js';
	import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircleIcon';
	import HammerIcon from 'phosphor-svelte/lib/HammerIcon';
	import ChatTextIcon from 'phosphor-svelte/lib/ChatTextIcon';
	import PencilLineIcon from 'phosphor-svelte/lib/PencilLineIcon';
	import AgentThread from '#lib/components/agent-thread.svelte';
	import { AGENT_INTENTS, intentAllowed, type AgentIntent } from '#lib/client/agent.js';
	import { currentProject } from '#lib/client/projects.svelte.js';
	import { app_state } from '#lib/client/stores.svelte.js';
	import type { IssueSummary, Mission } from '#lib/types.js';

	interface Props {
		project_id: string;
		issue: IssueSummary;
		missions?: Promise<{ missions: Mission[]; error: string | null }>;
	}

	let { project_id, issue, missions }: Props = $props();

	const ICONS = {
		discuss: ChatTextIcon,
		elaborate: PencilLineIcon,
		close: CheckCircleIcon,
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
				{@attach tip(entry.hint)}
				onclick={() => ask(entry.id)}
			>
				<Icon size={13} aria-hidden="true" />{entry.label}
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
