/**
 * Saved views as the API returns them and the Views pages show them
 * (ADR-0025 rules 1, 7 and 9). Shared by `src/routes/api/views/` and the
 * pages, so both read one vocabulary. The strict zod schema that validates a
 * spec lives with the server (`src/lib/server/grown/view-spec.ts`), which
 * takes its option lists from here.
 */
import type { GrownRevisionView, GrownSummary } from '#lib/grown.js';
import type { IssueSummary } from '#lib/types.js';

export const VIEW_SORTS = ['updated', 'created', 'priority', 'id'] as const;
export type ViewSort = (typeof VIEW_SORTS)[number];

export const VIEW_PRESENTATIONS = ['list', 'board'] as const;
export type ViewPresentation = (typeof VIEW_PRESENTATIONS)[number];

export const VIEW_GROUPS = ['status', 'priority', 'type', 'assignee', 'project'] as const;
export type ViewGroup = (typeof VIEW_GROUPS)[number];

/** One project by id, or every project in the catalogue. */
export type ViewScope = { project: string } | 'all';

/** A stored spec, defaults filled in (the server's schema checks the same shape). */
export interface ViewSpecShape {
	scope: ViewScope;
	filters: {
		status?: string[];
		type?: string[];
		priority?: number[];
		q?: string;
		label?: string;
		assignee?: string;
		include_closed?: boolean;
		limit?: number;
	};
	sort: ViewSort;
	presentation: ViewPresentation;
	group_by?: ViewGroup;
}

export interface ViewIssue extends IssueSummary {
	project_id: string;
	project_name: string;
}

/** The rows a view produced for this viewer. */
export interface ViewResult {
	issues: ViewIssue[];
	/** True when a project returned a full page, so there may be more rows. */
	limit_reached: boolean;
	/** Projects an all-projects view could not read; the rest still show. */
	skipped: { project_id: string; message: string }[];
}

/** A view as this viewer sees it (see `GrownSummary`). */
export type ViewSummary = GrownSummary<ViewSpecShape>;

export type ViewRevisionView = GrownRevisionView<ViewSpecShape>;

export interface ViewsResponse {
	views: ViewSummary[];
}

export interface ViewResponse {
	view: ViewSummary;
}

export interface ViewRunResponse {
	view: ViewSummary;
	result: ViewResult;
}

export interface ViewHistoryResponse {
	revisions: ViewRevisionView[];
}
