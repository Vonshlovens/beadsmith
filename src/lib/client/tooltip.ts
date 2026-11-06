/**
 * `{@attach tip('Refresh (r)')}`: the app's tooltip, in place of the browser's
 * `title` box (docs/design-standards.md §8). One shared bubble serves every
 * trigger: it opens on hover after a short delay, at once on keyboard focus,
 * stays open while the pointer crosses onto it, and closes on Escape, on
 * click and when the pointer or focus leaves. Text only: anything a user must
 * act on belongs in a popover or dialog, not here.
 *
 * While the bubble is open its trigger points at it with `aria-describedby`,
 * unless the text only repeats the trigger's own accessible name.
 */
import type { Attachment } from 'svelte/attachments';

export type TipSide = 'top' | 'bottom' | 'right' | 'left';

export interface TipOptions {
	/** Preferred side; flips when there is no room. Default `top`. */
	side?: TipSide;
	/** Show only while this is true (the collapsed rail, a clipped value). */
	when?: () => boolean;
}

const OPEN_DELAY_MS = 450;
/** Moving between triggers soon after one closed skips the delay. */
const WARM_MS = 300;
const CLOSE_GRACE_MS = 90;
const GAP = 6;
const EDGE = 8;
const BUBBLE_ID = 'bdui-tip';

let bubble: HTMLDivElement | null = null;
let owner: HTMLElement | null = null;
let open_timer: ReturnType<typeof setTimeout> | undefined;
let close_timer: ReturnType<typeof setTimeout> | undefined;
let last_closed_at = 0;

function ensureBubble(): HTMLDivElement {
	if (bubble && bubble.isConnected) {
		return bubble;
	}
	bubble = document.createElement('div');
	bubble.id = BUBBLE_ID;
	bubble.className = 'tip-pop';
	bubble.setAttribute('role', 'tooltip');
	bubble.addEventListener('pointerenter', () => clearTimeout(close_timer));
	bubble.addEventListener('pointerleave', () => scheduleClose());
	document.body.append(bubble);
	document.addEventListener(
		'keydown',
		(event) => {
			if (event.key === 'Escape' && owner) {
				close();
			}
		},
		true
	);
	window.addEventListener('scroll', () => close(), { capture: true, passive: true });
	document.addEventListener('pointerdown', () => close(), { capture: true, passive: true });
	return bubble;
}

function place(target: HTMLElement, el: HTMLDivElement, side: TipSide) {
	const rect = target.getBoundingClientRect();
	const width = el.offsetWidth;
	const height = el.offsetHeight;
	const vw = window.innerWidth;
	const vh = window.innerHeight;
	let chosen = side;
	if (chosen === 'top' && rect.top - height - GAP < EDGE) chosen = 'bottom';
	else if (chosen === 'bottom' && rect.bottom + height + GAP > vh - EDGE) chosen = 'top';
	else if (chosen === 'right' && rect.right + width + GAP > vw - EDGE) chosen = 'left';
	else if (chosen === 'left' && rect.left - width - GAP < EDGE) chosen = 'right';

	let left: number;
	let top: number;
	if (chosen === 'top' || chosen === 'bottom') {
		left = rect.left + rect.width / 2 - width / 2;
		top = chosen === 'top' ? rect.top - height - GAP : rect.bottom + GAP;
	} else {
		top = rect.top + rect.height / 2 - height / 2;
		left = chosen === 'right' ? rect.right + GAP : rect.left - width - GAP;
	}
	left = Math.min(Math.max(EDGE, left), vw - width - EDGE);
	top = Math.min(Math.max(EDGE, top), vh - height - EDGE);
	el.style.left = `${Math.round(left)}px`;
	el.style.top = `${Math.round(top)}px`;
	el.dataset.side = chosen;
}

function accessibleName(target: HTMLElement): string {
	return (target.getAttribute('aria-label') ?? target.textContent ?? '').trim().toLowerCase();
}

function open(target: HTMLElement, text: string, side: TipSide) {
	clearTimeout(open_timer);
	clearTimeout(close_timer);
	const el = ensureBubble();
	if (owner && owner !== target) {
		owner.removeAttribute('aria-describedby');
	}
	owner = target;
	el.textContent = text;
	el.dataset.open = 'true';
	place(target, el, side);
	if (
		accessibleName(target) !== text.trim().toLowerCase() &&
		!target.hasAttribute('aria-describedby')
	) {
		target.setAttribute('aria-describedby', BUBBLE_ID);
		target.dataset.tipDescribed = 'true';
	}
}

function close() {
	clearTimeout(open_timer);
	clearTimeout(close_timer);
	if (owner?.dataset.tipDescribed) {
		owner.removeAttribute('aria-describedby');
		delete owner.dataset.tipDescribed;
	}
	if (owner) {
		last_closed_at = Date.now();
	}
	owner = null;
	if (bubble) {
		delete bubble.dataset.open;
	}
}

function scheduleClose() {
	clearTimeout(open_timer);
	clearTimeout(close_timer);
	close_timer = setTimeout(close, CLOSE_GRACE_MS);
}

/**
 * Attach the app tooltip to an element.
 *
 * @param text - What the tooltip says; empty or nullish attaches nothing.
 * @param options - Side and an optional condition.
 */
export function tip(
	text: string | null | undefined,
	options: TipOptions = {}
): Attachment<HTMLElement> {
	return (target) => {
		const label = (text ?? '').trim();
		if (label.length === 0) {
			return;
		}
		const side = options.side ?? 'top';
		const allowed = () => options.when?.() ?? true;

		const onEnter = (event: PointerEvent) => {
			if (event.pointerType === 'touch' || !allowed()) return;
			clearTimeout(close_timer);
			if (owner === target) return;
			clearTimeout(open_timer);
			const warm = owner !== null || Date.now() - last_closed_at < WARM_MS;
			open_timer = setTimeout(() => open(target, label, side), warm ? 0 : OPEN_DELAY_MS);
		};
		const onLeave = () => {
			clearTimeout(open_timer);
			if (owner === target) scheduleClose();
		};
		const onFocus = () => {
			if (!allowed() || !target.matches(':focus-visible')) return;
			open(target, label, side);
		};
		const onBlur = () => {
			if (owner === target) close();
		};
		const onPress = () => {
			clearTimeout(open_timer);
			if (owner === target) close();
		};

		target.addEventListener('pointerenter', onEnter);
		target.addEventListener('pointerleave', onLeave);
		target.addEventListener('focusin', onFocus);
		target.addEventListener('focusout', onBlur);
		target.addEventListener('pointerdown', onPress);
		return () => {
			target.removeEventListener('pointerenter', onEnter);
			target.removeEventListener('pointerleave', onLeave);
			target.removeEventListener('focusin', onFocus);
			target.removeEventListener('focusout', onBlur);
			target.removeEventListener('pointerdown', onPress);
			if (owner === target) close();
		};
	};
}
