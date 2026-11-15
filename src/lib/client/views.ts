/**
 * How the Views pages present a saved view (ADR-0025 rule 1): its rows in
 * the groups its spec names, and its spec in words, so a reader can tell
 * what a view selects without opening its JSON.
 */
import { priorityName, STATUS_KEYS, statusKey, statusLabel } from '#lib/client/format.js';
import type { ListFilters } from '#lib/client/issue-list-cache.js';
import type { IssueView } from '#lib/client/issue-view.js';
import { GROWN_SLUG_MAX } from '#lib/grown.js';
import {
	VIEW_LIMIT_MAX,
	type ViewGroup,
	type ViewIssue,
	type ViewPresentation,
	type ViewSort,
	type ViewSpecShape
} from '#lib/views.js';

export interface ViewIssueGroup {
	key: string;
	label: string;
	issues: ViewIssue[];
}

export const SORT_LABEL: Record<ViewSort, string> = {
	updated: 'Recently updated',
	created: 'Newest',
	priority: 'Priority',
	id: 'Id'
};

/** The group an issue falls in, as a sortable key and a label. */
function groupOf(issue: ViewIssue, by: ViewGroup): { key: string; label: string; rank: number } {
	switch (by) {
		case 'status': {
			const key = statusKey(issue.status);
			return { key, label: statusLabel(issue.status), rank: STATUS_KEYS.indexOf(key) };
		}
		case 'priority':
			return {
				key: String(issue.priority),
				label: `P${issue.priority} · ${priorityName(issue.priority)}`,
				rank: issue.priority
			};
		case 'type':
			return { key: issue.issue_type, label: issue.issue_type, rank: 0 };
		case 'assignee':
			// Unassigned last, so the named owners of work lead.
			return issue.assignee
				? { key: `a:${issue.assignee}`, label: issue.assignee, rank: 0 }
				: { key: 'none', label: 'Unassigned', rank: 1 };
		case 'project':
			return { key: issue.project_id, label: issue.project_name, rank: 0 };
	}
}

/**
 * Split a view's rows into its groups, keeping the view's row order inside
 * each. Statuses and priorities group in their natural order, the rest by
 * label. No grouping is one unlabelled group.
 * @param issues The view's rows, already in its sort order.
 * @param by The spec's `group_by`.
 */
export function groupViewIssues(issues: ViewIssue[], by: ViewGroup | undefined): ViewIssueGroup[] {
	if (by === undefined) return [{ key: 'all', label: '', issues }];
	const groups = new Map<string, ViewIssueGroup & { rank: number }>();
	for (const issue of issues) {
		const { key, label, rank } = groupOf(issue, by);
		let group = groups.get(key);
		if (group === undefined) {
			group = { key, label, rank, issues: [] };
			groups.set(key, group);
		}
		group.issues.push(issue);
	}
	return [...groups.values()]
		.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label))
		.map(({ key, label, issues: rows }) => ({ key, label, issues: rows }));
}

/**
 * A view's spec as short phrases, in the order a reader asks about it:
 * where, what, how ordered, how shown.
 * @param spec The view's spec.
 * @param projectName Resolves a project id to its name.
 */
export function describeViewSpec(
	spec: ViewSpecShape,
	projectName: (id: string) => string
): string[] {
	const parts: string[] = [spec.scope === 'all' ? 'All projects' : projectName(spec.scope.project)];
	const f = spec.filters;
	if (f.status) parts.push(`Status: ${f.status.map((s) => statusLabel(s)).join(', ')}`);
	if (f.type) parts.push(`Type: ${f.type.join(', ')}`);
	if (f.priority) parts.push(`Priority: ${f.priority.map((p) => `P${p}`).join(', ')}`);
	if (f.label) parts.push(`Label: ${f.label}`);
	if (f.assignee) parts.push(`Assignee: ${f.assignee}`);
	if (f.q) parts.push(`Text: “${f.q}”`);
	if (f.include_closed) parts.push('Includes closed');
	parts.push(`Sorted: ${SORT_LABEL[spec.sort]}`);
	parts.push(
		spec.presentation === 'board'
			? 'Board'
			: spec.group_by === undefined
				? 'List'
				: `List by ${spec.group_by}`
	);
	if (f.limit !== undefined) parts.push(`Up to ${f.limit} rows`);
	return parts;
}

/**
 * Which projects a board shows, in first-seen order: a board's columns are
 * one project's statuses, so an all-projects view draws a board per project.
 * @param issues The view's rows.
 */
export function viewBoardProjects(
	issues: ViewIssue[]
): { project_id: string; project_name: string; issues: ViewIssue[] }[] {
	const byProject = new Map<
		string,
		{ project_id: string; project_name: string; issues: ViewIssue[] }
	>();
	for (const issue of issues) {
		let entry = byProject.get(issue.project_id);
		if (entry === undefined) {
			entry = { project_id: issue.project_id, project_name: issue.project_name, issues: [] };
			byProject.set(issue.project_id, entry);
		}
		entry.issues.push(issue);
	}
	return [...byProject.values()];
}

