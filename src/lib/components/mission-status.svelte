<script lang="ts" module>
	import type { DispatchStatus } from '#lib/types.js';

	/*
	 * The words a person reads for a mission's status, the same on the chat's
	 * mission card, the thread and the Missions page. `launching` and
	 * `launched` are the dispatch machine's steps (docs/file-tackle-dispatch.md):
	 * the runner is being asked, then has answered but no run status has been
	 * observed yet, so neither may claim the agent is running.
	 */
	const LABEL: Record<DispatchStatus, string> = {
		queued: 'queued',
		launching: 'starting',
		launched: 'started',
		running: 'running',
		succeeded: 'succeeded',
		cancelled: 'cancelled',
		failed: 'failed'
	};

	/** The display word for a dispatch status. */
	export function missionStatusLabel(status: DispatchStatus): string {
		return LABEL[status] ?? String(status).replaceAll('_', ' ');
	}
</script>

<script lang="ts">
	/**
	 * Dispatch workflow status using the existing badge + bead colours. A
	 * status that is still moving pulses its dot, so working and settled
	 * read apart without relying on colour alone (the word says it too).
	 */
	import { isBusyStatus } from '#lib/client/agent.js';
	import { dispatchBadgeKey } from '#lib/client/format.js';

	interface Props {
		status: DispatchStatus;
		/**
		 * False when nothing follows the run any more (its runner was removed):
		 * the stored word stays, but the dot stops claiming movement.
		 */
		live?: boolean;
	}

	let { status, live = true }: Props = $props();

	const key = $derived(dispatchBadgeKey(status));
	const label = $derived(missionStatusLabel(status));
	const moving = $derived(live && isBusyStatus(status));
</script>

<span class="badge badge-{key}">
	<i class="dot dot-{key}" class:is-moving={moving} aria-hidden="true"></i>{label}
</span>

<style>
	.is-moving {
		animation: bdui-pulse 1.2s ease-in-out infinite;
	}
</style>
