<script lang="ts">
	/**
	 * Send one issue to an agent: pick Discuss, Elaborate,
	 * Close or Tackle, add a note, launch, and keep talking in the same dialog.
	 * Opened from anywhere with `app_state.openAgent` (key `a`). Every intent
	 * goes through the dispatch pipeline; this never writes Beads itself.
	 */
	import { toast } from 'svelte-sonner';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import BotIcon from '@lucide/svelte/icons/bot';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import HammerIcon from '@lucide/svelte/icons/hammer';
	import Maximize2Icon from '@lucide/svelte/icons/maximize-2';
	import MessageSquareIcon from '@lucide/svelte/icons/message-square';
	import PencilLineIcon from '@lucide/svelte/icons/pencil-line';
	import XIcon from '@lucide/svelte/icons/x';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import AgentThread from '$lib/components/agent-thread.svelte';
	import IssueId from '$lib/components/issue-id.svelte';
	import MissionStatus from '$lib/components/mission-status.svelte';
	import { api, errorMessage } from '$lib/client/api';
	import {
		AGENT_INTENTS,
		agentAvailability,
		intentAllowed,
		intentInfo,
		missionVerb,
		type AgentIntent
	} from '$lib/client/agent';
	import { relativeShort } from '$lib/client/format';
	import { useHotkeys } from '$lib/client/hotkeys.svelte';
	import { projectList, statusSnapshot } from '$lib/client/projects.svelte';
	import { app_state } from '$lib/client/stores.svelte';
	import type { Mission } from '$lib/types';

	const ICONS = {
		discuss: MessageSquareIcon,
		elaborate: PencilLineIcon,
		close: CircleCheckIcon,
		tackle: HammerIcon
	} as const;

	const target = $derived(app_state.agent_target);
	const open = $derived(target !== null);
	const project = $derived(projectList().find((item) => item.id === target?.project_id));
	const availability = $derived(agentAvailability(statusSnapshot(), project?.allow));

	let intent = $state<AgentIntent>('discuss');
	let message = $state('');
	let submitting = $state(false);
	let thread_id = $state<string | null>(null);
	let history = $state<Mission[]>([]);
	let message_el = $state<HTMLTextAreaElement | null>(null);

	const info = $derived(intentInfo(intent));
	const allowed = $derived(intentAllowed(intent, project?.allow));
	const blocked_reason = $derived.by(() => {
		if (!availability.enabled) {
			return availability.reason ?? 'Agents are unavailable.';
		}
		if (!allowed) {
			return `${info.label} needs Tackle allowed for this project.`;
		}
		return undefined;
	});
	const thread_mission = $derived(history.find((mission) => mission.id === thread_id));
	const page_href = $derived(
		thread_id === null || target === null
			? null
			: `/first-mate?thread=${encodeURIComponent(thread_id)}&project=${encodeURIComponent(target.project_id)}`
	);

	// Reset whenever a new target opens the dialog.
	$effect(() => {
		const next = target;
		if (next === null) {
			return;
		}
		intent = next.intent ?? 'discuss';
		message = '';
		thread_id = next.request_id ?? null;
		history = [];
		const ac = new AbortController();
		api
			.missions(
				{ project_id: next.project_id, issue_id: next.issue_id, limit: 8 },
				{ signal: ac.signal }
			)
			.then((response) => {
				history = response.missions;
			})
			.catch(() => {
				// Earlier threads are a convenience; the dialog works without them.
			});
		return () => ac.abort();
	});

	function onOpenChange(next: boolean) {
		if (!next) {
			app_state.closeAgent();
		}
	}

	function pick(next: AgentIntent) {
		intent = next;
		if (next !== 'tackle') {
			requestAnimationFrame(() => message_el?.focus());
		}
	}

	async function launch() {
		if (target === null || submitting || blocked_reason !== undefined) {
			return;
		}
		submitting = true;
		const note = message.trim();
		try {
			const result =
				intent === 'tackle'
					? await api.tackleIssue(target.project_id, {
							idempotency_key: crypto.randomUUID(),
							issue_id: target.issue_id
						})
					: await api.discussIssue(target.project_id, {
							idempotency_key: crypto.randomUUID(),
							issue_id: target.issue_id,
							intent,
							...(note.length > 0 ? { message: note } : {})
						});
			if (result.request.status === 'failed') {
				toast.error('The agent did not start', {
					description: result.request.error_message ?? result.request.id
				});
			}
			history = [
				{
					...result.request,
					actor: 'you',
					project_name: project?.name ?? target.project_id,
					title: target.issue_title
				},
				...history
			];
			thread_id = result.request.id;
		} catch (error) {
			toast.error('Could not reach the agent', { description: errorMessage(error) });
		} finally {
			submitting = false;
		}
	}

	function onMessageKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			void launch();
		}
	}

	useHotkeys(
		() => [
			...AGENT_INTENTS.map((entry, index) => ({
				keys: [entry.key, String(index + 1)],
				label: entry.label,
				group: 'Agent' as const,
				when: () => open && thread_id === null,
				run: () => pick(entry.id)
			})),
			{
				keys: ['mod+Enter'],
				label: 'Launch',
				group: 'Agent' as const,
				in_fields: true,
				when: () => open && thread_id === null,
				run: () => void launch()
			},
			{
				keys: ['n'],
				label: 'New request about this issue',
				group: 'Agent' as const,
				when: () => open && thread_id !== null,
				run: () => {
					thread_id = null;
				}
			}
		],
		{ modal: () => open }
	);
