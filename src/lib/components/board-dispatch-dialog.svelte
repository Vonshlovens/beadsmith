<script lang="ts">
	/**
	 * Confirm a board drop: enqueue an agent for the destination status.
	 * The card is not moved; Beads status changes only after the worker uses bd.
	 */
	import { toast } from 'svelte-sonner';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { api, errorMessage } from '$lib/client/api';
	import {
		boardDispatchStatusCopy,
		type BoardDispatchAction,
		type BoardDispatchPending
	} from '$lib/client/board-dispatch';
	import type { DispatchRequest } from '$lib/types';

	let {
		project_id,
		pending = $bindable(null),
		dispatch_enabled,
		tackle_enabled
	}: {
		project_id: string;
		pending: BoardDispatchPending | null;
		dispatch_enabled: boolean;
		tackle_enabled: boolean;
	} = $props();

	let submitting = $state(false);
	let open = $state(false);

	$effect(() => {
		if (pending !== null) {
			open = true;
		}
	});

	const labels = $derived(
		pending === null
			? { source_label: '', destination_label: '' }
			: boardDispatchStatusCopy(pending.source_status, pending.action.destination)
	);
	const can_launch = $derived(dispatch_enabled && tackle_enabled);
	const blocked_reason = $derived(
		!dispatch_enabled
			? 'Agent dispatch is unavailable. The card stays in its current column.'
			: !tackle_enabled
				? 'Tackle is not allowed for this project. The card stays in its current column.'
				: undefined
	);

	function close() {
		if (submitting) {
			return;
		}
		if (pending !== null) {
			toast.info('Dispatch cancelled', {
				description: 'The issue stays in its current column. Status was not changed.'
			});
		}
		open = false;
		pending = null;
	}

	function announce(request: DispatchRequest, action: BoardDispatchAction) {
		if (request.status === 'failed') {
			toast.error('The agent did not start', {
				description: request.error_message ?? request.id
			});
			return;
		}
		const url = request.agent_url;
		toast.success(`${action.confirm_title} — launched`, {
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
		if (pending === null || submitting || !can_launch) {
			return;
		}
		const current = pending;
		submitting = true;
		try {
			const result = await api.tackleIssue(project_id, {
				idempotency_key: crypto.randomUUID(),
				issue_id: current.issue.id,
				destination_status: current.action.destination
			});
			announce(result.request, current.action);
			pending = null;
			open = false;
		} catch (error) {
			toast.error('Could not launch the agent', { description: errorMessage(error) });
		} finally {
			submitting = false;
		}
	}
</script>

<Dialog.Root
	bind:open
	onOpenChange={(next) => {
		if (!next) close();
	}}
>
	<Dialog.Content class="ui-dialog ui-dialog-sm" showCloseButton={false}>
		{#if pending}
			<div class="modal-hd">
				<Dialog.Title class="lbl">{pending.action.confirm_title}</Dialog.Title>
				<span class="spacer"></span>
				<button class="btn btn-sm btn-icon" type="button" aria-label="Close" onclick={close}>
					✕
				</button>
			</div>
			<div class="modal-bd">
				<p class="hint">
					{pending.action.confirm_question}
				</p>
				<p class="hint">
					<b>{pending.issue.id}</b>
					({pending.issue.title}) stays in <b>{labels.source_label}</b> until an agent changes
					Beads. Destination: <b>{labels.destination_label}</b>.
				</p>
				{#if blocked_reason}
					<p class="hint" role="status">{blocked_reason}</p>
				{/if}
			</div>
			<div class="modal-ft">
				<span class="spacer"></span>
				<button class="btn btn-sm" type="button" onclick={close}>Cancel</button>
				<button
					class="btn btn-sm btn-primary"
					type="button"
					disabled={!can_launch || submitting}
					onclick={submit}
				>
					{submitting ? 'Launching…' : pending.action.confirm_button}
				</button>
			</div>
		{/if}
	</Dialog.Content>
</Dialog.Root>

<style>
	.spacer {
		flex: 1;
	}
</style>
