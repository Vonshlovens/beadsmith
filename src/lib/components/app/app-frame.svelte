<script lang="ts">
	/**
	 * A sandboxed app (ADR-0025 rules 3 and 6), framed by the host page. The
	 * document comes from the app's frame route, which serves only the
	 * revision this viewer may see, under a CSP that shuts the network; the
	 * `sandbox` flags give it an opaque origin. Its one way out is the
	 * postMessage bridge (`app-bridge.ts`), which this component wires to the
	 * frame's own window and answers as the viewer.
	 *
	 * The theme is part of the frame's URL (the frame cannot read the page's
	 * preference), so switching it reloads the app with the other tokens.
	 *
	 * An app's action (a todo change or a mission launch) waits for the host
	 * confirmation drawn here, outside the frame, from the action's name and
	 * arguments (`describeBridgeAction`), never from anything the app draws.
	 * Only a confirmed call runs, with those arguments, the revision on screen
	 * and a fresh key per confirmation, so a retried request replays the first
	 * mission instead of starting another. The outcome is also told here, so
	 * the person learns what ran whatever the app shows.
	 */
	import { goto } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import ConfirmDialog from '#lib/components/confirm-dialog.svelte';
	import { api, errorMessage } from '#lib/client/api.js';
	import {
		bridgeActionOutcome,
		describeBridgeAction,
		type BridgeActionCall,
		type BridgeActionConfirm
	} from '#lib/client/surfaces.js';
	import {
		APP_FRAME_DEFAULT_HEIGHT,
		APP_FRAME_SANDBOX,
		appFrameSrc,
		createAppBridge
	} from '#lib/client/app-bridge.js';
	import { PRODUCT_NAME } from '#lib/product.js';
	import type { AccountRole, ResolvedTheme } from '#lib/types.js';

	interface Props {
		slug: string;
		name: string;
		revision: number;
		theme: ResolvedTheme;
		role: AccountRole;
	}

	let { slug, name, revision, theme, role }: Props = $props();

	let frame_el = $state<HTMLIFrameElement | null>(null);
	let height = $state(APP_FRAME_DEFAULT_HEIGHT);

	const src = $derived(appFrameSrc(slug, theme, revision));

	/** The open host confirmation, and how to answer the bridge waiting on it. */
	let pending = $state<{ confirm: BridgeActionConfirm; settle: (ok: boolean) => void } | null>(
		null
	);
	let confirm_open = $state(false);

	function confirmAction(call: BridgeActionCall): Promise<boolean> {
		return new Promise((settle) => {
			pending = { confirm: describeBridgeAction(call, { kind: 'app', name }), settle };
			confirm_open = true;
		});
	}

	/** Answer the waiting bridge once; the dialog closing unconfirmed is a no. */
	function answer(ok: boolean) {
		const waiting = pending;
		pending = null;
		waiting?.settle(ok);
	}

	$effect(() => {
		if (!confirm_open && pending !== null) answer(false);
	});

	async function runAction(call: BridgeActionCall): Promise<unknown> {
		try {
			const response = await api.runAppAction(slug, {
				name: call.tool,
				arguments: call.input,
				revision,
				key: globalThis.crypto.randomUUID()
			});
			const outcome = bridgeActionOutcome(response.result);
			toast.success(
				outcome.message,
				outcome.mission
					? { action: { label: 'Open missions', onClick: () => void goto('/missions') } }
					: {}
			);
			return response.result;
		} catch (error) {
			const message = errorMessage(error);
			toast.error(`${name} could not run ${call.tool}`, { description: message });
			throw new Error(message);
		}
	}

	$effect(() => {
		const el = frame_el;
		if (el === null) return;
		const bridge = createAppBridge({
			frame: () => el.contentWindow,
			// The frame's origin is opaque, so no target origin can name it;
			// the message goes to this iframe's window only, and the page's
			// `frame-src 'self'` keeps that window from navigating anywhere else.
			post: (message) => el.contentWindow?.postMessage(message, '*'),
			callTool: async (tool, args) =>
				(await api.callAppTool(slug, { name: tool, arguments: args })).result,
			confirmAction,
			runAction,
			hostContext: () => ({ theme, displayMode: 'inline', platform: 'web', viewer: { role } }),
			onHeight: (next) => (height = next),
			warn: (reason) => console.warn(`app ${slug}: ${reason}`)
		});
		const listener = (event: MessageEvent) => void bridge.receive(event);
		window.addEventListener('message', listener);
		return () => {
			window.removeEventListener('message', listener);
			answer(false);
		};
	});
</script>

<iframe
	bind:this={frame_el}
	class="app-frame"
	{src}
	title={name}
	sandbox={APP_FRAME_SANDBOX}
	referrerpolicy="no-referrer"
	style:height="{height}px"
></iframe>
<p class="hint app-note">
	Runs sandboxed, with no network. It reads {PRODUCT_NAME} as you, and asks you before it changes anything.
</p>

{#if pending !== null}
	<ConfirmDialog
		bind:open={confirm_open}
		title={pending.confirm.title}
		description={pending.confirm.description}
		confirm_label={pending.confirm.confirm_label}
		destructive={pending.confirm.destructive}
		onconfirm={() => answer(true)}
	/>
{/if}

<style>
	.app-frame {
		display: block;
		width: 100%;
		border: 1px solid var(--line-2);
		border-radius: var(--r-2);
		background: var(--bg);
	}
	.app-note {
		margin-top: var(--s-2);
	}
</style>
