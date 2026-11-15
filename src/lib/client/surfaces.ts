/**
 * How the surface renderer reads a catalog surface (ADR-0025 rule 2): its
 * tree by id, and each binding's resolved data in the shape a catalog
 * component shows. Binding data is a crew read tool's own compact result
 * (`src/lib/server/crew/read-tools.ts`), so it is checked here field by field
 * rather than trusted: a component given data it cannot read shows an error,
 * never a guess. Nothing here interprets text as markup.
 */
import type { SurfaceBindingResult, SurfaceSpecShape } from '#lib/surfaces.js';
import type { ViewGroup, ViewIssue } from '#lib/views.js';
import { groupViewIssues } from '#lib/client/views.js';

export type SurfaceNode = SurfaceSpecShape['components'][number];

/** The tree's components by id. The server checked it is a tree on save. */
export function surfaceNodes(spec: SurfaceSpecShape): Map<string, SurfaceNode> {
	return new Map(spec.components.map((node) => [node.id, node]));
}

/** A resolved binding the renderer can show, or why it cannot. */
export type SurfaceRead<T> = { ok: true; value: T } | { ok: false; message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
	typeof value === 'string' ? value : undefined;

/** The list each read yields; `issue` and `mission` are single records, not countable. */
const LIST_KEY = {
	issues: 'issues',
	projects: 'projects',
	missions: 'missions',
	todos: 'todos'
} as const;

/** `note` is set by the crew tools when a list met its limit, so there may be more. */
function listOf(result: SurfaceBindingResult | undefined): SurfaceRead<{
	items: unknown[];
	data: Record<string, unknown>;
}> {
	if (result === undefined)
		return { ok: false, message: 'The surface’s data could not be loaded.' };
	if (!result.ok) return { ok: false, message: result.message };
	const key = (LIST_KEY as Record<string, string | undefined>)[result.yields];
	const data = result.data;
	const items = key !== undefined && isRecord(data) ? data[key] : undefined;
	if (!isRecord(data) || !Array.isArray(items)) {
		return { ok: false, message: 'This data is not a list this component can show.' };
	}
	return { ok: true, value: { items, data } };
}

/**
 * The count a stat tile shows: every row the binding read, including rows
 * the bridge dropped to fit its result limit (`total`). `more` is true when
 * the read itself stopped at its limit, so the true number may be higher.
 * @param result The binding's resolved value.
 */
export function surfaceCount(
	result: SurfaceBindingResult | undefined
): SurfaceRead<{ count: number; more: boolean }> {
	const list = listOf(result);
	if (!list.ok) return list;
	const { items, data } = list.value;
	const total = typeof data.total === 'number' ? data.total : items.length;
	return { ok: true, value: { count: total, more: typeof data.note === 'string' } };
}

/**
 * The issues a list, board or chart shows, as the shared issue components
 * take them. A crew issue is compact (no counts or creation time); the
 * fields it lacks are filled with neutral values those components do not
 * show for a surface. The project comes from the row (`ready_work` across
 * projects, `run_view`) or the result (`list_issues`, one project's
 * `ready_work`), and its name from the catalogue when the row has none.
 * Rows without an id, title or project are left out rather than drawn
 * half-empty.
 * @param result The binding's resolved value.
 * @param projectName A project's display name from its id.
 */
export function surfaceIssues(
	result: SurfaceBindingResult | undefined,
	projectName: (id: string) => string
): SurfaceRead<{ issues: ViewIssue[]; dropped: number; more: boolean }> {
	const list = listOf(result);
	if (!list.ok) return list;
	if (result?.ok && result.yields !== 'issues') {
		return { ok: false, message: 'This data is not a list of issues.' };
	}
	const { items, data } = list.value;
	const project = isRecord(data.project) ? text(data.project.id) : undefined;
	const issues: ViewIssue[] = [];
	for (const item of items) {
		if (!isRecord(item)) continue;
		const id = text(item.id);
		const title = text(item.title);
		const project_id = text(item.project_id) ?? project;
		if (id === undefined || title === undefined || project_id === undefined) continue;
		const updated_at = text(item.updated_at) ?? '';
		issues.push({
			id,
			title,
			status: text(item.status) ?? 'open',
			priority: typeof item.priority === 'number' ? item.priority : 2,
			issue_type: text(item.type) ?? 'task',
			assignee: text(item.assignee),
			labels: Array.isArray(item.labels) ? item.labels.filter((l) => typeof l === 'string') : [],
			created_at: updated_at,
			updated_at,
			dependency_count: 0,
			dependent_count: 0,
			comment_count: 0,
			project_id,
			project_name: text(item.project_name) ?? projectName(project_id)
		});
	}
	const total = typeof data.total === 'number' ? data.total : items.length;
	return {
		ok: true,
		value: {
			issues,
			// Rows the bridge cut to fit its limit; a list says how many it is not showing.
			dropped: Math.max(0, total - issues.length),
			more: typeof data.note === 'string'
		}
	};
}

export interface SurfaceBar {
	key: string;
	label: string;
	count: number;
}

/**
 * A bar chart's bars: issues counted by one field, in the same order and
 * with the same labels a view grouped by that field uses (statuses and
 * priorities in their natural order, the rest by label).
 * @param issues The binding's issues.
 * @param by The field to count by.
 */
export function surfaceBars(issues: ViewIssue[], by: ViewGroup): SurfaceBar[] {
	return groupViewIssues(issues, by).map((group) => ({
		key: group.key,
		label: group.label,
		count: group.issues.length
	}));
}

/** Catalog components a reader cares about in a summary; layout and text are left out. */
const SHOWN: Partial<Record<SurfaceNode['component'], [one: string, many: string]>> = {
	StatTile: ['stat tile', 'stat tiles'],
	IssueList: ['issue list', 'issue lists'],
	IssueBoard: ['board', 'boards'],
	Chart: ['chart', 'charts'],
	Button: ['button', 'buttons']
};

/**
 * What a surface shows, in words, for the catalogue: "2 stat tiles · issue
 * list · chart", in the order the tree first uses each, or "Text" when it
 * has only headings and text.
 * @param spec The surface's spec.
 */
export function describeSurfaceSpec(spec: SurfaceSpecShape): string {
	const counts = new Map<string, { n: number; words: [string, string] }>();
	for (const node of spec.components) {
		const words = SHOWN[node.component];
		if (words === undefined) continue;
		const entry = counts.get(node.component) ?? { n: 0, words };
		entry.n += 1;
		counts.set(node.component, entry);
	}
	if (counts.size === 0) return 'Text';
	return [...counts.values()]
		.map(({ n, words }) => (n === 1 ? words[0] : `${n} ${words[1]}`))
		.join(' · ');
}
