/**
 * How the Views pages present a saved view (ADR-0025 rule 1): its rows in
 * the groups its spec names, and its spec in words, so a reader can tell
 * what a view selects without opening its JSON.
 */
import { priorityName, STATUS_KEYS, statusKey, statusLabel } from '#lib/client/format.js';
import type { ViewGroup, ViewIssue, ViewSort, ViewSpecShape } from '#lib/views.js';

export interface ViewIssueGroup {
	key: string;
	label: string;
	issues: ViewIssue[];
}

const SORT_LABEL: Record<ViewSort, string> = {
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