</script>

<Dialog.Root {open} {onOpenChange}>
	<Dialog.Content
		class="ui-dialog agent-dialog{thread_id ? ' is-thread' : ''}"
		showCloseButton={false}
	>
		{#if target}
			<div class="modal-hd">
				<BotIcon size={15} strokeWidth={1.4} aria-hidden="true" />
				<Dialog.Title class="sr-only">Agent on {target.issue_id}</Dialog.Title>
				<IssueId id={target.issue_id} strong />
				<span class="ti" title={target.issue_title}>{target.issue_title}</span>
				<span class="spacer"></span>
				{#if page_href}
					<a
						class="btn btn-sm btn-ghost btn-icon"
						href={page_href}
						onclick={() => app_state.closeAgent()}
						aria-label="Open this thread in First Mate"
						title="Open in First Mate"
					>
						<Maximize2Icon size={14} strokeWidth={1.4} />
					</a>
				{/if}
				<button
					class="btn btn-sm btn-ghost btn-icon"
					type="button"
					aria-label="Close"
					title="Close (esc)"
					onclick={() => app_state.closeAgent()}
				>
					<XIcon size={14} strokeWidth={1.4} />
				</button>
			</div>

			{#if thread_id}
				<div class="modal-bd thread-bd">
					<button
						class="back"
						type="button"
						onclick={() => (thread_id = null)}
						title="New request (n)"
					>
						<ArrowLeftIcon size={13} strokeWidth={1.4} /> New request
					</button>
					<AgentThread
						project_id={target.project_id}
						request_id={thread_id}
						initial={thread_mission}
						autofocus
					/>
				</div>
			{:else}
				<div class="modal-bd">
					<div class="intents" role="radiogroup" aria-label="What should the agent do?">
						{#each AGENT_INTENTS as entry, index (entry.id)}
							{@const Icon = ICONS[entry.id]}
							{@const ok = intentAllowed(entry.id, project?.allow)}
							<button
								class="intent"
								class:is-on={intent === entry.id}
								type="button"
								role="radio"
								aria-checked={intent === entry.id}
								aria-keyshortcuts="{entry.key} {index + 1}"
								title={ok ? entry.hint : `${entry.label} needs Tackle allowed for this project.`}
								onclick={() => pick(entry.id)}
							>
								<Icon size={16} strokeWidth={1.4} aria-hidden="true" />
								<span class="intent-lbl">{entry.label}</span>
								<kbd class="kbd">{entry.key}</kbd>
							</button>
						{/each}
					</div>
					<p class="hint mt-3">{info.hint}</p>
					{#if intent !== 'tackle'}
						<textarea
							bind:this={message_el}
							bind:value={message}
							class="textarea mt-3"
							rows={4}
							maxlength={4000}
							aria-label="Message for the agent"
							placeholder={info.placeholder}
							onkeydown={onMessageKeydown}></textarea>
					{/if}

					{#if history.length > 0}
						<div class="earlier">
							<div class="lbl">Earlier</div>
							<ul>
								{#each history as mission (mission.id)}
									<li>
										<button
											class="earlier-row"
											type="button"
											onclick={() => (thread_id = mission.id)}
										>
											<span class="verb">{missionVerb(mission)}</span>
											<MissionStatus status={mission.status} />
											<span class="spacer"></span>
											<span class="faint mono-num">{relativeShort(mission.updated_at)}</span>
										</button>
									</li>
								{/each}
							</ul>
						</div>
					{/if}
				</div>
				<div class="modal-ft">
					{#if blocked_reason}
						<span class="why">{blocked_reason}</span>
					{:else}
						<span class="why faint"><span class="kbd">⌘⏎</span> launch</span>
					{/if}
					<span class="spacer"></span>
					<button
						class="btn btn-sm btn-primary"
						type="button"
						disabled={submitting || blocked_reason !== undefined}
						onclick={launch}
					>
						{submitting ? 'Launching…' : info.label}
					</button>
				</div>
			{/if}
		{/if}
	</Dialog.Content>
</Dialog.Root>

<style>
	:global(.agent-dialog) {
		--dialog-w: 620px;
	}
	:global(.agent-dialog.is-thread) {
		height: min(680px, 88dvh);
	}
	.modal-hd :global(svg) {
		color: var(--tx-dim);
		flex: none;
	}
	.ti {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--tx-hi);
		font-size: var(--t-sm);
	}
	.spacer {
		flex: 1;
	}
	.thread-bd {
		display: flex;
		flex-direction: column;
		gap: var(--s-2);
		padding-top: var(--s-3);
	}
	.back {
		align-self: flex-start;
		display: inline-flex;
		align-items: center;
		gap: 5px;
		background: none;
		border: 0;
		padding: 2px 0;
		color: var(--tx-dim);
		font: inherit;
		font-size: var(--t-xs);
		cursor: pointer;
	}
	.back:hover {
		color: var(--tx-hi);
	}
	.intents {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: var(--s-2);
	}
	.intent {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		padding: var(--s-3) var(--s-2) var(--s-2);
		background: var(--s3);
		border: 1px solid var(--line);
		border-radius: var(--r-2);
		color: var(--tx-mid);
		font: inherit;
		font-size: var(--t-xs);
		cursor: pointer;
		position: relative;
	}
	.intent:hover {
		color: var(--tx-hi);
		border-color: var(--line-2);
	}
	.intent.is-on {
		color: var(--tx-hi);
		border-color: var(--em-500);
		background: var(--em-wash);
	}
	.intent .kbd {
		position: absolute;
		top: 4px;
		right: 4px;
		padding: 0 4px;
	}
	.intent-lbl {
		font-weight: 600;
	}
	.earlier {
		margin-top: var(--s-4);
	}
	.earlier ul {
		list-style: none;
		margin: var(--s-2) 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.earlier-row {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		width: 100%;
		min-height: 30px;
		padding: 0 var(--s-2);
		background: none;
		border: 1px solid transparent;
		border-radius: var(--r-1);
		color: var(--tx);
		font: inherit;
		font-size: var(--t-xs);
		cursor: pointer;
		text-align: left;
	}
	.earlier-row:hover {
		background: var(--s3);
		border-color: var(--line);
	}
	.verb {
		color: var(--tx-hi);
		font-weight: 600;
	}
	.why {
		font-size: var(--t-xs);
		color: var(--tx-dim);
	}
	@media (max-width: 480px) {
		.intents {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
</style>