/*
 * The project page and a saved view describe the same rows two ways: the
 * page in its URL (`readListFilters`, `?view=`), a view in its spec. Saving
 * from the page turns one into the other, and "Open in project" turns it
 * back, so a person can tune a view with the page's own filter controls and
 * save the result as a new revision. Only what the page can show round-trips:
 * a view with a label, assignee or row limit, an all-projects scope or a
 * grouping other than the parade's has no page equivalent and is edited
 * elsewhere. Table sorting is not in the URL (`#lib/client/sort.js`), so it
 * is not captured; updating a view keeps the sort it had.
 */

/** The URL parameter that says which saved view the project page has open. */
export const SAVED_VIEW_PARAM = 'saved';

/**
 * The spec the project page's current filters and view describe. Parade is
 * the status-grouped list, list the plain list, board the board.
 * @param project_id The page's project.
 * @param filters Its URL filters.
 * @param view Its presentation.
 * @param base The open saved view's spec, whose sort an update keeps.
 */
export function viewSpecFromProjectPage(
	project_id: string,
	filters: ListFilters,
	view: IssueView,
	base?: ViewSpecShape
): ViewSpecShape {
	const out: ViewSpecShape['filters'] = {};
	if (filters.status.length > 0) out.status = [...filters.status];
	if (filters.type.length > 0) out.type = [...filters.type];
	if (filters.priority.length > 0) out.priority = [...filters.priority];
	const q = filters.q.trim();
	if (q) out.q = q;
	if (filters.include_closed) out.include_closed = true;
	return {
		scope: { project: project_id },
		filters: out,
		sort: base?.sort ?? 'updated',
		presentation: view === 'board' ? 'board' : 'list',
		...(view === 'parade' ? { group_by: 'status' as const } : {})
	};
}

/**
 * The project page that shows a view's rows, or null when the page cannot
 * show them (see above), so nothing offers a page that would mislead.
 * @param spec The view's spec.
 */
export function projectPageForView(
	spec: ViewSpecShape
): { project_id: string; filters: ListFilters; view: IssueView } | null {
	if (spec.scope === 'all') return null;
	const f = spec.filters;
	if (f.label !== undefined || f.assignee !== undefined || f.limit !== undefined) return null;
	let view: IssueView;
	if (spec.presentation === 'board') view = 'board';
	else if (spec.group_by === undefined) view = 'list';
	else if (spec.group_by === 'status') view = 'parade';
	else return null;
	return {
		project_id: spec.scope.project,
		filters: {
			status: [...(f.status ?? [])],
			type: [...(f.type ?? [])],
			priority: [...(f.priority ?? [])],
			q: f.q ?? '',
			include_closed: f.include_closed === true
		},
		view
	};
}

/**
 * The project page href for a saved view, carrying its slug so the page
 * offers to update it, or null when the page cannot show it.
 * @param slug The view's slug.
 * @param spec Its spec.
 */
export function projectPageHref(slug: string, spec: ViewSpecShape): string | null {
	const target = projectPageForView(spec);
	if (target === null) return null;
	const params = new URLSearchParams();
	const { filters } = target;
	if (filters.status.length > 0) params.set('status', filters.status.join(','));
	if (filters.type.length > 0) params.set('type', filters.type.join(','));
	if (filters.priority.length > 0) params.set('priority', filters.priority.join(','));
	if (filters.q) params.set('q', filters.q);
	if (filters.include_closed) params.set('include_closed', '1');
	params.set('view', target.view);
	params.set(SAVED_VIEW_PARAM, slug);
	return `/p/${encodeURIComponent(target.project_id)}?${params.toString()}`;
}

/** A spec with list order, absent keys and `include_closed: false` made irrelevant. */
function canonicalSpec(spec: ViewSpecShape): string {
	const f = spec.filters;
	const filters = {
		status: f.status === undefined ? undefined : [...f.status].sort(),
		type: f.type === undefined ? undefined : [...f.type].sort(),
		priority: f.priority === undefined ? undefined : [...f.priority].sort((a, b) => a - b),
		q: f.q,
		label: f.label,
		assignee: f.assignee,
		include_closed: f.include_closed === true ? true : undefined,
		limit: f.limit
	};
	return JSON.stringify({
		scope: spec.scope,
		filters,
		sort: spec.sort,
		presentation: spec.presentation,
		// A board ignores grouping, so a board with or without one is the same view.
		group_by: spec.presentation === 'board' ? undefined : spec.group_by
	});
}

/**
 * True when two specs select and show the same rows, so the page offers an
 * update only when there is something to save.
 */
export function sameViewSpec(a: ViewSpecShape, b: ViewSpecShape): boolean {
	return canonicalSpec(a) === canonicalSpec(b);
}

/**
 * A slug suggested from a name: lowercase ASCII words joined by dashes,
 * within the store's length limit. Empty when the name has no letters or
 * digits, so the form asks for one.
 * @param name The view's name as typed.
 */
export function slugFromName(name: string): string {
	return name
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, GROWN_SLUG_MAX)
		.replace(/-+$/, '');
}

