<script lang="ts">
	/**
	 * Route a todo to a Beads project. The server builds the
	 * File payload from the stored todo; this dialog only picks the project and
	 * adds an optional note. An agent files the issue and will not implement it.
	 */
	import { toast } from 'svelte-sonner';
	import PriorityChip from '$lib/components/priority-chip.svelte';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { api, errorMessage } from '$lib/client/api';
	import { projectList } from '$lib/client/projects.svelte';
	import type { Todo } from '$lib/server/todos/store';

	let {
		todo,
		open = $bindable(false),
		onrouted
	}: {
		todo: Todo | null;
		open: boolean;
		onrouted: (todo: Todo) => void;
	} = $props();

	const projects = $derived(projectList());
	let project_id = $state('');
	let notes = $state('');
	let submitting = $state(false);

	const chosen = $derived(projects.find((project) => project.id === project_id));
	const refusal = $derived(
		chosen?.allow !== undefined && !chosen.allow.file
			? 'File is not allowed for this project.'
			: undefined
	);
	const labels = $derived(
		(todo?.tags ?? []).map((tag) => tag.replace(/^[+@]/, '')).filter((tag) => tag.length > 0)
	);

	// Start from the last project the todo was routed to, else nothing chosen.
	$effect(() => {
		if (open) {
			project_id = todo?.routed_project_id ?? '';
			notes = '';
		}
	});

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (todo === null || submitting || project_id === '' || refusal !== undefined) {
			return;
		}
		submitting = true;
		try {
			const result = await api.routeTodo(todo.id, {
				project_id,
				...(notes.trim() === '' ? {} : { notes: notes.trim() })
			});
			onrouted(result.todo);
			if (result.request.status === 'failed') {
				toast.error('The filing agent did not start', {
					description: result.request.error_message ?? result.request.id
				});
			} else {
				toast.success('Filing agent launched', {
					description: `${chosen?.name ?? project_id} will get the issue shortly.`
				});
			}
			open = false;
		} catch (error) {
			toast.error('Could not route the todo', { description: errorMessage(error) });
		} finally {
			submitting = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="ui-dialog ui-dialog-sm" showCloseButton={false}>
		<form class="route-form" onsubmit={submit}>
			<div class="modal-hd">
				<Dialog.Title class="lbl">Route to project</Dialog.Title>
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
					An agent will turn this todo into a Beads issue in the project you pick. It will not
					implement the work. The todo stays on your list until you complete it.
				</p>
				{#if todo}
					<div class="preview">
						<PriorityChip priority={todo.priority} />
						<span class="title">{todo.title}</span>
						{#each labels as label (label)}
							<span class="xs faint">{label}</span>
						{/each}
					</div>
				{/if}
				<label class="field">
					<span class="lbl">Project</span>
					<select class="select" bind:value={project_id} required>
						<option value="" disabled>Choose a project</option>
						{#each projects as project (project.id)}
							<option value={project.id}>{project.name}</option>
						{/each}
					</select>
				</label>
				{#if refusal}
					<p class="hint refusal" role="alert">{refusal}</p>
				{/if}
				<label class="field">
					<span class="lbl">Note for the agent</span>
					<textarea
						class="textarea"
						bind:value={notes}
						maxlength={2000}
						rows={4}
						placeholder="Optional. The todo's body and comments are included."></textarea>
				</label>
			</div>
			<div class="modal-ft">
				<span class="xs faint"><span class="kbd">ESC</span> close</span>
				<span class="spacer"></span>
				<button class="btn btn-sm" type="button" onclick={() => (open = false)}>Cancel</button>
				<button
					class="btn btn-sm btn-primary"
					type="submit"
					disabled={submitting || project_id === '' || refusal !== undefined}
				>
					{submitting ? 'Launching…' : 'Launch filing agent'}
				</button>
			</div>
		</form>
	</Dialog.Content>
</Dialog.Root>

<style>
	.route-form {
		display: flex;
		flex-direction: column;
		min-height: 0;
		flex: 1;
	}
	.spacer {
		flex: 1;
	}
	.field {
		margin-top: var(--s-3);
	}
	.preview {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-2);
		margin-top: var(--s-3);
		padding: var(--s-2) var(--s-3);
		border: 1px solid var(--line);
		border-radius: var(--r-1);
		background: var(--s1);
	}
	.title {
		color: var(--tx-hi);
		overflow-wrap: anywhere;
	}
	.refusal {
		color: var(--danger-tx);
	}
</style>
