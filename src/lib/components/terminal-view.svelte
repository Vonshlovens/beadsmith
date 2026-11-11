<script lang="ts">
	/**
	 * An agent's live terminal, exactly as its CLI draws it (ADR-0021 rule 4),
	 * beside the sanitized thread. Admins only: callers render it for admins on
	 * runners that relay a terminal, and the server refuses everyone else.
	 *
	 * Closed until asked. **Watch** follows the agent's own grid read-only and
	 * never wakes a paused sandbox. **Take over** (behind a confirm) types into
	 * it, resizes it to this box and wakes it if paused; **Hand back** detaches
	 * and goes back to watching. Who is typing is always written in the strip,
	 * not only coloured. While taken over, every key goes to the agent (Esc
	 * included: Claude Code uses it to interrupt), so the app's hotkeys stay
	 * quiet; Shift+Esc is the way out. Screens without a fine pointer, or
	 * narrower than a keyboard-sized terminal, get Watch only.
	 *
	 * The screen is always dark: the CLI picks its colours for a dark terminal
	 * whatever the app's theme, so a light screen would wash them out.
	 * Connection, reconnect and state live in `$lib/client/terminal-relay.ts`;
	 * this component wires them to xterm.js, loaded on first open.
	 */
	import '@xterm/xterm/css/xterm.css';
	import type { Terminal } from '@xterm/xterm';
	import type { FitAddon } from '@xterm/addon-fit';
	import { onDestroy, tick, untrack } from 'svelte';
	import ArrowClockwiseIcon from 'phosphor-svelte/lib/ArrowClockwiseIcon';
	import EyeIcon from 'phosphor-svelte/lib/EyeIcon';
	import HandPalmIcon from 'phosphor-svelte/lib/HandPalmIcon';
	import KeyboardIcon from 'phosphor-svelte/lib/KeyboardIcon';
	import TerminalWindowIcon from 'phosphor-svelte/lib/TerminalWindowIcon';
	import XIcon from 'phosphor-svelte/lib/XIcon';
	import ConfirmDialog from '#lib/components/confirm-dialog.svelte';
	import { tip } from '#lib/client/tooltip.js';
	import {
		RelayConnection,
		relayView,
		type RelayMode,
		type RelaySize,
		type RelayState,
		type RelayTarget
	} from '#lib/client/terminal-relay.js';

	interface Props {
		target: RelayTarget;
		/** What the agent is, for the confirm: "this mission's agent". */
		subject?: string;
	}

	let { target, subject = "this agent's" }: Props = $props();

	/** Take-over needs a keyboard and a terminal-sized box. */
	const KEYBOARD_QUERY = '(hover: hover) and (pointer: fine) and (min-width: 640px)';

	let relay_state = $state<RelayState>({ phase: 'idle' });
	let has_keyboard = $state(false);
	let confirming = $state(false);
	let load_error = $state<string | null>(null);
	/** The box is shown before the first relay opens, so xterm can measure it. */
	let preparing = $state(false);
	let host = $state<HTMLDivElement | null>(null);
	let hand_back_el = $state<HTMLButtonElement | null>(null);
	let watch_el = $state<HTMLButtonElement | null>(null);

	const view = $derived(relayView(relay_state, has_keyboard));
	const mode = $derived<RelayMode | undefined>(
		'mode' in relay_state ? relay_state.mode : undefined
	);

	let term: Terminal | null = null;
	let fit: FitAddon | null = null;
	const encoder = new TextEncoder();

	$effect(() => {
		const query = window.matchMedia(KEYBOARD_QUERY);
		has_keyboard = query.matches;
		const update = () => (has_keyboard = query.matches);
		query.addEventListener('change', update);
		return () => query.removeEventListener('change', update);
	});

	/** The grid this box holds at the current font, for opening and take-over. */
	function measured(): RelaySize {
		const proposed = fit?.proposeDimensions();
		return proposed && proposed.cols > 0 && proposed.rows > 0
			? { cols: proposed.cols, rows: proposed.rows }
			: { cols: 80, rows: 24 };
	}

	function fitToBox() {
		if (term === null || fit === null || mode !== 'take_over') return;
		fit.fit();
		connection?.resize({ cols: term.cols, rows: term.rows });
	}

	function sizeTo(size: RelaySize) {
		if (term !== null && (term.cols !== size.cols || term.rows !== size.rows)) {
			term.resize(size.cols, size.rows);
		}
	}

	let connection: RelayConnection | null = null;
	// Parents rebuild `target` on every poll; only a different mission or chat
	// is a new terminal.
	const target_key = $derived(
		'mission' in target ? `mission:${target.mission}` : `chat:${target.chat}`
	);
	// One connection per target; a new mission or chat starts closed.
	$effect(() => {
		void target_key;
		const fixed = untrack(() => $state.snapshot(target) as RelayTarget);
		const current = new RelayConnection(fixed, measured, {
			onState(state) {
				relay_state = state;
			},
			onOutput(bytes) {
				term?.write(bytes);
			},
			onOpen(size, opened_mode) {
				term?.reset();
				if (opened_mode === 'take_over') {
					void tick().then(() => {
						fitToBox();
						term?.focus();
					});
				} else {
					sizeTo(size);
				}
			},
			onResize(size) {
				sizeTo(size);
			}
		});
		connection = current;
		relay_state = current.state;
		return () => {
			current.close();
			if (connection === current) connection = null;
		};
	});

	function themeOf(el: HTMLElement) {
		const style = getComputedStyle(el);
		const read = (name: string) => style.getPropertyValue(name).trim();
		return {
			background: read('--term-bg'),
			foreground: read('--term-fg'),
			cursor: read('--term-cursor'),
			cursorAccent: read('--term-bg'),
			selectionBackground: read('--term-select')
		};
	}

	/** Load xterm.js the first time a relay opens, and mount it in the box. */
	async function ensureTerminal(): Promise<boolean> {
		if (term !== null) return true;
		await tick();
		const el = host;
		if (el === null) return false;
		try {
			const [{ Terminal: XTerm }, { FitAddon: Fit }] = await Promise.all([
				import('@xterm/xterm'),
				import('@xterm/addon-fit')
			]);
			const created = new XTerm({
				fontFamily: getComputedStyle(el).getPropertyValue('--font-mono').trim() || 'monospace',
				fontSize: 12,
				lineHeight: 1.15,
				cursorBlink: false,
				disableStdin: true,
				scrollback: 2000,
				allowProposedApi: false,
				theme: themeOf(el)
			});
			const addon = new Fit();
			created.loadAddon(addon);
			created.open(el);
			created.onData((data) => connection?.write(encoder.encode(data)));
			created.onBinary((data) =>
				connection?.write(Uint8Array.from(data, (char) => char.charCodeAt(0)))
			);
			// The way out of a taken-over terminal: Shift+Esc never reaches the agent.
			created.attachCustomKeyEventHandler((event) => {
				if (event.key === 'Escape' && event.shiftKey) {
					if (event.type === 'keydown') {
						event.preventDefault();
						leaveTerminal();
					}
					return false;
				}
				return true;
			});
			term = created;
			fit = addon;
			load_error = null;
			return true;
		} catch {
			load_error = 'The terminal view could not be loaded. Reload the page and try again.';
			return false;
		}
	}

	async function open(next: RelayMode) {
		preparing = true;
		try {
			if (!(await ensureTerminal())) return;
			connection?.open(next);
		} finally {
			preparing = false;
		}
	}

	function close() {
		connection?.close();
		void tick().then(() => watch_el?.focus());
	}

	function handBack() {
		// Detaching hands the terminal back (ADR-0021); keep watching it.
		void open('watch');
	}

	function leaveTerminal() {
		term?.blur();
		void tick().then(() => hand_back_el?.focus());
	}

	// Typing goes to the agent only while it is ours.
	$effect(() => {
		if (term !== null) term.options.disableStdin = !view.input;
	});

	// A taken-over terminal follows this box; a watched one keeps the agent's grid.
	$effect(() => {
		const el = host;
		if (el === null || mode !== 'take_over') return;
		let frame = 0;
		const observer = new ResizeObserver(() => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(fitToBox);
		});
		observer.observe(el);
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
		};
	});

	// Follow the app's theme switch.
	$effect(() => {
		const el = host;
		if (el === null) return;
		const observer = new MutationObserver(() => {
			if (term !== null) term.options.theme = themeOf(el);
		});
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
		return () => observer.disconnect();
	});

	/**
	 * While the admin types, keys stop here so the page's hotkeys (Esc closes
	 * the thread, `/` searches) never steal them from the agent.
	 */
	function keepKeys(el: HTMLElement) {
		const stop = (event: KeyboardEvent) => {
			if (view.input) event.stopPropagation();
		};
		el.addEventListener('keydown', stop);
		return () => el.removeEventListener('keydown', stop);
	}

	onDestroy(() => {
		term?.dispose();
		term = null;
		fit = null;
	});
