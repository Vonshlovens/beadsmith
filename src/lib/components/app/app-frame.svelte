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
	 */
	import { api } from '#lib/client/api.js';
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
			hostContext: () => ({ theme, displayMode: 'inline', platform: 'web', viewer: { role } }),
			onHeight: (next) => (height = next),
			warn: (reason) => console.warn(`app ${slug}: ${reason}`)
		});
		const listener = (event: MessageEvent) => void bridge.receive(event);
		window.addEventListener('message', listener);
		return () => window.removeEventListener('message', listener);
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
<p class="hint app-note">Runs sandboxed, with no network. It reads {PRODUCT_NAME} as you.</p>

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
