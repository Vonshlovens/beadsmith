<script lang="ts">
	/**
	 * Change a saved view's name, description and spec from its page (ADR-0025
	 * rule 1). A save is a new revision through `PATCH /api/views/<slug>`, the
	 * kind of revision First Mate's `define_view` and the project page's
	 * "Update view" also append, so the history shows every edit alike and any
	 * of them can be reverted. The filter choices are the project page's (`FILTER_*` in
	 * `#lib/client/views.js`), plus whatever the view already holds that those
	 * lack, so opening and saving never drops a value First Mate wrote. Only
	 * changed fields are sent, and an unchanged form cannot be saved, so the
	 * history does not fill with copies.
	 */
	import { toast } from 'svelte-sonner';
	import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimpleIcon';
	import XIcon from 'phosphor-svelte/lib/XIcon';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import PriorityChip from '#lib/components/priority-chip.svelte';
	import SelectField from '#lib/components/select-field.svelte';
	import { api, errorMessage } from '#lib/client/api.js';
	import { projectList } from '#lib/client/projects.svelte.js';
	import { tip } from '#lib/client/tooltip.js';
	import {
		ALL_PROJECTS,
		describeViewSpec,
		FILTER_PRIORITIES,
		FILTER_STATUSES,
		FILTER_TYPES,
		filterChoices,
		SORT_LABEL,
		viewLimitError,
		viewRevisionChanges,
		viewSpecForm,
		viewSpecFromForm,
		type ViewSpecForm
	} from '#lib/client/views.js';
	import { GROWN_DESCRIPTION_MAX, GROWN_NAME_MAX } from '#lib/grown.js';
	import {
		VIEW_GROUPS,
		VIEW_LIMIT_MAX,
		VIEW_SORTS,
		type ViewGroup,
		type ViewPresentation,
		type ViewSort,
		type ViewSummary
	} from '#lib/views.js';

	interface Props {
		open: boolean;
		view: ViewSummary;
		/** Called once the new revision is saved. */
		onsaved: (view: ViewSummary) => void;
	}

	let { open = $bindable(false), view, onsaved }: Props = $props();

	let name = $state('');
	let description = $state('');
	// Filled from the view each time the dialog opens (below).
	let form = $state<ViewSpecForm>(
		viewSpecForm({ scope: 'all', filters: {}, sort: 'updated', presentation: 'list' })
	);
	let tried = $state(false);
	let submitting = $state(false);
	let server_error = $state<string | null>(null);

	// Each opening starts from the view as it is now.
	$effect(() => {
		if (open) {
			name = view.name;
			description = view.description;
			form = viewSpecForm(view.spec);
			tried = false;
			server_error = null;
		}
	});

	const projects = $derived(projectList());
	const scope_items = $derived.by(() => {
		const items: { value: string; label: string; hint?: string }[] = [
			{ value: ALL_PROJECTS, label: 'All projects' },
			...projects.map((p) => ({ value: p.id, label: p.name }))
		];
		// A project that left the catalogue stays choosable, so opening the
		// editor never moves the view somewhere else.
		if (form.scope !== ALL_PROJECTS && !projects.some((p) => p.id === form.scope)) {
			items.push({ value: form.scope, label: form.scope, hint: 'not in the catalogue' });
		}
		return items;
	});
	const project_name = (id: string) => projects.find((p) => p.id === id)?.name ?? id;

	// Held values come from the view as opened, so unticking one keeps its box.
	const status_choices = $derived(filterChoices(FILTER_STATUSES, view.spec.filters.status ?? []));
	const type_choices = $derived(filterChoices(FILTER_TYPES, view.spec.filters.type ?? []));
	const priority_choices = $derived(
		filterChoices(FILTER_PRIORITIES, view.spec.filters.priority ?? [])
	);

	const SORT_ITEMS = VIEW_SORTS.map((value) => ({ value, label: SORT_LABEL[value] }));
	const PRESENTATION_ITEMS: { value: ViewPresentation; label: string }[] = [
		{ value: 'list', label: 'List' },
		{ value: 'board', label: 'Board' }
	];
	const GROUP_ITEMS: { value: ViewGroup | 'none'; label: string }[] = [
		{ value: 'none', label: 'No grouping' },
		...VIEW_GROUPS.map((value) => ({ value, label: `By ${value}` }))
	];

	const name_error = $derived(
		name.trim().length === 0
			? 'Give the view a name.'
			: name.trim().length > GROWN_NAME_MAX
				? `At most ${GROWN_NAME_MAX} characters.`
				: undefined
	);
	const limit_error = $derived(viewLimitError(form.limit));
	const next_spec = $derived(limit_error === undefined ? viewSpecFromForm(form) : null);
	const facts = $derived(next_spec === null ? [] : describeViewSpec(next_spec, project_name));
	const changes = $derived(
		next_spec === null
			? null
			: viewRevisionChanges(
					{ name: view.name, description: view.description, spec: view.spec },
					{ name, description, spec: next_spec }
				)
	);
	const unchanged = $derived(next_spec !== null && changes === null);

	function toggle<T>(list: T[], value: T): T[] {
		return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
	}

	async function save(event: SubmitEvent) {
		event.preventDefault();
		tried = true;
		if (name_error || limit_error || changes === null || submitting) return;
		submitting = true;
		server_error = null;
		try {
			const { view: saved } = await api.reviseView(view.slug, changes);
			open = false;
			toast.success(`Saved ${saved.name} as r${saved.revision}`, {
				description: saved.published
					? 'Members keep the published revision until you publish this one.'
					: 'Only you see it until you publish it.'
			});
			onsaved(saved);
		} catch (error) {
			// Shown in the form, which keeps everything typed.
			server_error = errorMessage(error);
		} finally {
			submitting = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="ui-dialog edit-view-dialog" showCloseButton={false}>
		<form class="form" onsubmit={save} novalidate>
			<div class="modal-hd">
				<PencilSimpleIcon size={15} aria-hidden="true" />
				<Dialog.Title class="hd-title">Edit view</Dialog.Title>
				<span class="ti">{view.name}</span>
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
				<Dialog.Description class="facts" aria-live="polite">
					{#each facts as fact (fact)}<span>{fact}</span>{/each}
				</Dialog.Description>

				<label class="field mt-4">
					<span class="lbl">Name</span>
					<!-- svelte-ignore a11y_autofocus -->
					<input
						class="input"
						class:is-invalid={tried && name_error !== undefined}
						type="text"
						autocomplete="off"
						autofocus
						maxlength={GROWN_NAME_MAX}
						bind:value={name}
						aria-invalid={tried && name_error !== undefined}
						aria-describedby={tried && name_error ? 'ev-name-err' : undefined}
					/>
					{#if tried && name_error}<span class="err" id="ev-name-err">{name_error}</span>{/if}
				</label>

				<label class="field mt-3">
					<span class="lbl">Description <span class="faint">(optional)</span></span>
					<textarea
						class="input"
						rows="2"
						maxlength={GROWN_DESCRIPTION_MAX}
						bind:value={description}></textarea>
				</label>

				<fieldset class="group mt-4">
					<legend class="lbl">Which issues</legend>
					<label class="field">
						<span class="lbl sub">Projects</span>
						<SelectField bind:value={form.scope} items={scope_items} aria-label="Projects" />
					</label>

					<fieldset class="group mt-3">
						<legend class="lbl sub">Status <span class="faint">(none ticked: any)</span></legend>
						<div class="checks">
							{#each status_choices as option (option)}
								<label class="check">
									<input
										type="checkbox"
										checked={form.status.includes(option)}
										onchange={() => (form.status = toggle(form.status, option))}
									/>
									<i class="dot dot-{option}" aria-hidden="true"></i>{option.replace('_', ' ')}
								</label>
							{/each}
						</div>
					</fieldset>

					<fieldset class="group mt-3">
						<legend class="lbl sub">Type <span class="faint">(none ticked: any)</span></legend>
						<div class="checks">
							{#each type_choices as option (option)}
								<label class="check">
									<input
										type="checkbox"
										checked={form.type.includes(option)}
										onchange={() => (form.type = toggle(form.type, option))}
									/>{option}
								</label>
							{/each}
						</div>
					</fieldset>

					<fieldset class="group mt-3">
						<legend class="lbl sub">Priority <span class="faint">(none ticked: any)</span></legend>
						<div class="checks">
							{#each priority_choices as option (option)}
								<label class="check">
									<input
										type="checkbox"
										checked={form.priority.includes(option)}
										onchange={() => (form.priority = toggle(form.priority, option))}
										aria-label="P{option}"
									/><PriorityChip priority={option} />
								</label>
							{/each}
						</div>
					</fieldset>

					<div class="grid3 mt-3">
						<label class="field">
							<span class="lbl sub">Text</span>
							<input
								class="input"
								type="text"
								autocomplete="off"
								placeholder="Title, id or label"
								bind:value={form.q}
							/>
						</label>
						<label class="field">
							<span class="lbl sub">Label</span>
							<input
								class="input"
								type="text"
								autocomplete="off"
								spellcheck="false"
								bind:value={form.label}
							/>
						</label>
						<label class="field">
							<span class="lbl sub">Assignee</span>
							<input
								class="input"
								type="text"
								autocomplete="off"
								spellcheck="false"
								bind:value={form.assignee}
							/>
						</label>
					</div>

					<div class="grid3 mt-3">
						<label class="field">
							<span class="lbl sub">Rows, at most</span>
							<input
								class="input mono-num"
								class:is-invalid={limit_error !== undefined}
								type="text"
								inputmode="numeric"
								autocomplete="off"
								placeholder="Default"
								bind:value={form.limit}
								aria-invalid={limit_error !== undefined}
								aria-describedby={limit_error ? 'ev-limit-err' : 'ev-limit-hint'}
							/>
							{#if limit_error}
								<span class="err" id="ev-limit-err">{limit_error}</span>
							{:else}
								<span class="hint" id="ev-limit-hint">Up to {VIEW_LIMIT_MAX}</span>
							{/if}
						</label>
						<label class="check closed">
							<input type="checkbox" bind:checked={form.include_closed} />Include closed issues
						</label>
					</div>
				</fieldset>

				<fieldset class="group mt-4">
					<legend class="lbl">How it shows</legend>
					<div class="grid3">
						<label class="field">
							<span class="lbl sub">Order</span>
							<SelectField
								value={form.sort}
								items={SORT_ITEMS}
								onValueChange={(value: ViewSort) => (form.sort = value)}
								aria-label="Order"
							/>
						</label>
						<label class="field">
							<span class="lbl sub">Layout</span>
							<SelectField
								value={form.presentation}
								items={PRESENTATION_ITEMS}
								onValueChange={(value: ViewPresentation) => (form.presentation = value)}
								aria-label="Layout"
							/>
						</label>
						{#if form.presentation === 'list'}
							<label class="field">
								<span class="lbl sub">Groups</span>
								<SelectField
									value={form.group_by}
									items={GROUP_ITEMS}
									onValueChange={(value: ViewGroup | 'none') => (form.group_by = value)}
									aria-label="Groups"
								/>
							</label>
						{/if}
					</div>
				</fieldset>

				{#if server_error}
					<p class="banner banner-err mt-4" role="alert">{server_error}</p>
				{/if}
			</div>

			<div class="modal-ft">
				<span class="why faint">
					{#if unchanged}
						Nothing changed yet.
					{:else if view.published}
						Saves r{view.revision + 1}; members keep the published one until you publish it.
					{:else}
						Saves r{view.revision + 1}; only you see it until you publish it.
					{/if}
				</span>
				<span class="spacer"></span>
				<button class="btn btn-sm" type="button" onclick={() => (open = false)}>Cancel</button>
				<button class="btn btn-sm btn-primary" type="submit" disabled={submitting || unchanged}>
					{submitting ? 'Saving…' : 'Save revision'}
				</button>
			</div>
		</form>
	</Dialog.Content>
</Dialog.Root>

<style>
	:global(.edit-view-dialog) {
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
	:global(.edit-view-dialog .facts) {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-1) var(--s-3);
		margin: 0;
		font-size: var(--t-xs);
		color: var(--tx-mid);
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
	.lbl.sub {
		color: var(--tx-mid);
	}
	.checks {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-2) var(--s-4);
	}
	/* Touch targets: the label is the hit area, at least 32px tall. */
	.checks .check,
	.check.closed {
		min-height: 32px;
		gap: 7px;
	}
	.check.closed {
		align-self: end;
	}
	.grid3 {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: var(--s-3);
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
</style>