</script>

<section class="term" aria-label="Agent terminal">
	<div class="tm-bar">
		<TerminalWindowIcon size={14} aria-hidden="true" />
		<span class="tm-ti">Terminal</span>
		<span class="tm-state tone-{view.tone}" role="status" aria-live="polite">
			<span class="tm-dot" aria-hidden="true"></span>{view.label}
		</span>
		<span class="spacer"></span>
		<div class="tm-actions">
			{#if view.can_watch}
				<button
					bind:this={watch_el}
					class="btn btn-sm"
					type="button"
					{@attach tip(relay_state.phase === 'idle' ? view.detail : null)}
					onclick={() => void open('watch')}
				>
					<EyeIcon size={13} aria-hidden="true" />
					{relay_state.phase === 'ended' ? 'Watch again' : 'Watch'}
				</button>
			{/if}
			{#if view.can_retry}
				<button class="btn btn-sm" type="button" onclick={() => void open(mode ?? 'watch')}>
					<ArrowClockwiseIcon size={13} aria-hidden="true" />
					Try again
				</button>
			{/if}
			{#if view.can_take_over}
				<button class="btn btn-sm" type="button" onclick={() => (confirming = true)}>
					<KeyboardIcon size={13} aria-hidden="true" />
					Take over…
				</button>
			{/if}
			{#if view.can_hand_back}
				<button
					bind:this={hand_back_el}
					class="btn btn-sm btn-primary"
					type="button"
					onclick={handBack}
				>
					<HandPalmIcon size={13} aria-hidden="true" />
					Hand back
				</button>
			{/if}
			{#if view.can_close}
				<button
					class="btn btn-sm btn-ghost btn-icon"
					type="button"
					aria-label="Close the terminal"
					{@attach tip('Close the terminal')}
					onclick={close}
				>
					<XIcon size={14} aria-hidden="true" />
				</button>
			{/if}
		</div>
	</div>

	<!-- Closed, the strip stays one line; Watch's tip carries the explanation. -->
	{#if relay_state.phase !== 'idle' || load_error !== null}
		<p class="tm-detail" class:is-err={view.tone === 'danger' || load_error !== null}>
			{load_error ?? view.detail}
			{#if !has_keyboard && relay_state.phase !== 'unavailable'}
				<span class="tm-ro">Taking over needs a keyboard; on this screen you can watch.</span>
			{/if}
		</p>
	{/if}

	<div class="tm-frame" class:is-typing={view.input} hidden={!view.show_screen && !preparing}>
		<div
			class="tm-screen"
			class:is-fit={mode === 'take_over'}
			bind:this={host}
			{@attach keepKeys}
		></div>
	</div>
	{#if view.input}
		<p class="tm-keys">
			Every key goes to the agent, Esc included. <kbd>Shift</kbd>+<kbd>Esc</kbd> leaves the terminal.
		</p>
	{/if}
</section>

<ConfirmDialog
	bind:open={confirming}
	title="Take over the terminal?"
	description="Your keys go straight into {subject} terminal and it resizes to your window. A paused sandbox wakes up. The take-over is recorded under your account; hand back when you are done."
	confirm_label="Take over"
	onconfirm={() => void open('take_over')}
/>

<style>
	.term {
		/* The CLI draws for a dark terminal in either theme. */
		--term-bg: var(--rule);
		--term-fg: var(--s1);
		--term-cursor: var(--em-700);
		--term-select: rgba(235, 228, 216, 0.25);
		display: flex;
		flex-direction: column;
		gap: var(--s-2);
		min-width: 0;
	}
	:global(:root.dark) .term {
		--term-bg: var(--void);
		--term-fg: var(--tx);
		--term-cursor: var(--em-500);
		--term-select: var(--em-wash-2);
	}
	.tm-bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-2);
		min-height: 28px;
		color: var(--tx-mid);
	}
	.tm-ti {
		font-size: var(--t-sm);
		font-weight: 600;
		color: var(--tx-hi);
	}
	.tm-state {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: var(--t-xs);
		color: var(--tx-dim);
	}
	.tm-dot {
		width: 7px;
		height: 7px;
		border-radius: 99px;
		background: var(--tx-faint);
	}
	.tone-pending .tm-dot {
		background: var(--amber);
	}
	.tone-pending {
		color: var(--amber-tx);
	}
	.tone-live .tm-dot {
		background: var(--mint);
	}
	.tone-live {
		color: var(--mint-tx);
	}
	.tone-typing .tm-dot {
		background: var(--em-500);
		box-shadow: var(--glow-dot);
	}
	.tone-typing {
		color: var(--em-300);
		font-weight: 600;
	}
	.tone-danger {
		color: var(--danger-tx);
	}
	.tone-danger .tm-dot {
		background: var(--danger);
	}
	.spacer {
		flex: 1;
	}
	.tm-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-1);
	}
	.tm-detail {
		margin: 0;
		font-size: var(--t-xs);
		line-height: 1.5;
		color: var(--tx-dim);
	}
	.tm-detail.is-err {
		color: var(--danger-tx);
	}
	.tm-ro {
		display: block;
		color: var(--tx-faint);
	}
	.tm-frame {
		border: 1px solid var(--line-2);
		border-radius: var(--r-2);
		background: var(--term-bg);
		/* The agent's grid may be wider or taller than this box: scroll it. */
		max-height: min(55vh, 460px);
		overflow: auto;
		padding: var(--s-2);
	}
	.tm-frame[hidden] {
		display: none;
	}
	.tm-frame.is-typing {
		border-color: var(--em-500);
		box-shadow: 0 0 0 1px var(--em-500);
	}
	.tm-frame:focus-within {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}
	.tm-screen {
		width: max-content;
		min-width: 100%;
	}
	.tm-screen.is-fit {
		/* Taken over, the grid follows the box instead. */
		width: 100%;
		height: min(55vh, 440px);
	}
	.tm-keys {
		margin: 0;
		font-size: var(--t-xs);
		color: var(--tx-mid);
	}
	kbd {
		font-family: var(--font-mono);
		font-size: var(--t-micro);
		padding: 0 4px;
		border: 1px solid var(--line-2);
		border-radius: var(--r-1);
		background: var(--s2);
		color: var(--tx-hi);
	}
	@media (prefers-reduced-motion: no-preference) {
		.tm-frame {
			transition: border-color 120ms ease-out;
		}
	}
</style>
