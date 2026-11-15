/**
 * "Change this" mode (ADR-0025 rule 10): the pure half. The component
 * (`change-this.svelte`) owns the listeners and the overlay; everything that
 * turns a selected element into the request's page context lives here, over
 * a small element interface, so it is testable without a DOM.
 *
 * What it captures is what a person sees on the page, and that includes text
 * other people wrote. The server fences it as data (`prompts.ts`); here it is
 * only made small: every string is cut to `CHANGE_REQUEST_LIMITS`.
 */
import {
	CHANGE_REQUEST_LIMITS,
	type ChangeRequest,
	type ChangeRequestBox,
	type ChangeRequestElement,
	type ChangeRequestPage
} from '#lib/change-request.js';

/** The part of a DOM `Element` the helpers read. */
export interface InspectElement {
	tagName: string;
	id: string;
	parentElement: InspectElement | null;
	firstElementChild: InspectElement | null;
	previousElementSibling: InspectElement | null;
	nextElementSibling: InspectElement | null;
	textContent: string | null;
	outerHTML: string;
	getAttribute(name: string): string | null;
	hasAttribute(name: string): boolean;
}

/** Marks the mode's own overlay, indicator and popover, which can never be selected. */
export const CHANGE_THIS_ATTR = 'data-change-this';

/** Cut `text` to `max` characters, marking the cut with an ellipsis. */
export function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Collapse runs of whitespace and trim. */
export function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

/**
 * `CSS.escape` for an identifier, with a fallback for tests and old engines:
 * anything outside `[A-Za-z0-9_-]`, and a leading digit, is escaped.
 */
export function cssIdent(value: string): string {
	const native = (globalThis as { CSS?: { escape?: (value: string) => string } }).CSS?.escape;
	if (native !== undefined) {
		return native(value);
	}
	return value
		.replace(/[^A-Za-z0-9_-]/g, (char) => `\\${char}`)
		.replace(/^(\d)/, (digit) => `\\3${digit} `);
}

/**
 * An id worth anchoring a selector on: one a person wrote, not one a
 * component library generated per render (`bits-…`, React-style `:r1:`, or
 * long digit runs), which would not match the next time the page renders.
 */
export function stableId(id: string): boolean {
	return (
		id.length > 0 &&
		id.length <= 64 &&
		/^[A-Za-z][\w-]*$/.test(id) &&
		!id.startsWith('bits-') &&
		!/\d{3,}/.test(id)
	);
}

function tagOf(element: InspectElement): string {
	return element.tagName.toLowerCase();
}

/** Position among same-tag siblings, from 1, and whether it has any. */
function typeIndex(element: InspectElement): { index: number; alone: boolean } {
	const tag = element.tagName;
	let index = 1;
	for (let at = element.previousElementSibling; at !== null; at = at.previousElementSibling) {
		if (at.tagName === tag) index += 1;
	}
	let alone = index === 1;
	for (let at = element.nextElementSibling; alone && at !== null; at = at.nextElementSibling) {
		if (at.tagName === tag) alone = false;
	}
	return { index, alone };
}

/**
 * A CSS selector path to `element`: from the nearest ancestor with a stable
 * id (or from `body`), each step `tag` plus `:nth-of-type(n)` when siblings
 * share the tag. Classes are left out: Tailwind utilities change with every
 * restyle, and the path is for finding the code, not for styling.
 */
export function selectorPath(element: InspectElement): string {
	const steps: string[] = [];
	for (let at: InspectElement | null = element; at !== null; at = at.parentElement) {
		const tag = tagOf(at);
		if (tag === 'html' || tag === 'body') {
			break;
		}
		if (stableId(at.id)) {
			steps.unshift(`#${cssIdent(at.id)}`);
			break;
		}
		const { index, alone } = typeIndex(at);
		steps.unshift(alone ? tag : `${tag}:nth-of-type(${index})`);
	}
	return truncate(steps.join(' > ') || tagOf(element), CHANGE_REQUEST_LIMITS.selector);
}

const IMPLICIT_ROLES: Record<string, string> = {
	button: 'button',
	nav: 'navigation',
	main: 'main',
	aside: 'complementary',
	header: 'banner',
	footer: 'contentinfo',
	form: 'form',
	ul: 'list',
	ol: 'list',
	li: 'listitem',
	table: 'table',
	tr: 'row',
	td: 'cell',
	th: 'columnheader',
	img: 'img',
	textarea: 'textbox',
	select: 'combobox',
	dialog: 'dialog',
	h1: 'heading',
	h2: 'heading',
	h3: 'heading',
	h4: 'heading',
	h5: 'heading',
	h6: 'heading'
};

