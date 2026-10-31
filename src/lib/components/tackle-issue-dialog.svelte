<script lang="ts">
	/**
	 * Tackle control: enqueue a /tackle agent for one issue.
	 */
	import { toast } from 'svelte-sonner';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { api, errorMessage } from '$lib/client/api';
	import type { DispatchRequest } from '$lib/types';

	let {
		project_id,
		issue_id,
		issue_title,
		open = $bindable(false),
		show_trigger = true
	}: {
		project_id: string;
		issue_id: string;
		issue_title: string;
		open?: boolean;
		show_trigger?: boolean;
	} = $props();
	let submitting = $state(false);

	function announce(request: DispatchRequest) {
		if (request.status === 'failed') {
			toast.error('The tackling agent did not start', {
				description: request.error_message ?? request.id
			});
			return;
		}
		const url = request.agent_url;
		toast.success('Tackling agent launched', {
			description: url ?? request.id,
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

	async function submit() {
		if (submitting) {
			return;
		}
		submitting = true;
		try {
			const result = await api.tackleIssue(project_id, {
				idempotency_key: crypto.randomUUID(),
				issue_id
			});
			announce(result.request);
			open = false;
		} catch (error) {
			toast.error('Could not launch the tackling agent', { description: errorMessage(error) });
		} finally {
			submitting = false;
		}
	}
</script>

{#if show_trigger}
	<button class="btn btn-sm btn-primary" type="button" onclick={() => (open = true)}>Tackle</button>
{/if}

<Dialog.Root bind:open>
	<Dialog.Content class="ui-dialog ui-dialog-sm" showCloseButton={false}>
		<div class="modal-hd">
			<Dialog.Title class="lbl">Tackle this issue</Dialog.Title>
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
				An agent will claim <b>{issue_id}</b>
				({issue_title}) and try to finish it in the configured environment.
			</p>
		</div>
		<div class="modal-ft">
			<span class="spacer"></span>
			<button class="btn btn-sm" type="button" onclick={() => (open = false)}>Cancel</button>
			<button class="btn btn-sm btn-primary" type="button" disabled={submitting} onclick={submit}>
				{submitting ? 'Launching…' : 'Launch tackling agent'}
			</button>
		</div>
	</Dialog.Content>
</Dialog.Root>

<style>
	.spacer {
		flex: 1;
	}
</style>
