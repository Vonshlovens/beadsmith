<script lang="ts">
	/**
	 * The catalog's Button (ADR-0025 rule 6). Pressing it opens the host's
	 * confirmation, drawn by the page outside the surface tree from the stored
	 * action itself (`describeBridgeAction`): it names the operation, project
	 * and issue, not the button's label, so a surface cannot dress one action
	 * up as another, and nothing in the tree can draw, skip or pre-answer it.
	 * Only a confirmed press calls the bridge, as the viewer, naming the
	 * revision on screen and one key per confirmation, so a retried request
	 * replays the first mission instead of starting another.
	 *
	 * A member sees the button disabled with the reason in visible text
	 * (docs/design-standards.md, "Disabled controls need an understandable
	 * reason"); the server refuses them regardless.
	 */
	import { goto, invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import ConfirmDialog from '#lib/components/confirm-dialog.svelte';
	import { api, errorMessage } from '#lib/client/api.js';
	import {
		describeBridgeAction,
		bridgeActionOutcome,
		type SurfaceActionShape,
		type SurfaceHost
	} from '#lib/client/surfaces.js';

	interface Props {
		label: string;
		tone: 'default' | 'primary' | 'danger';
		/** The action's name in the spec. */
		name: string;
		/** The stored action; the server refused a button naming none. */
		action: SurfaceActionShape | undefined;
		host: SurfaceHost;
		surface_name: string;
	}

	let { label, tone, name, action, host, surface_name }: Props = $props();

	const reason_id = $props.id();
	let open = $state(false);
	let running = $state(false);
	/** Made when the dialog opens, so a double submit of one confirmation is one run. */
	let key = $state('');

	const confirm = $derived(
		action === undefined
			? undefined
			: describeBridgeAction(action, { kind: 'surface', name: surface_name })
	);
	const reason = $derived(
		!host.can_act
			? 'Surface actions need an admin account.'
			: action === undefined
				? 'This button has no action.'
				: undefined
	);

	function press() {
		if (reason !== undefined || running) return;
		key = globalThis.crypto.randomUUID();
		open = true;
	}

	async function run() {
		if (running) return;
		running = true;
		try {
			const response = await api.runSurfaceAction(host.slug, name, {
				revision: host.revision,
				key
			});
			const outcome = bridgeActionOutcome(response.result);
			toast.success(
				outcome.message,
				outcome.mission
					? { action: { label: 'Open missions', onClick: () => void goto('/missions') } }
					: {}
			);
			// The surface's own bindings may read what just changed.
			await invalidateAll();
		} catch (error) {
			toast.error(`${label} did not run`, { description: errorMessage(error) });
		} finally {
			running = false;
		}
	}
</script>

<span class="sf-btn">
	<button
		class="btn btn-sm"
		class:btn-primary={tone === 'primary'}
		class:btn-danger={tone === 'danger'}
		type="button"
		aria-disabled={reason !== undefined || running ? 'true' : undefined}
		aria-describedby={reason === undefined ? undefined : reason_id}
		aria-busy={running ? 'true' : undefined}
		onclick={press}
	>
		{running ? `${label}…` : label}
	</button>
	{#if reason !== undefined}
		<span class="hint" id={reason_id}>{reason}</span>
	{/if}
</span>

{#if confirm !== undefined}
	<ConfirmDialog
		bind:open
		title={confirm.title}
		description={confirm.description}
		confirm_label={confirm.confirm_label}
		destructive={confirm.destructive}
		onconfirm={run}
	/>
{/if}

<style>
	.sf-btn {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-2);
	}
	.sf-btn button[aria-disabled='true'] {
		cursor: not-allowed;
		opacity: 0.7;
	}
</style>
