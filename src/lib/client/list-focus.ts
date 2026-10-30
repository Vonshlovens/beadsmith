/**
 * j/k for plain lists of links or buttons (projects, Ready, missions,
 * threads): move keyboard focus to the next or previous item and keep it in
 * view. Enter then follows the focused link natively.
 */

/**
 * Move focus one item.
 *
 * @param container - The list's element.
 * @param selector - Matches each focusable item.
 * @param step - Down (1) or up (-1).
 * @returns Whether focus moved (so the key is consumed).
 */
export function stepFocus(container: HTMLElement | null, selector: string, step: 1 | -1): boolean {
	if (container === null) {
		return false;
	}
	const items = [...container.querySelectorAll<HTMLElement>(selector)].filter(
		(item) => item.offsetParent !== null
	);
	if (items.length === 0) {
		return false;
	}
	const active = document.activeElement;
	const at = items.findIndex((item) => item === active || item.contains(active));
	const next_at = at < 0 ? (step === 1 ? 0 : items.length - 1) : at + step;
	const next = items[Math.min(Math.max(next_at, 0), items.length - 1)];
	if (next === undefined || next === items[at]) {
		return at >= 0;
	}
	next.focus();
	next.scrollIntoView({ block: 'nearest' });
	return true;
}
