/**
 * Grouping for the parade view (after mardi-gras): the project's issues as a
 * route — what is rolling, what is lined up, what has stalled, and what has
 * already passed the stand — with the selected issue read in a pane beside it.
 *
 * The page has already filtered the issue set; this module only buckets and
 * orders it, and works out keyboard order across the expanded sections.
 */
import { sortBoardCards } from './board.js';
import { statusKey } from './format.js';
import type { StatusKey } from './format.js';
import type { IssueSummary } from '$lib/types';

export const PARADE_SECTIONS = ['rolling', 'lined_up', 'stalled', 'deferred', 'past'] as const;

export type ParadeSectionId = (typeof PARADE_SECTIONS)[number];

export interface ParadeSection {
	id: ParadeSectionId;
	label: string;
	/** Status whose bead colours the section header. */
	bead: StatusKey;
	issues: IssueSummary[];
}

const SECTION_OF: Record<StatusKey, ParadeSectionId> = {
	in_progress: 'rolling',
	hooked: 'rolling',
	open: 'lined_up',
	pinned: 'lined_up',
	blocked: 'stalled',
	deferred: 'deferred',
	closed: 'past'
};

const META: Record<ParadeSectionId, { label: string; bead: StatusKey }> = {
	rolling: { label: 'Rolling', bead: 'in_progress' },
	lined_up: { label: 'Lined up', bead: 'open' },
	stalled: { label: 'Stalled', bead: 'blocked' },
	deferred: { label: 'Deferred', bead: 'deferred' },
	past: { label: 'Past the stand', bead: 'closed' }
};

/** Sections that start collapsed when the reader has no stored preference. */
export const DEFAULT_COLLAPSED: readonly ParadeSectionId[] = ['past'];

/** localStorage key for which parade sections are collapsed. */
export const PARADE_COLLAPSED_KEY = 'bdui:parade-collapsed';

/**
 * Which parade section an issue belongs to.
 *
 * @param status - Raw issue status.
 */
export function paradeSectionOf(status: string | undefined): ParadeSectionId {
	return SECTION_OF[statusKey(status)];
}

/**
 * Bucket issues into parade sections, in route order. Empty sections are
 * dropped: a heading over nothing is noise.
 *
 * @param issues - The already-filtered issue set.
 */
export function groupParade(issues: readonly IssueSummary[]): ParadeSection[] {
	const buckets = new Map<ParadeSectionId, IssueSummary[]>();
	for (const issue of issues) {
		const id = paradeSectionOf(issue.status);
		const bucket = buckets.get(id);
		if (bucket) {
			bucket.push(issue);
		} else {
			buckets.set(id, [issue]);
		}
	}
	return PARADE_SECTIONS.filter((id) => buckets.has(id)).map((id) => ({
		id,
		...META[id],
		issues: sortBoardCards(buckets.get(id) ?? [])
	}));
}

/**
 * Issues in keyboard order: every row of every expanded section.
 *
 * @param sections - Grouped sections.
 * @param collapsed - Sections the reader has folded away.
 */
export function paradeOrder(
	sections: readonly ParadeSection[],
	collapsed: ReadonlySet<ParadeSectionId>
): IssueSummary[] {
	return sections.filter((section) => !collapsed.has(section.id)).flatMap((s) => s.issues);
}

/**
 * The id one step from `current` in keyboard order. An unknown or missing
 * current starts from the top; the ends do not wrap.
 *
 * @param order - Issues in keyboard order.
 * @param current - Selected id, or null.
 * @param step - +1 for next, -1 for previous.
 */
export function stepSelection(
	order: readonly IssueSummary[],
	current: string | null,
	step: 1 | -1
): string | null {
	if (order.length === 0) {
		return null;
	}
	const index = current === null ? -1 : order.findIndex((issue) => issue.id === current);
	if (index === -1) {
		return order[0].id;
	}
	const next = Math.min(order.length - 1, Math.max(0, index + step));
	return order[next].id;
}

/**
 * Read stored collapsed sections. Junk falls back to the default.
 *
 * @param raw - Stored JSON array, or null.
 */
export function parseCollapsed(raw: string | null): Set<ParadeSectionId> {
	if (raw === null) {
		return new Set(DEFAULT_COLLAPSED);
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			return new Set(
				parsed.filter((value): value is ParadeSectionId =>
					(PARADE_SECTIONS as readonly unknown[]).includes(value)
				)
			);
		}
	} catch {
		/* fall through to the default */
	}
	return new Set(DEFAULT_COLLAPSED);
}
