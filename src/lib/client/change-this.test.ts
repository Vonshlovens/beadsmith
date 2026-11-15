import { describe, expect, it } from 'vitest';
import { CHANGE_REQUEST_LIMITS } from '#lib/change-request.js';
import {
	accessibleName,
	buildChangeRequest,
	CHANGE_THIS_ATTR,
	cssIdent,
	describeElement,
	elementRole,
	htmlSnippet,
	isOwnNode,
	moveSelection,
	popoverPlacement,
	selectorPath,
	stableId,
	svelteComponent,
	truncate,
	type InspectElement
} from './change-this.js';

/** A tiny element tree: enough of `Element` for the helpers. */
interface Spec {
	tag: string;
	id?: string;
	attrs?: Record<string, string>;
	text?: string;
	children?: Spec[];
	meta?: unknown;
}

class FakeElement implements InspectElement {
	tagName: string;
	id: string;
	parentElement: FakeElement | null = null;
	kids: FakeElement[] = [];
	attrs: Record<string, string>;
	own_text: string;
	__svelte_meta?: unknown;

	constructor(spec: Spec) {
		this.tagName = spec.tag.toUpperCase();
		this.id = spec.id ?? '';
		this.attrs = { ...spec.attrs, ...(spec.id === undefined ? {} : { id: spec.id }) };
		this.own_text = spec.text ?? '';
		if (spec.meta !== undefined) this.__svelte_meta = spec.meta;
		for (const child of spec.children ?? []) {
			const node = new FakeElement(child);
			node.parentElement = this;
			this.kids.push(node);
		}
	}

	private siblings(): FakeElement[] {
		return this.parentElement?.kids ?? [this];
	}
	get firstElementChild() {
		return this.kids[0] ?? null;
	}
	get previousElementSibling() {
		const list = this.siblings();
		return list[list.indexOf(this) - 1] ?? null;
	}
	get nextElementSibling() {
		const list = this.siblings();
		return list[list.indexOf(this) + 1] ?? null;
	}
	get textContent(): string {
		return this.own_text + this.kids.map((kid) => kid.textContent).join('');
	}
	get outerHTML(): string {
		const tag = this.tagName.toLowerCase();
		const attrs = Object.entries(this.attrs)
			.map(([key, value]) => ` ${key}="${value}"`)
			.join('');
		return `<${tag}${attrs}>${this.own_text}${this.kids.map((kid) => kid.outerHTML).join('')}</${tag}>`;
	}
	getAttribute(name: string) {
		return this.attrs[name] ?? null;
	}
	hasAttribute(name: string) {
		return name in this.attrs;
	}
	find(predicate: (node: FakeElement) => boolean): FakeElement | null {
		if (predicate(this)) return this;
		for (const kid of this.kids) {
			const found = kid.find(predicate);
			if (found !== null) return found;
		}
		return null;
	}
}

function tree(): FakeElement {
	return new FakeElement({
		tag: 'body',
		children: [
			{
				tag: 'main',
				id: 'main',
				children: [
					{ tag: 'h1', text: 'Ready' },
					{
						tag: 'ul',
						children: [
							{ tag: 'li', text: 'One' },
							{
								tag: 'li',
								children: [
									{
										tag: 'button',
										attrs: { class: 'btn btn-sm', 'aria-label': 'Tackle beads-1' },
										text: 'Go',
										meta: {
											loc: { file: '/build/beadsmith/src/lib/components/row.svelte', line: 12 }
										}
									}
								]
							}
						]
					}
				]
			},
			{
				tag: 'div',
				attrs: { [CHANGE_THIS_ATTR]: '' },
				children: [{ tag: 'span', text: 'overlay' }]
			}
		]
	});
}