const INPUT_ROLES: Record<string, string> = {
	checkbox: 'checkbox',
	radio: 'radio',
	range: 'slider',
	search: 'searchbox',
	button: 'button',
	submit: 'button',
	reset: 'button'
};

/** The element's explicit ARIA role, else the common implicit one, else undefined. */
export function elementRole(element: InspectElement): string | undefined {
	const explicit = element.getAttribute('role')?.trim().split(/\s+/)[0];
	if (explicit !== undefined && explicit.length > 0) {
		return truncate(explicit, CHANGE_REQUEST_LIMITS.role);
	}
	const tag = tagOf(element);
	if (tag === 'a') {
		return element.hasAttribute('href') ? 'link' : undefined;
	}
	if (tag === 'input') {
		return INPUT_ROLES[(element.getAttribute('type') ?? 'text').toLowerCase()] ?? 'textbox';
	}
	return IMPLICIT_ROLES[tag];
}

/** Roles whose name comes from their own text when nothing labels them. */
const NAME_FROM_CONTENT = new Set([
	'button',
	'link',
	'heading',
	'tab',
	'menuitem',
	'option',
	'cell',
	'columnheader',
	'checkbox',
	'radio'
]);

/**
 * A close approximation of the accessible name: `aria-label`, then the text
 * of `aria-labelledby` (resolved through `byId`), `alt`, `title`,
 * `placeholder`, and for buttons, links, headings and the like their text.
 * @param element The element.
 * @param byId Looks up an element by id, for `aria-labelledby`.
 */
export function accessibleName(
	element: InspectElement,
	byId: (id: string) => InspectElement | null = () => null
): string | undefined {
	const label = element.getAttribute('aria-label');
	const labelled = element
		.getAttribute('aria-labelledby')
		?.split(/\s+/)
		.map((id) => byId(id)?.textContent ?? '')
		.join(' ');
	const role = elementRole(element);
	const candidates = [
		label,
		labelled,
		element.getAttribute('alt'),
		element.getAttribute('title'),
		element.getAttribute('placeholder'),
		role !== undefined && NAME_FROM_CONTENT.has(role) ? element.textContent : null
	];
	for (const candidate of candidates) {
		const name = collapseWhitespace(candidate ?? '');
		if (name.length > 0) {
			return truncate(name, CHANGE_REQUEST_LIMITS.name);
		}
	}
	return undefined;
}

/**
 * A short outerHTML: long SVG path data and inline styles are elided (they
 * say nothing about where the code is and would crowd out the markup), then
 * the whole is cut to the limit.
 */
export function htmlSnippet(outer_html: string): string {
	const lean = outer_html
		.replace(/\s(d|points|style)="[^"]{40,}"/g, ' $1="…"')
		.replace(/\s+/g, ' ')
		.trim();
	return truncate(lean, CHANGE_REQUEST_LIMITS.html);
}

/** Svelte 5 dev builds tag each element with where it was written. */
interface SvelteMeta {
	loc?: { file?: unknown; line?: unknown };
}

/**
 * The Svelte component file (and line) that wrote this element, or the
 * nearest ancestor that has one. Only dev builds set `__svelte_meta`; a
 * production build returns undefined and nothing depends on it. Absolute
 * paths are cut to the part from `src/`, so a build machine's home directory
 * never leaves the browser.
 */
export function svelteComponent(
	element: InspectElement
): { file: string; line?: number } | undefined {
	for (let at: InspectElement | null = element; at !== null; at = at.parentElement) {
		const meta = (at as unknown as { __svelte_meta?: SvelteMeta }).__svelte_meta;
		const file = meta?.loc?.file;
		if (typeof file === 'string' && file.length > 0) {
			const from_src = file.indexOf('src/');
			const relative = from_src >= 0 ? file.slice(from_src) : (file.split('/').pop() ?? file);
			const line = meta?.loc?.line;
			return {
				file: truncate(relative, CHANGE_REQUEST_LIMITS.component_file),
				...(typeof line === 'number' && Number.isInteger(line) && line >= 0 ? { line } : {})
			};
		}
	}
	return undefined;
}

/** Round a rectangle to whole CSS pixels. */
export function roundBox(rect: ChangeRequestBox): ChangeRequestBox {
	return {
		x: Math.round(rect.x),
		y: Math.round(rect.y),
		width: Math.max(0, Math.round(rect.width)),
		height: Math.max(0, Math.round(rect.height))
	};
}

