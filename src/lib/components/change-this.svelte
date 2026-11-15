<script lang="ts">
	/**
	 * "Change this" mode (ADR-0025 rule 10), admins only. While it is on,
	 * the page is an inspector: the element under the pointer is outlined, a
	 * click or tap selects it instead of activating it, and a popover asks
	 * what should change. Send launches an ordinary File mission into the
	 * project that tracks Beadsmith's own code, with the page context
	 * attached (`src/lib/client/change-this.ts` builds it; `prompts.ts`
	 * fences it as data). The mode exits after a send, so every request
	 * starts from a fresh look at the page.
	 *
	 * The outlines are fixed boxes drawn over the page with pointer events
	 * off: the page's own elements and styles are never touched, only the
	 * root's `data-change-this-on` attribute (for the crosshair cursor).
	 * Pointer handlers run in the capture phase and stop the event, so a
	 * link, button or menu trigger under the pointer never fires. The mode's
	 * own nodes carry `data-change-this` and pass through.
	 *
	 * Keyboard: Tab to an element and press Enter (or Space) to select it;
	 * arrows move to the parent, first child and siblings; Enter describes
	 * the selection; Esc closes the popover, then leaves the mode. Shift-click
	 * adds an element, up to five.
	 */
	import { tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { toast } from 'svelte-sonner';
	import CrosshairIcon from 'phosphor-svelte/lib/CrosshairIcon';
	import XIcon from 'phosphor-svelte/lib/XIcon';
	import SelectField from '#lib/components/select-field.svelte';
	import { api, errorMessage } from '#lib/client/api.js';
	import {
		buildChangeRequest,
		describeElement,
		isOwnNode,
		moveSelection,
		popoverPlacement,
		SELECTION_KEYS,
		type InspectElement
	} from '#lib/client/change-this.js';
	import { missionThreadHref } from '#lib/client/first-mate.js';
	import { useHotkeys } from '#lib/client/hotkeys.svelte.js';
	import { currentViewer, projectList, statusSnapshot } from '#lib/client/projects.svelte.js';
	import { app_state } from '#lib/client/stores.svelte.js';
	import { CHANGE_REQUEST_LIMITS } from '#lib/change-request.js';

	interface Box {
		x: number;
		y: number;
		width: number;
		height: number;
	}

	const NOTES_MAX = 8000;

	const available = $derived(
		currentViewer()?.role === 'admin' && statusSnapshot()?.dispatch.enabled === true
	);
	const on = $derived(available && app_state.change_this_on);

	let hovered = $state<Element | null>(null);
	let selection = $state.raw<Element[]>([]);
	let prompting = $state(false);
	let sending = $state(false);
	let text = $state('');
	/** Re-measured on scroll and resize so the outlines follow the page. */
	let layout_tick = $state(0);
	let viewport = $state({ width: 0, height: 0 });
	let popover_size = $state({ width: 360, height: 280 });
	let textarea = $state<HTMLTextAreaElement | null>(null);
	let indicator = $state<HTMLElement | null>(null);

	/** The stored project, and the pick in the popover (which becomes the stored one on Send). */
	let stored_project = $state<string | null>(null);
	let project_id = $state('');
	let project_loaded = $state(false);
	/** Not reactive: the stored project is read once per page load. */
	let project_requested = false;

	const file_projects = $derived(projectList().filter((project) => project.allow?.file !== false));
	const project_items = $derived(
		file_projects.map((project) => ({
			value: project.id,
			label: project.name
		}))
	);

	const primary = $derived(selection.at(-1) ?? null);

	function measure(element: Element | null): Box | null {
		void layout_tick;
		if (element === null || !element.isConnected) return null;
		const rect = element.getBoundingClientRect();
		return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
	}

	const hover_box = $derived(
		hovered !== null && !selection.includes(hovered) ? measure(hovered) : null
	);
	const selection_boxes = $derived(selection.map((element) => measure(element)));
	const primary_box = $derived(measure(primary));
	const placement = $derived(
		primary_box === null || viewport.width === 0
			? { top: 16, left: 16 }
			: popoverPlacement(primary_box, viewport, popover_size)
	);

	function label(element: Element): string {
		const tag = element.tagName.toLowerCase();
		const name = element.getAttribute('aria-label') ?? element.textContent ?? '';
		const short = name.replace(/\s+/g, ' ').trim().slice(0, 40);
		return short.length > 0 ? `${tag} · ${short}` : tag;
	}

	/** Pointer and keyboard both land here. */
	function passThrough(target: EventTarget | null): boolean {
		if (!(target instanceof Element)) return true;
		if (isOwnNode(target as unknown as InspectElement)) return true;
		// The project picker's list and the toasts are portaled outside the popover.
		return target.closest('[role="listbox"], [data-sonner-toaster]') !== null;
	}

	/** The element a pointer or key lands on; an icon's inner path counts as the icon. */
	function pickable(element: Element | null): Element | null {
		if (element === null) return null;
		const target = element.closest('svg') ?? element;
		const tag = target.tagName.toLowerCase();
		return tag === 'html' || tag === 'body' ? null : target;
	}

	function select(element: Element, add: boolean) {
		if (add) {
			const rest = selection.filter((existing) => existing !== element);
			selection = [...rest, element].slice(-CHANGE_REQUEST_LIMITS.elements);
		} else {
			selection = [element];
		}
		void openPrompt();
	}

	async function openPrompt() {
		if (primary === null) return;
		prompting = true;
		await tick();
		textarea?.focus({ preventScroll: true });
	}

	function closePrompt() {
		prompting = false;
		indicator?.focus({ preventScroll: true });
	}

	/** Leave the mode and give focus back to the toggle that started it. */
	function exitMode() {
		app_state.change_this_on = false;
		document.querySelector<HTMLElement>('.change-this-toggle')?.focus({ preventScroll: true });
	}

	function onPointerMove(event: PointerEvent) {
		if (event.pointerType === 'touch' || passThrough(event.target)) {
			if (passThrough(event.target)) hovered = null;
			return;
		}
		hovered = pickable(event.target as Element);
	}

	/** Swallow the press so focus, drags and menu triggers on the page stay put. */
	function onPress(event: Event) {
		if (passThrough(event.target)) return;
		event.preventDefault();
		event.stopPropagation();
	}

	function onClick(event: MouseEvent) {
		if (passThrough(event.target)) return;
		event.preventDefault();
		event.stopPropagation();
		const element = pickable(event.target as Element);
		if (element !== null && !sending) select(element, event.shiftKey);
	}

	function remeasure() {
		viewport = { width: window.innerWidth, height: window.innerHeight };
		layout_tick += 1;
	}

	let frame = 0;
	function onScrollOrResize() {
		if (frame !== 0) return;
		frame = requestAnimationFrame(() => {
			frame = 0;
			remeasure();
		});
	}

	$effect(() => {
		if (!on) return;
		const root = document.documentElement;
		root.setAttribute('data-change-this-on', '');
		remeasure();
		const capture = { capture: true } as const;
		document.addEventListener('pointermove', onPointerMove, capture);
		document.addEventListener('pointerdown', onPress, capture);
		document.addEventListener('pointerup', onPress, capture);
		document.addEventListener('mousedown', onPress, capture);
		document.addEventListener('mouseup', onPress, capture);
		document.addEventListener('click', onClick, capture);
		document.addEventListener('dblclick', onPress, capture);
		window.addEventListener('scroll', onScrollOrResize, { capture: true, passive: true });
		window.addEventListener('resize', onScrollOrResize);
		return () => {
			root.removeAttribute('data-change-this-on');
			document.removeEventListener('pointermove', onPointerMove, capture);
			document.removeEventListener('pointerdown', onPress, capture);
			document.removeEventListener('pointerup', onPress, capture);
			document.removeEventListener('mousedown', onPress, capture);
			document.removeEventListener('mouseup', onPress, capture);
			document.removeEventListener('click', onClick, capture);
			document.removeEventListener('dblclick', onPress, capture);
			window.removeEventListener('scroll', onScrollOrResize, capture);
			window.removeEventListener('resize', onScrollOrResize);
			if (frame !== 0) cancelAnimationFrame(frame);
			frame = 0;
		};
	});

	/** Entering the mode starts clean and reads the stored project; leaving resets everything. */
	$effect(() => {
		if (!on) {
			hovered = null;
			selection = [];
			prompting = false;
			return;
		}
		void tick().then(() => indicator?.focus({ preventScroll: true }));
		if (project_requested) return;
		project_requested = true;
		api
			.changeThisProject()
			.then(({ project_id: stored }) => {
				stored_project = stored;
				if (project_id === '' && stored !== null) project_id = stored;
			})
			.catch(() => {
				// Unreadable: the picker starts empty and Send stores the pick.
			})
			.finally(() => {
				project_loaded = true;
			});
	});

	/** Leaving a page that the selection belonged to drops it. */
	$effect(() => {
		void page.url.pathname;
		selection = [];
		hovered = null;
		prompting = false;
	});

	function moveBy(key: string): boolean | void {
		const move = SELECTION_KEYS[key];
		if (move === undefined || prompting) return false;
		const start =
			primary ?? hovered ?? document.querySelector('main') ?? document.body.firstElementChild;
		if (start === null) return false;
		const next =
			primary === null
				? start
				: (moveSelection(primary as unknown as InspectElement, move) as unknown as Element | null);
		if (next === null) return;
		selection = [next];
		next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	}

	function confirmSelection(): boolean | void {
		if (prompting) return false;
		if (primary !== null) {
			void openPrompt();
			return;
		}
		const focused = document.activeElement;
		const element =
			focused !== null && !passThrough(focused)
				? pickable(focused)
				: document.querySelector('main');
		if (element !== null) select(element, false);
	}

	useHotkeys(
		() =>
			!on
				? []
				: [
						{
							keys: ['\\'],
							label: 'Leave Change this',
							group: 'General',
							run: exitMode
						},
						{
							keys: ['Escape'],
							label: 'Close the request, then leave Change this',
							group: 'General',
							in_fields: true,
							run: () => {
								if (sending) return;
								if (prompting) closePrompt();
								else exitMode();
							}
						},
						{
							keys: ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'],
							label: 'Move the selection to the parent, child or a sibling',
							group: 'General',
							run: (event) => moveBy(event.key)
						},
						{
							keys: ['Enter', 'Space'],
							label: 'Select the focused element, or describe the selection',
							group: 'General',
							run: confirmSelection
						},
						{
							keys: ['mod+Enter'],
							label: 'Send the change request',
							group: 'General',
							in_fields: true,
							run: () => {
								if (!prompting) return false;
								void send();
							}
						}
					],
		// While on, the mode owns the keyboard: no page key may act on what is under it.
		{ modal: () => on }
	);

	const can_send = $derived(
		!sending && text.trim().length > 0 && project_id !== '' && selection.length > 0
	);

	async function send(event?: SubmitEvent) {
		event?.preventDefault();
		if (!can_send) return;
		sending = true;
		const target = project_id;
		try {
			if (target !== stored_project) {
				try {
					await api.setChangeThisProject(target);
					stored_project = target;
				} catch (error) {
					toast.error('Could not remember the project', { description: errorMessage(error) });
				}
			}
			const byId = (id: string) => document.getElementById(id) as unknown as InspectElement | null;
			const elements = selection
				.filter((element) => element.isConnected)
				.map((element) => {
					const rect = element.getBoundingClientRect();
					return describeElement(
						element as unknown as InspectElement,
						{ x: rect.left, y: rect.top, width: rect.width, height: rect.height },
						byId
					);
				});
			const change_request = buildChangeRequest(
				{
					url: page.url.href,
					route_id: page.route.id,
					title: document.title,
					theme: app_state.resolved_theme,
					viewport: { width: window.innerWidth, height: window.innerHeight }
				},
				elements
			);
			const { request } = await api.fileIssue(target, {
				idempotency_key: crypto.randomUUID(),
				notes: text.trim(),
				change_request
			});
			if (request.status === 'failed') {
				toast.error('The filing agent did not start', {
					description: request.error_message ?? request.id
				});
				return;
			}
			const href = missionThreadHref(request.project_id, request.id);
			toast.success('Change request sent', {
				description: 'A filing agent will turn it into an issue. It will not change the code.',
				action: { label: 'Open mission', onClick: () => void goto(href) }
			});
			text = '';
			exitMode();
		} catch (error) {
			// The request text stays, so a retry is one click.
			toast.error('Could not send the change request', { description: errorMessage(error) });
		} finally {
			sending = false;
		}
	}
</script>

{#if on}
	{#if hover_box}
		<div
			class="ct-box ct-hover"
			data-change-this
			aria-hidden="true"
			style:transform="translate({hover_box.x}px, {hover_box.y}px)"
			style:width="{hover_box.width}px"
			style:height="{hover_box.height}px"
		></div>
	{/if}
	{#each selection_boxes as box, index (index)}
		{#if box}
			<div
				class="ct-box ct-selected"
				data-change-this
				aria-hidden="true"
				style:transform="translate({box.x}px, {box.y}px)"
				style:width="{box.width}px"
				style:height="{box.height}px"
			></div>
		{/if}
	{/each}

	<div
		class="ct-bar"
		role="status"
		aria-live="polite"
		tabindex="-1"
		bind:this={indicator}
		data-change-this
	>
		<CrosshairIcon size={15} aria-hidden="true" />
		<span class="ct-bar-tx">
			<b>Change this</b>
			{#if selection.length === 0}
				<span class="ct-bar-hint">Click or tap what you want changed. Tab and Enter work too.</span>
			{:else}
				<span class="ct-bar-hint"
					>{selection.length === 1 ? label(selection[0]!) : `${selection.length} elements`} · arrows move
					· shift-click adds</span
				>
			{/if}
		</span>
		<button class="btn btn-sm btn-ghost" type="button" onclick={exitMode}>
			<XIcon size={13} aria-hidden="true" /> Exit <span class="kbd">esc</span>
		</button>
	</div>

	{#if prompting && primary}
		<div
			class="ct-pop"
			role="dialog"
			aria-label="Request a change"
			data-change-this
			style:top="{placement.top}px"
			style:left="{placement.left}px"
			bind:offsetWidth={popover_size.width}
			bind:offsetHeight={popover_size.height}
		>
			<form class="ct-form" onsubmit={send}>
				<div class="ct-pop-hd">
					<span class="lbl">Request a change</span>
					<span class="spacer"></span>
					<span class="xs faint ct-target" title={label(primary)}
						>{selection.length === 1 ? label(primary) : `${selection.length} elements`}</span
					>
				</div>
				<label class="field">
					<span class="lbl">What should change?</span>
					<textarea
						class="textarea"
						rows={4}
						maxlength={NOTES_MAX}
						bind:value={text}
						bind:this={textarea}
						disabled={sending}
						placeholder="Say what you want different and why."></textarea>
				</label>
				<div class="field">
					<span class="lbl" id="ct-project-label">Beads project for Beadsmith’s code</span>
					{#if file_projects.length === 0}
						<p class="hint hint-em">No project allows File. Allow one in the console first.</p>
					{:else}
						<SelectField
							bind:value={project_id}
							items={project_items}
							placeholder="Choose the project…"
							aria-label="Beads project for Beadsmith’s code"
							disabled={sending}
						/>
						{#if stored_project === null && project_loaded}
							<p class="hint">Pick the project that tracks Beadsmith itself. It is remembered.</p>
						{/if}
					{/if}
				</div>
				<p class="hint">
					Sends a File mission with this page’s address and the selected element’s details. The
					agent files an issue; it does not change the code.
				</p>
				<div class="ct-pop-ft">
					<span class="xs faint"><span class="kbd">⌘↵</span> send</span>
					<span class="spacer"></span>
					<button class="btn btn-sm" type="button" disabled={sending} onclick={closePrompt}
						>Cancel</button
					>
					<button class="btn btn-sm btn-primary" type="submit" disabled={!can_send}>
						{sending ? 'Sending…' : 'Send'}
					</button>
				</div>
			</form>
		</div>
	{/if}
{/if}

<style>
	:global(html[data-change-this-on] body *) {
		cursor: crosshair;
	}
	:global(html[data-change-this-on] [data-change-this] *),
	:global(html[data-change-this-on] [role='listbox'] *) {
		cursor: auto;
	}
	:global(html[data-change-this-on] [data-change-this] button) {
		cursor: pointer;
	}
	.ct-box {
		position: fixed;
		top: 0;
		left: 0;
		z-index: 80;
		pointer-events: none;
		border-radius: var(--r-1);
	}
	.ct-hover {
		outline: 1px dashed var(--cyan);
		outline-offset: 1px;
		background: color-mix(in srgb, var(--cyan) 6%, transparent);
	}
	.ct-selected {
		outline: 2px solid var(--cyan);
		outline-offset: 1px;
		background: color-mix(in srgb, var(--cyan) 10%, transparent);
	}
	.ct-bar {
		position: fixed;
		left: 50%;
		bottom: var(--s-5);
		transform: translateX(-50%);
		z-index: 85;
		display: flex;
		align-items: center;
		gap: var(--s-3);
		max-width: calc(100vw - 32px);
		padding: 6px 6px 6px 12px;
		background: var(--s3);
		border: 1px solid var(--cyan-line);
		border-radius: var(--r-2);
		box-shadow: var(--shadow-tip);
		font-size: var(--t-xs);
		color: var(--tx-mid);
	}
	.ct-bar:focus-visible {
		outline: 2px solid var(--cyan);
		outline-offset: 2px;
	}
	.ct-bar :global(svg) {
		color: var(--cyan-tx);
		flex: none;
	}
	.ct-bar-tx {
		display: flex;
		flex-wrap: wrap;
		gap: 2px var(--s-2);
		min-width: 0;
	}
	.ct-bar-tx b {
		color: var(--tx-hi);
		font-weight: 600;
	}
	.ct-bar-hint {
		overflow-wrap: anywhere;
	}
	.ct-form {
		display: flex;
		flex-direction: column;
		gap: var(--s-3);
	}
	.ct-pop {
		position: fixed;
		z-index: 86;
		width: min(360px, calc(100vw - 32px));
		padding: var(--s-3) var(--s-4);
		background: var(--s2);
		border: 1px solid var(--line-2);
		border-radius: var(--r-2);
		box-shadow: var(--shadow-menu);
	}
	.ct-pop-hd,
	.ct-pop-ft {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		min-width: 0;
	}
	.ct-target {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 60%;
	}
	.ct-pop p {
		margin: 0;
	}
	@media (prefers-reduced-motion: no-preference) {
		.ct-box {
			transition:
				transform 60ms ease-out,
				width 60ms ease-out,
				height 60ms ease-out;
		}
	}
</style>