/*
 * The filter vocabulary the project page's filter menus offer, which the view
 * editor on `/views/<slug>` offers too, so a filter means the same thing in
 * both places. A view written by First Mate may name a status or type outside
 * these (a project's custom status); the editor keeps such values as extra
 * choices rather than dropping them (`filterChoices`).
 */
export const FILTER_STATUSES = [
	'open',
	'in_progress',
	'blocked',
	'deferred',
	'closed',
	'pinned',
	'hooked'
] as const;
export const FILTER_TYPES = ['bug', 'feature', 'task', 'epic', 'chore'] as const;
export const FILTER_PRIORITIES = [0, 1, 2, 3, 4] as const;

/** The scope select's value for "every project"; project ids start with `d_`. */
export const ALL_PROJECTS = '*';

/**
 * A view's spec as the editor's fields hold it: text inputs as strings, the
 * scope as one select value, no grouping as `'none'`.
 */
export interface ViewSpecForm {
	scope: string;
	status: string[];
	type: string[];
	priority: number[];
	q: string;
	label: string;
	assignee: string;
	include_closed: boolean;
	/** Empty for the default row limit. */
	limit: string;
	sort: ViewSort;
	presentation: ViewPresentation;
	group_by: ViewGroup | 'none';
}

/**
 * The editor's fields for a stored spec.
 * @param spec The view's current spec.
 */
export function viewSpecForm(spec: ViewSpecShape): ViewSpecForm {
	const f = spec.filters;
	return {
		scope: spec.scope === 'all' ? ALL_PROJECTS : spec.scope.project,
		status: [...(f.status ?? [])],
		type: [...(f.type ?? [])],
		priority: [...(f.priority ?? [])],
		q: f.q ?? '',
		label: f.label ?? '',
		assignee: f.assignee ?? '',
		include_closed: f.include_closed === true,
		limit: f.limit === undefined ? '' : String(f.limit),
		sort: spec.sort,
		presentation: spec.presentation,
		group_by: spec.group_by ?? 'none'
	};
}

/**
 * Why the row-limit field cannot be saved, or undefined when it can. Empty
 * means the default limit.
 * @param text The field as typed.
 */
export function viewLimitError(text: string): string | undefined {
	const trimmed = text.trim();
	if (trimmed === '') return undefined;
	const n = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
	return Number.isInteger(n) && n >= 1 && n <= VIEW_LIMIT_MAX
		? undefined
		: `A whole number from 1 to ${VIEW_LIMIT_MAX}, or empty for the default.`;
}

/**
 * The spec the editor's fields describe. Empty text and empty choices drop
 * their filter, and a board drops its grouping (a board ignores one). The
 * caller checks `viewLimitError` first; the server validates the rest.
 * @param form The editor's fields.
 */
export function viewSpecFromForm(form: ViewSpecForm): ViewSpecShape {
	const filters: ViewSpecShape['filters'] = {};
	if (form.status.length > 0) filters.status = [...form.status];
	if (form.type.length > 0) filters.type = [...form.type];
	if (form.priority.length > 0) filters.priority = [...form.priority].sort((a, b) => a - b);
	const q = form.q.trim();
	if (q) filters.q = q;
	const label = form.label.trim();
	if (label) filters.label = label;
	const assignee = form.assignee.trim();
	if (assignee) filters.assignee = assignee;
	if (form.include_closed) filters.include_closed = true;
	const limit = form.limit.trim();
	if (limit) filters.limit = Number(limit);
	return {
		scope: form.scope === ALL_PROJECTS ? 'all' : { project: form.scope },
		filters,
		sort: form.sort,
		presentation: form.presentation,
		...(form.presentation === 'list' && form.group_by !== 'none' ? { group_by: form.group_by } : {})
	};
}

/**
 * A filter's choices: the shared vocabulary, then any value the view already
 * holds that the vocabulary lacks, so editing never silently drops it.
 * @param vocabulary The options the project page offers.
 * @param held The values in the view's spec.
 */
export function filterChoices<T extends string | number>(
	vocabulary: readonly T[],
	held: readonly T[]
): T[] {
	return [...vocabulary, ...held.filter((value) => !vocabulary.includes(value))];
}

/**
 * What a save sends: only the fields that changed, or null when nothing did,
 * so the editor never writes a revision identical to the one it opened.
 * @param before The view as the editor opened it.
 * @param after The editor's name, description and spec.
 */
export function viewRevisionChanges(
	before: { name: string; description: string; spec: ViewSpecShape },
	after: { name: string; description: string; spec: ViewSpecShape }
): { name?: string; description?: string; spec?: ViewSpecShape } | null {
	const changes: { name?: string; description?: string; spec?: ViewSpecShape } = {};
	const name = after.name.trim();
	const description = after.description.trim();
	if (name !== before.name) changes.name = name;
	if (description !== before.description) changes.description = description;
	if (!sameViewSpec(before.spec, after.spec)) changes.spec = after.spec;
	return Object.keys(changes).length === 0 ? null : changes;
}