describe('selectorPath', () => {
	it('anchors on the nearest stable id and numbers same-tag siblings', () => {
		const root = tree();
		const button = root.find((node) => node.tagName === 'BUTTON')!;
		expect(selectorPath(button)).toBe('#main > ul > li:nth-of-type(2) > button');
		expect(selectorPath(root.find((node) => node.tagName === 'H1')!)).toBe('#main > h1');
	});

	it('skips generated ids and stops at body', () => {
		const root = new FakeElement({
			tag: 'body',
			children: [
				{ tag: 'div', id: 'bits-c12', children: [{ tag: 'p', id: 'row-12345', text: 'x' }] }
			]
		});
		expect(selectorPath(root.find((node) => node.tagName === 'P')!)).toBe('div > p');
	});

	it('knows which ids are stable', () => {
		expect(stableId('main')).toBe(true);
		expect(stableId('sidebar')).toBe(true);
		expect(stableId('bits-c3')).toBe(false);
		expect(stableId('item-12345')).toBe(false);
		expect(stableId(':r1:')).toBe(false);
		expect(stableId('')).toBe(false);
	});

	it('escapes identifiers without CSS.escape', () => {
		expect(cssIdent('a.b')).toBe('a\\.b');
		expect(cssIdent('plain-id')).toBe('plain-id');
	});
});

describe('roles and names', () => {
	it('reads explicit and implicit roles', () => {
		const make = (spec: Spec) => new FakeElement(spec);
		expect(elementRole(make({ tag: 'div', attrs: { role: 'tab extra' } }))).toBe('tab');
		expect(elementRole(make({ tag: 'a', attrs: { href: '/x' } }))).toBe('link');
		expect(elementRole(make({ tag: 'a' }))).toBeUndefined();
		expect(elementRole(make({ tag: 'input', attrs: { type: 'checkbox' } }))).toBe('checkbox');
		expect(elementRole(make({ tag: 'input' }))).toBe('textbox');
		expect(elementRole(make({ tag: 'h2' }))).toBe('heading');
		expect(elementRole(make({ tag: 'div' }))).toBeUndefined();
	});

	it('prefers aria-label, then labelledby, then alt/title/placeholder, then content for buttons', () => {
		const root = new FakeElement({
			tag: 'body',
			children: [
				{ tag: 'span', id: 'lbl', text: 'Filter  issues' },
				{ tag: 'input', attrs: { 'aria-labelledby': 'lbl', placeholder: 'ignored' } },
				{ tag: 'button', attrs: { 'aria-label': 'Close' }, text: 'X' },
				{ tag: 'button', text: '  Save\n view ' },
				{ tag: 'div', text: 'plain text' },
				{ tag: 'img', attrs: { alt: 'Beadsmith' } }
			]
		});
		const byId = (id: string) => root.find((node) => node.id === id);
		const [, input, close, save, div, img] = root.kids;
		expect(accessibleName(input!, byId)).toBe('Filter issues');
		expect(accessibleName(close!)).toBe('Close');
		expect(accessibleName(save!)).toBe('Save view');
		expect(accessibleName(div!)).toBeUndefined();
		expect(accessibleName(img!)).toBe('Beadsmith');
	});
});

