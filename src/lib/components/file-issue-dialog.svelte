<script lang="ts">
	/**
	 * File dialog: enqueue a /file agent for the current project.
	 * The web process does not create the Beads issue itself.
	 */
	import { toast } from 'svelte-sonner';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { api, errorMessage } from '$lib/client/api';
	import { boardCreateHeading, fileStatusAfterCreate } from '$lib/client/board';
	import { statusLabel } from '$lib/client/format';
	import type { StatusKey } from '$lib/client/format';
	import type { DispatchRequest } from '$lib/types';

	let {
		project_id,
		open = $bindable(false),
		initial_status
	}: {
		project_id: string;
		open: boolean;
		initial_status?: StatusKey;
	} = $props();

	const TYPE_OPTIONS = ['', 'bug', 'feature', 'task', 'epic', 'chore'] as const;
	const PRIORITY_OPTIONS = ['', '0', '1', '2', '3', '4'] as const;

	let notes = $state('');
	let title = $state('');
	let issue_type = $state('');
	let priority = $state('');
	let submitting = $state(false);

	const heading = $derived(
		initial_status === undefined ? 'File an issue' : boardCreateHeading(initial_status)
	);
	const file_status = $derived(fileStatusAfterCreate(initial_status));

	function resetForm() {
		notes = '';
		title = '';
		issue_type = '';
		priority = '';
	}

	function announce(request: DispatchRequest) {
		if (request.status === 'failed') {
			toast.error('The filing agent did not start', {
				description: request.error_message ?? request.id
			});
			return;
		}
		const url = request.agent_url;
		const column =
			initial_status === undefined
				? undefined
				: `It will appear under ${statusLabel(initial_status)} after the agent files it.`;
		toast.success('Filing agent launched', {
			description: [column, url ?? request.id].filter(Boolean).join(' '),
			action:
				url === undefined
					? undefined
					: {
							label: 'Open',
							onClick: () => {
								window.open(url, '_blank', 'noopener');
							}
						}
		});
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (submitting || notes.trim().length === 0) {
			return;
		}
		submitting = true;
		try {
			const result = await api.fileIssue(project_id, {
				idempotency_key: crypto.randomUUID(),
				notes: notes.trim(),
				title: title.trim() || undefined,
				issue_type: issue_type || undefined,
				priority: priority === '' ? undefined : Number.parseInt(priority, 10),
				...(file_status === undefined ? {} : { status: file_status })
			});
			announce(result.request);
			resetForm();
			open = false;
		} catch (error) {
			toast.error('Could not launch the filing agent', { description: errorMessage(error) });
		} finally {
			submitting = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="ui-dialog ui-dialog-sm" showCloseButton={false}>
		<form class="file-form" onsubmit={submit}>
			<div class="modal-hd">
				<Dialog.Title class="lbl">{heading}</Dialog.Title>
				<span class="spacer"></span>
				<button
					class="btn btn-sm btn-icon"
					type="button"
					aria-label="Close"
					onclick={() => (open = false)}
				>
					✕
				</button>
			</div>
			<div class="modal-bd">
				<p class="hint">
					{#if initial_status === undefined}
						An agent will turn these notes into a Beads issue. It will not implement the work.
					{:else if file_status === undefined}
						An agent will file this as a Beads issue in the {statusLabel(initial_status)}
						column. It will not implement the work.
					{:else}
						An agent will file this as a Beads issue in the {statusLabel(initial_status)}
						column. It will not implement the work. If create succeeds and the status write fails, the
						issue stays open and the agent reports the id.
					{/if}
				</p>
				<label class="field">
					<span class="lbl">Notes</span>
					<textarea
						class="textarea"
						bind:value={notes}
						required
						maxlength={8000}
						rows={8}
						placeholder="What should be filed, and why."></textarea>
				</label>
				<label class="field">
					<span class="lbl">Title hint</span>
					<input class="input" bind:value={title} maxlength={200} placeholder="optional" />
				</label>
				<div class="row">
					<label class="field">
						<span class="lbl">Type</span>
						<select class="select" bind:value={issue_type}>
							{#each TYPE_OPTIONS as option (option)}
								<option value={option}>{option === '' ? 'agent decides' : option}</option>
							{/each}
						</select>
					</label>
					<label class="field">
						<span class="lbl">Priority</span>
						<select class="select" bind:value={priority}>
							{#each PRIORITY_OPTIONS as option (option)}
								<option value={option}>{option === '' ? 'agent decides' : `P${option}`}</option>
							{/each}
						</select>
					</label>
				</div>
			</div>
			<div class="modal-ft">
				<span class="xs faint"><span class="kbd">ESC</span> close</span>
				<span class="spacer"></span>
				<button class="btn btn-sm" type="button" onclick={() => (open = false)}>Cancel</button>
				<button
					class="btn btn-sm btn-primary"
					type="submit"
					disabled={submitting || notes.trim().length === 0}
				>
					{submitting ? 'Launching…' : 'Launch filing agent'}
				</button>
			</div>
		</form>
	</Dialog.Content>
</Dialog.Root>

<style>
	.file-form {
		display: flex;
		flex-direction: column;
		min-height: 0;
		flex: 1;
	}
	.spacer {
		flex: 1;
	}
	.row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--s-3);
	}
	.field {
		margin-top: var(--s-3);
	}
</style>
