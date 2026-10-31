<script lang="ts">
	/**
	 * Edit or clear a console-persisted File checkout. Distinct from Tackle maps.
	 */
	import { toast } from 'svelte-sonner';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { api, errorMessage } from '$lib/client/api';
	import type { ConsoleProjectRow } from '$lib/types';

	let {
		project,
		open = $bindable(false),
		onSaved
	}: {
		project: ConsoleProjectRow;
		open: boolean;
		onSaved: () => Promise<void> | void;
	} = $props();

	let url = $state('');
	let ref = $state('main');
	let submitting = $state(false);

	function resetFromProject() {
		if (project.file.mapped) {
			url = project.file.url;
			ref = project.file.ref;
			return;
		}
		url = '';
		ref = 'main';
	}

	$effect(() => {
		if (open) {
			resetFromProject();
		}
	});

	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (submitting || url.trim().length === 0) {
			return;
		}
		submitting = true;
		try {
			await api.putFileMap(project.id, {
				url: url.trim(),
				ref: ref.trim() || undefined
			});
			toast.success('File checkout saved', { description: project.id });
			open = false;
			await onSaved();
		} catch (error) {
			toast.error('Could not save the File checkout', { description: errorMessage(error) });
		} finally {
			submitting = false;
		}
	}

	async function clearMap() {
		if (submitting || !project.file.mapped) {
			return;
		}
		submitting = true;
		try {
			await api.deleteFileMap(project.id);
			toast.success('File checkout cleared', { description: project.id });
			open = false;
			await onSaved();
		} catch (error) {
			toast.error('Could not clear the File checkout', { description: errorMessage(error) });
		} finally {
			submitting = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="ui-dialog ui-dialog-sm" showCloseButton={false}>
		<form class="map-form" onsubmit={save}>
			<div class="modal-hd">
				<Dialog.Title class="lbl">File checkout</Dialog.Title>
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
				<p class="hi sm">
					{project.name}
					<span class="id dim"> · {project.id}</span>
				</p>
				<p class="hint">
					File launches this GitHub checkout with no pull request. Unset uses the service default
					(beads-web). Maps are stored on this service, not in Beads. Tackle maps are separate.
				</p>
				<label class="field">
					<span class="lbl">Repository URL</span>
					<input
						class="input"
						bind:value={url}
						required
						maxlength={500}
						placeholder="https://github.com/owner/repo"
					/>
				</label>
				<label class="field">
					<span class="lbl">Starting ref</span>
					<input class="input" bind:value={ref} maxlength={255} placeholder="main" />
				</label>
			</div>
			<div class="modal-ft">
				<span class="xs faint"><span class="kbd">ESC</span> close</span>
				<span class="spacer"></span>
				{#if project.file.mapped}
					<button class="btn btn-sm" type="button" disabled={submitting} onclick={clearMap}>
						Clear
					</button>
				{/if}
				<button class="btn btn-sm" type="button" onclick={() => (open = false)}>Cancel</button>
				<button
					class="btn btn-sm btn-primary"
					type="submit"
					disabled={submitting || url.trim().length === 0}
				>
					{submitting ? 'Saving…' : 'Save checkout'}
				</button>
			</div>
		</form>
	</Dialog.Content>
</Dialog.Root>

<style>
	.map-form {
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
</style>