describe('context extraction', () => {
	it('describes an element: selector, role, name, text, html, box and component', () => {
		const button = tree().find((node) => node.tagName === 'BUTTON')!;
		const described = describeElement(button, { x: 10.4, y: 20.6, width: 80.2, height: 27.9 });
		expect(described).toEqual({
			selector: '#main > ul > li:nth-of-type(2) > button',
			tag: 'button',
			role: 'button',
			name: 'Tackle beads-1',
			text: 'Go',
			html: '<button class="btn btn-sm" aria-label="Tackle beads-1">Go</button>',
			box: { x: 10, y: 21, width: 80, height: 28 },
			// The absolute path is cut to the part from src/.
			component: { file: 'src/lib/components/row.svelte', line: 12 }
		});
	});

	it('finds the component on an ancestor and returns none in a production build', () => {
		const root = tree();
		const li = root.find((node) => node.tagName === 'LI')!;
		expect(svelteComponent(li)).toBeUndefined();
		const parent = new FakeElement({
			tag: 'section',
			meta: { loc: { file: 'src/routes/+page.svelte', line: 3 } },
			children: [{ tag: 'p' }]
		});
		expect(svelteComponent(parent.kids[0]!)).toEqual({ file: 'src/routes/+page.svelte', line: 3 });
	});

	it('truncates text and html to the shared limits', () => {
		const long = new FakeElement({ tag: 'p', text: 'word '.repeat(1000) });
		const described = describeElement(long, { x: 0, y: 0, width: 1, height: 1 });
		expect(described.text).toHaveLength(CHANGE_REQUEST_LIMITS.text);
		expect(described.text!.endsWith('…')).toBe(true);
		expect(described.html!.length).toBeLessThanOrEqual(CHANGE_REQUEST_LIMITS.html);
	});

	it('elides long SVG path data and inline styles from the snippet', () => {
		const svg = `<svg><path d="${'M0 0 L1 1 '.repeat(20)}"></path></svg><div style="${'color: red; '.repeat(10)}">x</div>`;
		expect(htmlSnippet(svg)).toBe('<svg><path d="…"></path></svg><div style="…">x</div>');
	});

	it('builds a page request capped in size and element count', () => {
		const element = describeElement(new FakeElement({ tag: 'p', text: 'x' }), {
			x: 0,
			y: 0,
			width: 1,
			height: 1
		});
		const request = buildChangeRequest(
			{
				url: `https://beadsmith.example.test/${'a'.repeat(5000)}`,
				route_id: '/p/[id]',
				title: 'Issues',
				theme: 'dark',
				viewport: { width: 1280.5, height: 720 }
			},
			Array.from({ length: 9 }, () => element)
		);
		expect(request.source).toBe('page');
		expect(request.page!.url).toHaveLength(CHANGE_REQUEST_LIMITS.url);
		expect(request.page!.viewport).toEqual({ width: 1281, height: 720 });
		expect(request.elements).toHaveLength(CHANGE_REQUEST_LIMITS.elements);
	});

	it('truncates with an ellipsis only when needed', () => {
		expect(truncate('short', 10)).toBe('short');
		expect(truncate('abcdef', 4)).toBe('abc…');
	});
});

describe('selection movement', () => {
	it('moves to parent, first child and siblings, never to body or the overlay', () => {
		const root = tree();
		const main = root.find((node) => node.id === 'main')!;
		const h1 = main.kids[0]!;
		const ul = main.kids[1]!;
		expect(moveSelection(h1, 'parent')).toBe(main);
		expect(moveSelection(main, 'parent')).toBeNull();
		expect(moveSelection(main, 'child')).toBe(h1);
		expect(moveSelection(h1, 'next')).toBe(ul);
		expect(moveSelection(ul, 'previous')).toBe(h1);
		expect(moveSelection(h1, 'previous')).toBeNull();
		// The overlay after main is the mode's own node.
		expect(moveSelection(main, 'next')).toBeNull();
	});

	it('recognises the mode’s own nodes and their children', () => {
		const root = tree();
		const span = root.find((node) => node.own_text === 'overlay')!;
		expect(isOwnNode(span)).toBe(true);
		expect(isOwnNode(root.find((node) => node.id === 'main'))).toBe(false);
		expect(isOwnNode(null)).toBe(false);
	});
});

describe('popoverPlacement', () => {
	const viewport = { width: 1000, height: 800 };
	const size = { width: 320, height: 200 };

	it('goes below the selection when it fits', () => {
		expect(popoverPlacement({ x: 100, y: 100, width: 50, height: 20 }, viewport, size)).toEqual({
			top: 128,
			left: 100
		});
	});

	it('goes above when below does not fit, and stays inside the gutter', () => {
		expect(popoverPlacement({ x: 900, y: 700, width: 50, height: 20 }, viewport, size)).toEqual({
			top: 492,
			left: 664
		});
	});

	it('pins to the bottom for a selection taller than the viewport', () => {
		expect(popoverPlacement({ x: 0, y: 0, width: 1000, height: 800 }, viewport, size)).toEqual({
			top: 584,
			left: 16
		});
	});

	it('fits a phone width without overflowing', () => {
		const placed = popoverPlacement(
			{ x: 300, y: 50, width: 40, height: 20 },
			{ width: 375, height: 700 },
			size
		);
		expect(placed.left).toBeGreaterThanOrEqual(16);
		expect(placed.left + Math.min(size.width, 375 - 32)).toBeLessThanOrEqual(375 - 16);
	});
});
