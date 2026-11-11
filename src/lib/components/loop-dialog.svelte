<script lang="ts">
	/**
	 * Start a ralph loop (ADR-0019) from a project, an epic or one bead: pick a
	 * preset (loop on this bead, build the plan, plan the project), an agent CLI
	 * and an iteration limit, then land on the loop's mission thread. Opened
	 * with `app_state.openLoop` (key `L` on project and issue pages, `l` in the
	 * agent dialog). The server checks everything again; this only explains why
	 * a launch would be refused before it is tried.
	 */
	import { goto } from '$app/navigation';
	import { tip } from '#lib/client/tooltip.js';
	import { toast } from 'svelte-sonner';
	import ArrowsClockwiseIcon from 'phosphor-svelte/lib/ArrowsClockwiseIcon';
	import HammerIcon from 'phosphor-svelte/lib/HammerIcon';
	import ListChecksIcon from 'phosphor-svelte/lib/ListChecksIcon';
	import TargetIcon from 'phosphor-svelte/lib/TargetIcon';
	import XIcon from 'phosphor-svelte/lib/XIcon';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import IssueId from '#lib/components/issue-id.svelte';
	import RunnerSelect from '#lib/components/runner-select.svelte';
	import SelectField from '#lib/components/select-field.svelte';
	import AgentChoiceSelect from '#lib/components/agent-choice-select.svelte';
	import { agent_choice } from '#lib/client/agent-choice.svelte.js';
	import { launchTakesChoice } from '#lib/client/agent-choice.js';
	import { api, errorMessage } from '#lib/client/api.js';
	import { run_place } from '#lib/client/agent-runner.svelte.js';
	import { missionThreadHref } from '#lib/client/first-mate.js';
	import {
		iterationLimitError,
		loopAvailability,
		loopLaunch,
		loopPresets,
		loopScope,
		type LoopPreset
	} from '#lib/client/loop.js';
	import { useHotkeys } from '#lib/client/hotkeys.svelte.js';
	import { projectList, statusSnapshot } from '#lib/client/projects.svelte.js';
	import { app_state } from '#lib/client/stores.svelte.js';
	import { LOOP_MAX_ITERATIONS, RALPH_HARNESSES, type RalphHarness } from '#lib/ralph.js';

	const ICONS = { bead: TargetIcon, build: HammerIcon, plan: ListChecksIcon } as const;
	const KEYS = ['1', '2', '3'] as const;

	/** `default` leaves `--harness` out so ralph uses its own default. */
	type HarnessChoice = RalphHarness | 'default';
	const HARNESS_ITEMS: { value: HarnessChoice; label: string }[] = [
		{ value: 'default', label: 'ralph default' },
		...RALPH_HARNESSES.map((id) => ({ value: id as HarnessChoice, label: id }))
	];

	const target = $derived(app_state.loop_target);
	const open = $derived(target !== null);
	const project = $derived(projectList().find((item) => item.id === target?.project_id));
	const scope = $derived(target === null ? 'project' : loopScope(target));
	const presets = $derived(loopPresets(scope));
	const availability = $derived(
		loopAvailability(statusSnapshot(), project?.allow, run_place.launchField().provider)
	);

	const choice_takes = $derived(
		availability.enabled && launchTakesChoice(statusSnapshot(), run_place.launchField().provider)
	);

	let preset_id = $state<LoopPreset['id']>('build');
	let harness = $state<HarnessChoice>('default');
	let iterations = $state('20');
	let submitting = $state(false);

	const preset = $derived(presets.find((entry) => entry.id === preset_id) ?? presets[0]!);
	const limit_error = $derived(iterationLimitError(iterations));
	const blocked_reason = $derived(
		availability.enabled ? undefined : (availability.reason ?? 'Loops are unavailable.')
	);
	const can_launch = $derived(
		!submitting && blocked_reason === undefined && limit_error === undefined
	);

	// Reset whenever a new target opens the dialog.
	$effect(() => {
		if (target === null) return;
		const first = loopPresets(loopScope(target))[0]!;
		preset_id = first.id;
		iterations = String(first.max_iterations);
		harness = 'default';
	});

	function pick(next: LoopPreset) {
		preset_id = next.id;
		iterations = String(next.max_iterations);
	}

	function onOpenChange(next: boolean) {
		if (!next) app_state.closeLoop();
	}

	async function launch() {
		if (target === null || !can_launch) return;
		submitting = true;
		try {
			const result = await api.launchLoop(target.project_id, {
				idempotency_key: crypto.randomUUID(),
				...loopLaunch(preset, target, {
					max_iterations: Number(iterations.trim()),
					...(harness === 'default' ? {} : { harness })
				}),
				...agent_choice.forLaunch(statusSnapshot(), run_place.launchField().provider)
			});
			if (result.request.status === 'failed') {
				toast.error('The loop did not start', {
					description: result.request.error_message ?? result.request.id
				});
			}
			app_state.closeLoop();
			await goto(missionThreadHref(target.project_id, result.request.id));
		} catch (error) {
			toast.error('Could not start the loop', { description: errorMessage(error) });
		} finally {
			submitting = false;
		}
	}

	function onFieldKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			event.preventDefault();
			void launch();
		}
	}

	useHotkeys(
		() => [
			...presets.map((entry, index) => ({
				keys: [KEYS[index]!],
				label: entry.label,
				group: 'Agent' as const,
				when: () => open,
				run: () => pick(entry)
			})),
			{
				keys: ['mod+Enter'],
				label: 'Start the loop',
				group: 'Agent' as const,
				in_fields: true,
				when: () => open,
				run: () => void launch()
			}
		],
		{ modal: () => open }
	);
