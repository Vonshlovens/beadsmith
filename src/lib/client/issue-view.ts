/**
 * Parade, list and board are views of the same project issues URL, not
 * separate routes. `view=parade|list|board` are explicit destinations. A
 * missing `view` param restores the per-project preference, otherwise the
 * parade. Unknown values fall back to the default so a shareable URL never 404s.
 */
export const ISSUE_VIEWS = ['parade', 'list', 'board'] as const;

export type IssueView = (typeof ISSUE_VIEWS)[number];

/** The issues page with no stored preference and no `view` query param. */
export const DEFAULT_ISSUE_VIEW: IssueView = 'parade';

/**
 * localStorage key for the last-selected list/board mode of one project.
 *
 * @param project_id - Project id in the `/p/:id` path.
 */
export function issueViewStorageKey(project_id: string): string {
	return `bdui:issue-view:${project_id}`;
}

/**
 * Read the issues view out of a query value.
 *
 * @param raw - `view` query parameter, or null/undefined when omitted.
 */
export function parseIssueView(raw: string | null | undefined): IssueView {
	return parseStoredIssueView(raw) ?? DEFAULT_ISSUE_VIEW;
}

/**
 * Read a stored preference. Unknown or empty values mean "no preference yet"
 * rather than list, so a junk key does not wipe a later restore.
 *
 * @param raw - Stored value, or null/undefined when nothing was stored.
 */
export function parseStoredIssueView(raw: string | null | undefined): IssueView | null {
	return (ISSUE_VIEWS as readonly string[]).includes(raw ?? '') ? (raw as IssueView) : null;
}

/**
 * True when the URL named a view, including `view=list`. Omitted `view` is
 * the restore case; a present key always wins over the remembered preference.
 *
 * @param params - Current search params.
 */
export function hasExplicitIssueView(params: URLSearchParams): boolean {
	return params.has('view');
}

/**
 * Choose the view to show: an explicit `view` query param wins; otherwise
 * the remembered per-project preference; otherwise the parade.
 *
 * @param params - Current search params.
 * @param remembered - Stored preference, or null when none.
 */
export function resolveIssueView(params: URLSearchParams, remembered: IssueView | null): IssueView {
	if (hasExplicitIssueView(params)) {
		return parseIssueView(params.get('view'));
	}
	return remembered ?? DEFAULT_ISSUE_VIEW;
}

/**
 * Build a project issues href. Every view writes `view` so the rail and
 * segmented control are explicit destinations. Other query params are
 * preserved. URLs that omit `view` (project cards, switcher) restore prefs.
 *
 * @param project_id - Project id in the `/p/:id` path.
 * @param view - Desired view mode.
 * @param current - Existing search params to keep (filters, q, include_closed).
 */
export function projectIssuesHref(
	project_id: string,
	view: IssueView,
	current?: URLSearchParams
): string {
	const params = new URLSearchParams(current);
	params.set('view', view);
	const qs = params.toString();
	return qs ? `/p/${project_id}?${qs}` : `/p/${project_id}`;
}

/**
 * Issue detail href shared by table cell anchors, row click, and hover preload.
 *
 * @param project_id - Project id in the `/p/:id` path.
 * @param issue_id - Issue id in the `/i/:issue_id` path.
 */
export function issueDetailHref(project_id: string, issue_id: string): string {
	return `/p/${project_id}/i/${issue_id}`;
}

/**
 * True when the Issues rail item should be current. Issue detail stays on
 * Issues, as do the parade and list views; the board view does not.
 *
 * @param pathname - Current URL pathname.
 * @param project_id - Project in the rail.
 * @param view - Parsed view of the current URL.
 */
export function issuesNavActive(pathname: string, project_id: string, view: IssueView): boolean {
	const root = `/p/${project_id}`;
	if (pathname === root) {
		return view !== 'board';
	}
	return pathname.startsWith(`${root}/`);
}

/**
 * True when the Board rail item should be current. Only the project issues
 * list with `view=board` counts — not issue detail.
 *
 * @param pathname - Current URL pathname.
 * @param project_id - Project in the rail.
 * @param view - Parsed view of the current URL.
 */
export function boardNavActive(pathname: string, project_id: string, view: IssueView): boolean {
	return pathname === `/p/${project_id}` && view === 'board';
}