/**
 * Everything the request says about one selected element.
 * @param element The element.
 * @param rect Its bounding box (`getBoundingClientRect()`).
 * @param byId Id lookup for `aria-labelledby`.
 */
export function describeElement(
	element: InspectElement,
	rect: ChangeRequestBox,
	byId?: (id: string) => InspectElement | null
): ChangeRequestElement {
	const L = CHANGE_REQUEST_LIMITS;
	const role = elementRole(element);
	const name = accessibleName(element, byId);
	const text = truncate(collapseWhitespace(element.textContent ?? ''), L.text);
	const component = svelteComponent(element);
	return {
		selector: selectorPath(element),
		tag: truncate(tagOf(element), L.tag),
		...(role === undefined ? {} : { role }),
		...(name === undefined ? {} : { name }),
		...(text.length === 0 ? {} : { text }),
		html: htmlSnippet(element.outerHTML),
		box: roundBox(rect),
		...(component === undefined ? {} : { component })
	};
}

/**
 * The request a Send carries: the page, cut to the limits, and at most
 * `CHANGE_REQUEST_LIMITS.elements` elements.
 */
export function buildChangeRequest(
	page: ChangeRequestPage,
	elements: readonly ChangeRequestElement[]
): ChangeRequest {
	const L = CHANGE_REQUEST_LIMITS;
	return {
		source: 'page',
		page: {
			url: truncate(page.url, L.url),
			route_id: page.route_id === null ? null : truncate(page.route_id, L.route_id),
			title: truncate(page.title, L.title),
			theme: page.theme,
			viewport: {
				width: Math.max(0, Math.round(page.viewport.width)),
				height: Math.max(0, Math.round(page.viewport.height))
			}
		},
		elements: elements.slice(0, L.elements)
	};
}

/** True for the mode's own overlay and popover, or anything inside them. */
export function isOwnNode(element: InspectElement | null): boolean {
	for (let at = element; at !== null; at = at.parentElement) {
		if (at.hasAttribute(CHANGE_THIS_ATTR)) return true;
	}
	return false;
}

/** Arrow keys walk the tree: up to the parent, down to the first child, left and right to siblings. */
export type SelectionMove = 'parent' | 'child' | 'previous' | 'next';

export const SELECTION_KEYS: Record<string, SelectionMove> = {
	ArrowUp: 'parent',
	ArrowDown: 'child',
	ArrowLeft: 'previous',
	ArrowRight: 'next'
};

/**
 * Where a move lands, skipping the mode's own nodes; null when there is
 * nowhere to go (the parent of `main`'s top is `body`, which is not offered).
 */
export function moveSelection(element: InspectElement, move: SelectionMove): InspectElement | null {
	const ok = (candidate: InspectElement): boolean =>
		!['html', 'body'].includes(tagOf(candidate)) && !isOwnNode(candidate);
	if (move === 'parent') {
		const parent = element.parentElement;
		return parent !== null && ok(parent) ? parent : null;
	}
	if (move === 'child') {
		for (
			let at: InspectElement | null = element.firstElementChild;
			at !== null;
			at = at.nextElementSibling
		) {
			if (ok(at)) return at;
		}
		return null;
	}
	const step = (at: InspectElement): InspectElement | null =>
		move === 'previous' ? at.previousElementSibling : at.nextElementSibling;
	for (let at: InspectElement | null = step(element); at !== null; at = step(at)) {
		if (ok(at)) return at;
	}
	return null;
}

/**
 * Where the prompt popover goes: below the selection when it fits, else
 * above, else pinned to the bottom of the viewport; always inside a 16px
 * gutter so it never forces a horizontal scroll.
 * @param box The selection's bounding box.
 * @param viewport The viewport size.
 * @param size The popover's size.
 */
export function popoverPlacement(
	box: ChangeRequestBox,
	viewport: { width: number; height: number },
	size: { width: number; height: number }
): { top: number; left: number } {
	const gutter = 16;
	const gap = 8;
	const width = Math.min(size.width, Math.max(0, viewport.width - gutter * 2));
	const left = Math.min(Math.max(gutter, box.x), Math.max(gutter, viewport.width - gutter - width));
	const below = box.y + box.height + gap;
	const above = box.y - gap - size.height;
	let top: number;
	if (below + size.height <= viewport.height - gutter) {
		top = below;
	} else if (above >= gutter) {
		top = above;
	} else {
		top = Math.max(gutter, viewport.height - gutter - size.height);
	}
	return { top: Math.round(top), left: Math.round(left) };
}