</script>

<Dialog.Root {open} {onOpenChange}>
	<Dialog.Content class="ui-dialog loop-dialog" showCloseButton={false}>
		{#if target}
			<div class="modal-hd">
				<ArrowsClockwiseIcon size={15} aria-hidden="true" />
				<Dialog.Title class="hd-title">Run a loop</Dialog.Title>
				{#if target.issue}
					<IssueId id={target.issue.id} />
					<span class="ti" {@attach tip(target.issue.title)}>{target.issue.title}</span>
				{:else}
					<span class="ti">{project?.name ?? target.project_id}</span>
				{/if}
				<span class="spacer"></span>
				<button
					class="btn btn-sm btn-ghost btn-icon"
					type="button"
					aria-label="Close"
					{@attach tip('Close (esc)')}
					onclick={() => app_state.closeLoop()}
				>
					<XIcon size={14} />
				</button>
			</div>

			<div class="modal-bd">
				<div
					class="presets"
					style:--cols={presets.length}
					role="radiogroup"
					aria-label="What should the loop work on?"
				>
					{#each presets as entry, index (entry.id)}
						{@const Icon = ICONS[entry.id]}
						<button
							class="preset"
							class:is-on={preset.id === entry.id}
							type="button"
							role="radio"
							aria-checked={preset.id === entry.id}
							aria-keyshortcuts={KEYS[index]}
							onclick={() => pick(entry)}
						>
							<Icon size={16} aria-hidden="true" />
							<span class="preset-lbl">{entry.label}</span>
							<kbd class="kbd">{KEYS[index]}</kbd>
						</button>
					{/each}
				</div>
				<p class="hint mt-3">{preset.hint}</p>

				<div class="settings mt-3">
					<label class="field">
						<span class="lbl">Agent CLI</span>
						<SelectField
							bind:value={harness}
							items={HARNESS_ITEMS}
							aria-label="Agent CLI the loop drives"
						/>
					</label>
					<label class="field">
						<span class="lbl">Iterations, at most</span>
						<input
							class="input mono-num"
							class:is-invalid={limit_error !== undefined}
							type="text"
							inputmode="numeric"
							autocomplete="off"
							bind:value={iterations}
							aria-invalid={limit_error !== undefined}
							aria-describedby={limit_error === undefined ? undefined : 'loop-limit-err'}
							onkeydown={onFieldKeydown}
						/>
						{#if limit_error}
							<span class="err" id="loop-limit-err">{limit_error}</span>
						{/if}
					</label>
				</div>
				{#if choice_takes}
					<div class="mt-3">
						<AgentChoiceSelect takes={choice_takes} disabled={submitting} />
					</div>
				{/if}
				<p class="faint note mt-3">
					Each iteration is one fresh agent session that commits its work. The loop stops at the
					limit (up to {LOOP_MAX_ITERATIONS}), when the plan is done, or when you stop it.
				</p>
			</div>
			<div class="modal-ft">
				{#if blocked_reason}
					<span class="why" role="status">{blocked_reason}</span>
				{:else}
					<span class="why faint"><span class="kbd">⌘⏎</span> start</span>
				{/if}
				<span class="spacer"></span>
				<RunnerSelect />
				<button
					class="btn btn-sm btn-primary"
					type="button"
					disabled={!can_launch}
					onclick={launch}
				>
					{submitting ? 'Starting…' : 'Start loop'}
				</button>
			</div>
		{/if}
	</Dialog.Content>
</Dialog.Root>

<style>
	:global(.loop-dialog) {
		--dialog-w: 560px;
	}
	.modal-hd :global(svg) {
		color: var(--tx-dim);
		flex: none;
	}
	.modal-hd :global(.hd-title) {
		font-size: var(--t-sm);
		font-weight: 600;
		color: var(--tx-hi);
		white-space: nowrap;
	}
	.ti {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--tx-mid);
		font-size: var(--t-sm);
	}
	.spacer {
		flex: 1;
	}
	.presets {
		display: grid;
		grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
		gap: var(--s-2);
	}
	.preset {
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
		text-align: center;
	}
	.preset:hover {
		color: var(--tx-hi);
		border-color: var(--line-2);
	}
	.preset.is-on {
		color: var(--tx-hi);
		border-color: var(--em-500);
		background: var(--em-wash);
	}
	.preset .kbd {
		position: absolute;
		top: 4px;
		right: 4px;
		padding: 0 4px;
	}
	.preset-lbl {
		font-weight: 600;
	}
	.settings {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		gap: var(--s-3);
	}
	.err {
		font-size: var(--t-xs);
		color: var(--danger);
	}
	.note {
		font-size: var(--t-xs);
	}
	.why {
		font-size: var(--t-xs);
		color: var(--tx-dim);
		min-width: 0;
	}
	.modal-ft {
		flex-wrap: wrap;
	}
	@media (max-width: 480px) {
		.presets,
		.settings {
			grid-template-columns: minmax(0, 1fr);
		}
		.preset {
			flex-direction: row;
			justify-content: flex-start;
			padding: var(--s-2) var(--s-3);
			min-height: 44px;
		}
	}
	@media (pointer: coarse) {
		.preset {
			min-height: 44px;
		}
	}
</style>
