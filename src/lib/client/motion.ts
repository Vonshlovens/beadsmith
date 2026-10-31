/**
 * Svelte transitions that mirror agenda.dev's framer-motion feel for the
 * todo agenda: cards fly in from below and out upward, move
 * between columns by crossfade, and panels open with height + opacity.
 * Every duration collapses to 0 under `prefers-reduced-motion`.
 */
import { cubicOut } from 'svelte/easing';
import { crossfade, fly, slide, type TransitionConfig } from 'svelte/transition';

/**
 * CSS-style cubic-bezier easing as a function of progress, solved by bisection
 * on x. Output may leave 0..1, which is how the spring overshoots.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
	const axis = (a: number, b: number, u: number) =>
		3 * a * (1 - u) * (1 - u) * u + 3 * b * (1 - u) * u * u + u * u * u;
	return (t) => {
		if (t <= 0) return 0;
		if (t >= 1) return 1;
		let lo = 0;
		let hi = 1;
		let u = t;
		for (let i = 0; i < 24; i++) {
			u = (lo + hi) / 2;
			if (axis(x1, x2, u) < t) lo = u;
			else hi = u;
		}
		return axis(y1, y2, u);
	};
}

/** agenda.dev's layout ease `[0.34, 1.56, 0.64, 1]`: runs past the target, then settles. */
export const springOut = cubicBezier(0.34, 1.56, 0.64, 1);

/** True when the viewer asked the OS for less motion. Re-read on each use. */
export function prefersReducedMotion(): boolean {
	return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** `ms` unless the viewer prefers reduced motion. */
export function dur(ms: number): number {
	return prefersReducedMotion() ? 0 : ms;
}

/** agenda.dev enter: opacity 0, y 20 → rest, ~0.25s. */
export function cardEnter(node: Element): TransitionConfig {
	return fly(node, { y: 20, duration: dur(250), easing: cubicOut });
}

/** agenda.dev exit: fade while lifting 20px, ~0.25s. */
export function cardExit(node: Element): TransitionConfig {
	return fly(node, { y: -20, duration: dur(250), easing: cubicOut });
}

/**
 * A card that leaves one column and arrives in another is the same card:
 * `send`/`receive` slide it across (layoutId in framer-motion). With no
 * counterpart (completed, archived, newly captured) they fall back to
 * {@link cardExit} / {@link cardEnter}.
 */
export const [send, receive] = crossfade({
	duration: (distance) => dur(Math.min(520, 240 + Math.sqrt(distance) * 12)),
	easing: springOut,
	fallback: (node, _params, intro) => (intro ? cardEnter(node) : cardExit(node))
});

/** Height collapse with opacity: comment threads and the parse preview. */
export function expand(
	node: Element,
	{ duration = 220 }: { duration?: number } = {}
): TransitionConfig {
	const base = slide(node, { duration: dur(duration), easing: cubicOut });
	return {
		...base,
		css: (t, u) => `${base.css?.(t, u) ?? ''}opacity: ${t};`
	};
}
