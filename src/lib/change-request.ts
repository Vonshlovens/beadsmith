/**
 * A "Change this" request (ADR-0025 rule 10): an admin points at part of a
 * Beadsmith page and says what should change, or First Mate asks for a code
 * change the grown layer cannot make. It rides on a File launch as
 * `change_request`, so it goes through dispatch's own authority (arm,
 * per-project allow, File checkout map, provider) and nothing new.
 *
 * Every string here came from the rendered page, which shows text other
 * people wrote (issue titles, comments), so the prompt fences it as data.
 * The limits are shared: the browser truncates to them, the server refuses
 * anything longer, and the prompt builder clips again.
 */

export const CHANGE_REQUEST_LIMITS = {
	/** Elements one request may point at. */
	elements: 5,
	url: 2000,
	route_id: 300,
	title: 300,
	selector: 1000,
	tag: 40,
	role: 60,
	name: 300,
	text: 500,
	html: 2000,
	component_file: 300
} as const;

export const CHANGE_REQUEST_SOURCES = ['page', 'first_mate'] as const;
export type ChangeRequestSource = (typeof CHANGE_REQUEST_SOURCES)[number];

/** Where an element sits, in CSS pixels relative to the viewport. */
export interface ChangeRequestBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** One element the request points at. */
export interface ChangeRequestElement {
	/** A CSS selector path from the nearest id (or the document) to the element. */
	selector: string;
	tag: string;
	/** Explicit or implicit ARIA role, when it has one. */
	role?: string;
	/** Accessible name: aria-label, alt, title or similar. */
	name?: string;
	/** Visible text, whitespace collapsed and truncated. */
	text?: string;
	/** Truncated outerHTML. */
	html?: string;
	box: ChangeRequestBox;
	/** Svelte dev builds only (`__svelte_meta`): the component file and line. */
	component?: { file: string; line?: number };
}

/** The page the request came from. */
export interface ChangeRequestPage {
	url: string;
	/** SvelteKit route id, e.g. `/p/[id]`; null on an unmatched route. */
	route_id: string | null;
	title: string;
	theme: 'light' | 'dark';
	viewport: { width: number; height: number };
}

export interface ChangeRequest {
	source: ChangeRequestSource;
	page?: ChangeRequestPage;
	elements?: ChangeRequestElement[];
}

/** Settings key holding the Beads project that tracks Beadsmith's own code. */
export const CHANGE_THIS_PROJECT_SETTING = 'change_this.project_id';
