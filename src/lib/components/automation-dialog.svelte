<script lang="ts">
	/**
	 * Schedule a ralph loop (ADR-0019 rule 7): what it builds, when, and what
	 * to do when the previous run is still going. The loop fields are the loop
	 * dialog's (presets, agent CLI, iteration limit, model and effort); the
	 * model and effort ride inside the saved launch so every fire repeats
	 * them. The schedule previews its next fire times from the server, which
	 * owns the cron parser. Saving lands on the automation's page. The server
	 * checks everything again.
	 *
	 * Given `automation`, it edits that one in place so its history stays:
	 * the name, the schedule, the overlap and a loop's agent CLI and
	 * iteration limit change; the project, what it runs, the runner and the
	 * model and effort are shown as saved (changing them is a new
	 * automation, since the browser never sees a launch's text to send back).
	 */
	import { goto, invalidateAll } from '$app/navigation';
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import CalendarCheckIcon from 'phosphor-svelte/lib/CalendarCheckIcon';
	import XIcon from 'phosphor-svelte/lib/XIcon';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import RunnerSelect from '#lib/components/runner-select.svelte';
	import SelectField from '#lib/components/select-field.svelte';
	import AgentChoiceSelect from '#lib/components/agent-choice-select.svelte';
	import { agent_choice } from '#lib/client/agent-choice.svelte.js';
	import { launchTakesChoice } from '#lib/client/agent-choice.js';
	import { ApiError, api, errorMessage } from '#lib/client/api.js';
	import { run_place } from '#lib/client/agent-runner.svelte.js';
	import {
		automationEdit,
		automationLaunch,
		browserTimeZone,
		describeSchedule,
		formatSlot,
		launchSummary,
		SCHEDULE_PRESETS,
		type AutomationTarget
	} from '#lib/client/automations.js';
	import { iterationLimitError, loopAvailability, loopPresets } from '#lib/client/loop.js';
	import { projectList, statusSnapshot } from '#lib/client/projects.svelte.js';
	import { tip } from '#lib/client/tooltip.js';
	import {
		AUTOMATION_NAME_MAX,
		type AutomationOverlap,
		type AutomationView
	} from '#lib/automations.js';
	import { RALPH_HARNESSES, type RalphHarness } from '#lib/ralph.js';

	interface Props {
		open: boolean;
		/** The project to start with, such as the list's filter. */
		project_id?: string;
		/** Edit this saved automation instead of creating one. */
		automation?: AutomationView;
	}

	let { open = $bindable(false), project_id, automation }: Props = $props();
	const editing = $derived(automation !== undefined);
	/** The saved loop's flags while editing; a non-loop automation has none to edit. */
	const saved_loop = $derived(automation?.launch.loop);
	const has_loop = $derived(!editing || saved_loop !== undefined);

	const [BUILD, PLAN] = loopPresets('project');
	const WHAT: { id: AutomationTarget; label: string; hint: string; max_iterations: number }[] = [
		{ id: 'build', label: BUILD!.label, hint: BUILD!.hint, max_iterations: BUILD!.max_iterations },
		{ id: 'plan', label: PLAN!.label, hint: PLAN!.hint, max_iterations: PLAN!.max_iterations },
		{
			id: 'bead',
			label: 'Build one bead',
			hint: 'Builds one bead until it is done. An epic counts as one bead: its children are not picked up.',
			max_iterations: 10
		}
	];

	type HarnessChoice = RalphHarness | 'default';
	const HARNESS_ITEMS: { value: HarnessChoice; label: string }[] = [
		{ value: 'default', label: 'ralph default' },
		...RALPH_HARNESSES.map((id) => ({ value: id as HarnessChoice, label: id }))
	];
	const OVERLAP_ITEMS: { value: AutomationOverlap; label: string }[] = [
		{ value: 'skip', label: 'Skip that run' },
		{ value: 'queue', label: 'Run it when the last one ends' }
	];

	const projects = $derived(projectList());
	const project_items = $derived(projects.map((p) => ({ value: p.id, label: p.name })));

	let project = $state('');
	let what = $state<AutomationTarget>('build');
	let bead = $state('');
	let harness = $state<HarnessChoice>('default');
	let iterations = $state('20');
	let cron = $state('0 2 * * *');
	let time_zone = $state('UTC');
	let overlap = $state<AutomationOverlap>('skip');
	let name = $state('');
	let name_touched = $state(false);
	let submitting = $state(false);
	let tried = $state(false);
	let server_error = $state<string | undefined>(undefined);

	let preview = $state<{ upcoming: string[] } | { error: string } | null>(null);
	let previewing = $state(false);

	const chosen = $derived(WHAT.find((entry) => entry.id === what)!);
	const words = $derived(describeSchedule(cron));
	const limit_error = $derived(iterationLimitError(iterations));
	const bead_error = $derived(
		what === 'bead' && bead.trim() === ''
			? 'Enter the bead to build, such as an epic id.'
			: undefined
	);
	const name_error = $derived(name.trim() === '' ? 'Give the automation a name.' : undefined);
	const schedule_error = $derived(
		preview !== null && 'error' in preview ? preview.error : undefined
	);
	const project_name = $derived(projects.find((p) => p.id === project)?.name);
	const provider = $derived(
		automation === undefined ? run_place.launchField().provider : automation.provider
	);
	const availability = $derived(
		loopAvailability(statusSnapshot(), projects.find((p) => p.id === project)?.allow, provider)
	);
	// As in the loop dialog: only when the runner runs loops and can choose a
	// model, since the server refuses a choice anywhere else.
	const choice_takes = $derived(
		!editing && availability.enabled && launchTakesChoice(statusSnapshot(), provider)
	);
	const can_save = $derived(
		!submitting &&
			project !== '' &&
			(!has_loop || limit_error === undefined) &&
			(editing || bead_error === undefined) &&
			name_error === undefined &&
			schedule_error === undefined
	);

	/** A name that says what and when, until the person types their own. */
	const suggested_name = $derived(
		[words ?? 'Scheduled', what === 'plan' ? 'plan' : 'build', what === 'bead' ? bead.trim() : '']
			.filter(Boolean)
			.join(' ')
			.replace(/^(\w)/, (c) => c.toUpperCase())
	);
	$effect(() => {
		if (!name_touched) name = suggested_name.slice(0, AUTOMATION_NAME_MAX);
	});

	// Reset each time the dialog opens.
	$effect(() => {
		if (!open) return;
		untrack(() => reset());
	});

	function reset() {
		tried = false;
		server_error = undefined;
		if (automation !== undefined) {
			project = automation.project_id;
			const loop = automation.launch.loop;
			what = loop?.mode === 'plan' ? 'plan' : loop?.issue_id === undefined ? 'build' : 'bead';
			bead = loop?.issue_id ?? '';
			harness = loop?.harness ?? 'default';
			iterations = String(loop?.max_iterations ?? WHAT[0]!.max_iterations);
			cron = automation.cron;
			time_zone = automation.time_zone;
			overlap = automation.overlap;
			name = automation.name;
			name_touched = true;
			return;
		}
		project = project_id ?? projects[0]?.id ?? '';
		what = 'build';
		bead = '';
		harness = 'default';
		iterations = String(WHAT[0]!.max_iterations);
		cron = SCHEDULE_PRESETS[0]!.cron;
		time_zone = browserTimeZone();
		overlap = 'skip';
		name_touched = false;
	}

	// Ask the server for the next fire times while the schedule is typed.
	$effect(() => {
		if (!open) return;
		const expression = cron.trim();
		const zone = time_zone.trim();
		if (expression === '' || zone === '') {
			preview = { error: 'Enter a schedule and a time zone.' };
			return;
		}
		const controller = new AbortController();
		const timer = setTimeout(async () => {
			previewing = true;
			try {
				preview = await api.previewAutomation(expression, zone, { signal: controller.signal });
			} catch (error) {
				if (controller.signal.aborted) return;
				preview =
					error instanceof ApiError && error.code === 'bad_request'
						? { error: error.message }
						: { error: `The schedule could not be checked: ${errorMessage(error)}` };
			} finally {
				if (!controller.signal.aborted) previewing = false;
			}
		}, 250);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	});

	function pick(next: AutomationTarget) {
		what = next;
		iterations = String(WHAT.find((entry) => entry.id === next)!.max_iterations);
	}

	async function save(event: SubmitEvent) {
		event.preventDefault();
		tried = true;
		server_error = undefined;
		if (!can_save) return;
		submitting = true;
		try {
			if (automation !== undefined) {
				const { automation: saved } = await api.updateAutomation(
					automation.id,
					automationEdit(automation.launch, {
						name,
						cron,
						time_zone,
						overlap,
						max_iterations: Number(iterations.trim()),
						...(harness === 'default' ? {} : { harness })
					})
				);
				open = false;
				toast.success('Automation updated', {
					description: saved.next_run
						? `Next run ${formatSlot(saved.next_run, saved.time_zone)}`
						: undefined
				});
				await invalidateAll();
				return;
			}
			const { automation: created } = await api.createAutomation({
				project_id: project,
				name: name.trim(),
				cron: cron.trim(),
				time_zone: time_zone.trim(),
				overlap,
				launch: automationLaunch(
					what,
					{
						bead,
						max_iterations: Number(iterations.trim()),
						...(harness === 'default' ? {} : { harness })
					},
					agent_choice.forLaunch(statusSnapshot(), run_place.launchField().provider)
				)
			});
			open = false;
			toast.success('Automation saved', {
				description: created.next_run
					? `First run ${formatSlot(created.next_run, created.time_zone)}`
					: undefined
			});
			await goto(`/automations/${created.id}`);
		} catch (error) {
			// Shown in the form, which keeps everything typed.
			server_error = errorMessage(error);
		} finally {
			submitting = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="ui-dialog automation-dialog" showCloseButton={false}>
		<form class="form" onsubmit={save} novalidate>
			<div class="modal-hd">
				<CalendarCheckIcon size={15} aria-hidden="true" />
				<Dialog.Title class="hd-title"
					>{editing ? 'Edit automation' : 'New automation'}</Dialog.Title
				>
				<span class="ti">{project_name ?? ''}</span>
				<span class="spacer"></span>
				<button
					class="btn btn-sm btn-ghost btn-icon"
					type="button"
					aria-label="Close"
					{@attach tip('Close (esc)')}
					onclick={() => (open = false)}
				>
					<XIcon size={14} />
				</button>
			</div>

			<div class="modal-bd">
				<div class="grid2">
					{#if automation}
						<div class="field">
							<span class="lbl">Project</span>
							<span class="fixed">{automation.project_name}</span>
						</div>
					{:else}
						<label class="field">
							<span class="lbl">Project</span>
							<SelectField bind:value={project} items={project_items} aria-label="Project" />
						</label>
					{/if}
					<label class="field">
						<span class="lbl">Name</span>
						<input
							class="input"
							class:is-invalid={tried && name_error !== undefined}
							type="text"
							autocomplete="off"
							maxlength={AUTOMATION_NAME_MAX}
							bind:value={name}
							oninput={() => (name_touched = true)}
							aria-invalid={tried && name_error !== undefined}
							aria-describedby={tried && name_error ? 'au-name-err' : undefined}
						/>
						{#if tried && name_error}<span class="err" id="au-name-err">{name_error}</span>{/if}
					</label>
				</div>

				<fieldset class="group mt-4">
					<legend class="lbl">What it runs</legend>
					{#if automation}
						<p class="fixed">
							{launchSummary(automation.launch)}
							{#if saved_loop?.model || saved_loop?.effort}
								<span class="faint"
									>· {[saved_loop.model, saved_loop.effort].filter(Boolean).join(' · ')}</span
								>
							{/if}
						</p>
						<p class="hint mt-2">
							To run something else, on another project or runner, or with another model, save a new
							automation.
						</p>
					{:else}
						<div class="presets" role="radiogroup" aria-label="What the loop works on">
							{#each WHAT as entry (entry.id)}
								<button
									class="preset"
									class:is-on={what === entry.id}
									type="button"
									role="radio"
									aria-checked={what === entry.id}
									onclick={() => pick(entry.id)}>{entry.label}</button
								>
							{/each}
						</div>
						<p class="hint mt-2">{chosen.hint}</p>
					{/if}
					{#if has_loop}
						<div class="grid3 mt-3">
							{#if what === 'bead' && !editing}
								<label class="field">
									<span class="lbl">Bead</span>
									<input
										class="input mono-num"
										class:is-invalid={tried && bead_error !== undefined}
										type="text"
										autocomplete="off"
										spellcheck="false"
										placeholder="proj-abc"
										bind:value={bead}
										aria-invalid={tried && bead_error !== undefined}
										aria-describedby={tried && bead_error ? 'au-bead-err' : undefined}
									/>
									{#if tried && bead_error}<span class="err" id="au-bead-err">{bead_error}</span
										>{/if}
								</label>
							{/if}
							<label class="field">
								<span class="lbl">Agent CLI</span>
								<SelectField bind:value={harness} items={HARNESS_ITEMS} aria-label="Agent CLI" />
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
									aria-describedby={limit_error ? 'au-limit-err' : undefined}
								/>
								{#if limit_error}<span class="err" id="au-limit-err">{limit_error}</span>{/if}
							</label>
						</div>
					{/if}
					{#if choice_takes}
						<div class="mt-3">
							<AgentChoiceSelect takes={choice_takes} disabled={submitting} />
						</div>
					{/if}
				</fieldset>

				<fieldset class="group mt-4">
					<legend class="lbl">When</legend>
					<div class="chips" aria-label="Common schedules">
						{#each SCHEDULE_PRESETS as preset (preset.cron)}
							<button
								class="chip"
								class:is-on={cron.trim() === preset.cron}
								type="button"
								aria-pressed={cron.trim() === preset.cron}
								onclick={() => (cron = preset.cron)}>{preset.label}</button
							>
						{/each}
					</div>
					<div class="grid2 mt-3">
						<label class="field">
							<span class="lbl">Schedule (cron)</span>
							<input
								class="input mono-num"
								class:is-invalid={schedule_error !== undefined}
								type="text"
								autocomplete="off"
								spellcheck="false"
								bind:value={cron}
								aria-invalid={schedule_error !== undefined}
								aria-describedby="au-sched-help"
							/>
						</label>
						<label class="field">
							<span class="lbl">Time zone</span>
							<input
								class="input"
								type="text"
								autocomplete="off"
								spellcheck="false"
								bind:value={time_zone}
								aria-describedby="au-sched-help"
							/>
						</label>
					</div>
					<div class="preview mt-2" id="au-sched-help" aria-live="polite">
						{#if schedule_error}
							<span class="err">{schedule_error}</span>
						{:else if preview && 'upcoming' in preview}
							<span class="hint">
								{words ?? 'Next runs'}{previewing ? ' …' : ''}, then
								<span class="slots">
									{#each preview.upcoming as slot, index (slot)}
										<span class="mono-num">{formatSlot(slot, time_zone.trim())}</span>{index <
										preview.upcoming.length - 1
											? ' · '
											: ''}
									{/each}
								</span>
							</span>
						{:else}
							<span class="hint">Minute, hour, day of month, month, day of week.</span>
						{/if}
					</div>
					<label class="field mt-3">
						<span class="lbl">If the last run is still going</span>
						<SelectField
							bind:value={overlap}
							items={OVERLAP_ITEMS}
							aria-label="If the last run is still going"
						/>
					</label>
				</fieldset>

				{#if statusSnapshot() !== null && (!availability.visible || !availability.enabled)}
					<p class="banner banner-warn mt-4" role="status">
						{availability.reason ?? 'No runner here runs loops yet.'}
						You can save it now; each run is refused until that changes.
					</p>
				{/if}
				{#if server_error}
					<p class="banner banner-err mt-4" role="alert">{server_error}</p>
				{/if}
			</div>

			<div class="modal-ft">
				{#if automation}
					<span class="why faint">Runs on {automation.provider ?? 'the default runner'}.</span>
					<span class="spacer"></span>
				{:else}
					<span class="why faint">Runs as you, while you are an admin.</span>
					<span class="spacer"></span>
					<RunnerSelect />
				{/if}
				<button class="btn btn-sm btn-primary" type="submit" disabled={submitting}>
					{submitting ? 'Saving…' : editing ? 'Save changes' : 'Save automation'}
				</button>
			</div>
		</form>
	</Dialog.Content>
</Dialog.Root>

<style>
	:global(.automation-dialog) {
		--dialog-w: 620px;
	}
	.form {
		display: contents;
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
	.group {
		border: 0;
		margin-inline: 0;
		padding: 0;
		min-width: 0;
	}
	.group > legend {
		padding: 0;
		margin-bottom: var(--s-2);
	}
	.grid2 {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		gap: var(--s-3);
	}
	.grid3 {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: var(--s-3);
	}
	.presets {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: var(--s-2);
	}
	.preset,
	.chip {
		min-height: 32px;
		padding: 0 var(--s-3);
		background: var(--s3);
		border: 1px solid var(--line);
		border-radius: var(--r-2);
		color: var(--tx-mid);
		font: inherit;
		font-size: var(--t-xs);
		font-weight: 600;
		cursor: pointer;
	}
	.chip {
		min-height: 26px;
		border-radius: 999px;
		font-weight: 500;
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-2);
	}
	.preset:hover,
	.chip:hover {
		color: var(--tx-hi);
		border-color: var(--line-2);
	}
	.preset:focus-visible,
	.chip:focus-visible {
		outline: 2px solid var(--em-500);
		outline-offset: 1px;
	}
	.preset.is-on,
	.chip.is-on {
		color: var(--tx-hi);
		border-color: var(--em-500);
		background: var(--em-wash);
	}
	.preview {
		min-height: 1.4em;
	}
	.fixed {
		margin: 0;
		min-height: 32px;
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--s-1);
		color: var(--tx-hi);
		font-size: var(--t-sm);
	}
	.slots {
		color: var(--tx-mid);
	}
	.err {
		font-size: var(--t-xs);
		color: var(--danger-tx);
	}
	.why {
		font-size: var(--t-xs);
		min-width: 0;
	}
	.banner {
		margin-bottom: 0;
	}
	@media (max-width: 520px) {
		.grid2,
		.presets {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	@media (pointer: coarse) {
		.preset,
		.chip {
			min-height: 44px;
		}
	}
</style>
