<script lang="ts">
	/**
	 * Edit or clear a console-persisted Tackle map. Env/file maps stay locked.
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

	const env_locked = $derived(project.tackle.mapped && project.tackle.source === 'env');

	let url = $state('');
	let ref = $state('main');
	let auto_create_pr = $state(true);
	let submitting = $state(false);

	function resetFromProject() {
		if (project.tackle.mapped) {
			url = project.tackle.url;
			ref = project.tackle.ref;
			auto_create_pr = project.tackle.auto_create_pr;
			return;
		}
		url = '';
		ref = 'main';
		auto_create_pr = true;
	}

	$effect(() => {
		if (open) {
			resetFromProject();
		}
	});

	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (submitting || env_locked || url.trim().length === 0) {
			return;
		}
		submitting = true;
		try {
			await api.putTackleMap(project.id, {
				url: url.trim(),
				ref: ref.trim() || undefined,
				auto_create_pr
			});
			toast.success('Tackle map saved', { description: project.id });
			open = false;
			await onSaved();
		} catch (error) {
			toast.error('Could not save the Tackle map', { description: errorMessage(error) });
		} finally {
			submitting = false;
		}
	}

	async function clearMap() {
		if (submitting || env_locked || !project.tackle.mapped) {
			return;
		}
		submitting = true;
		try {
			await api.deleteTackleMap(project.id);
			toast.success('Tackle map cleared', { description: project.id });
			open = false;
			await onSaved();
		} catch (error) {
			toast.error('Could not clear the Tackle map', { description: errorMessage(error) });
		} finally {
			submitting = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="ui-dialog ui-dialog-sm" showCloseButton={false}>
		<form class="map-form" onsubmit={save}>
			<div class="modal-hd">
				<Dialog.Title class="lbl">Tackle map</Dialog.Title>
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
				{#if env_locked}
					<p class="hint">
						This map is set in service configuration. Clear or change it there; the console cannot
						override it.
					</p>
				{:else}
					<p class="hint">
						Tackle launches this GitHub checkout. File uses a separate checkout map, or the
						beads-web default when that map is unset. Maps are stored on this service, not in Beads.
					</p>
				{/if}
				<label class="field">
					<span class="lbl">Repository URL</span>
					<input
						class="input"
						bind:value={url}
						required
						maxlength={500}
						placeholder="https://github.com/owner/repo"
						disabled={env_locked}
					/>
				</label>
				<label class="field">
					<span class="lbl">Starting ref</span>
					<input
						class="input"
						bind:value={ref}
						maxlength={255}
						placeholder="main"
						disabled={env_locked}
					/>
				</label>
				<label class="check">
					<input type="checkbox" bind:checked={auto_create_pr} disabled={env_locked} />
					<span>Open a pull request</span>
				</label>
			</div>
			<div class="modal-ft">
				<span class="xs faint"><span class="kbd">ESC</span> close</span>
				<span class="spacer"></span>
				{#if project.tackle.mapped && project.tackle.source === 'sqlite'}
					<button class="btn btn-sm" type="button" disabled={submitting} onclick={clearMap}>
						Clear
					</button>
				{/if}
				<button class="btn btn-sm" type="button" onclick={() => (open = false)}>Cancel</button>
				<button
					class="btn btn-sm btn-primary"
					type="submit"
					disabled={submitting || env_locked || url.trim().length === 0}
				>
					{submitting ? 'Saving…' : 'Save map'}
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
	.check {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		margin-top: var(--s-3);
		font-size: var(--t-sm);
	}
</style>
