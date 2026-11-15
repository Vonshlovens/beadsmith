/**
 * Saved views (ADR-0025 rule 1): a declarative spec of scope, browse filters,
 * sort and presentation, run by compiling it onto `BrowseFilters` and reading
 * through `listProjectIssues`, the same read path the project page uses. A
 * spec never holds SQL, column names or expressions: the schema is strict
 * (unknown keys are refused), list filters are short word tokens, and every
 * value reaches Dolt as a bound parameter through `buildIssueWhere` (0003
 * unchanged).
 *
 * A view has no authority of its own (rule 5). Running one reads only what
 * `listProjectIssues` lets any signed-in account read, so the caller runs it
 * in the viewer's request after the store has checked the viewer may see it.
 */
import { z } from 'zod';
import { discoverProjects, resolveProject } from '../discovery.js';
import { listProjectIssues, type IssueFilters, type ReadDeps } from '../read-model.js';
import { safeError } from '../security.js';
import { GrownError } from './errors.js';
import { label_schema, MAX_LIST_LIMIT, project_id_schema } from '../validation.js';
import type { Project } from '#lib/types.js';
import {
	VIEW_GROUPS,
	VIEW_PRESENTATIONS,
	VIEW_SORTS,
	type ViewIssue,
	type ViewResult,
	type ViewSort,
	type ViewSpecShape
} from '#lib/views.js';

/** Most JSON bytes in a view spec (ADR-0025 limits). */
export const VIEW_SPEC_MAX_BYTES = 4096;
/** Longest text search, as the project page's `q`. */
export const VIEW_TEXT_MAX = 200;
/** Rows a view returns when its spec names no limit. */
export const VIEW_DEFAULT_LIMIT = 200;

/**
 * A status or issue type: a lowercase word, as Beads writes them. Commas,
 * quotes, spaces and operators are refused, so a list filter can never carry
 * anything but a value.
 */
const token_schema = z
	.string()
	.regex(/^[a-z][a-z0-9_-]{0,31}$/, 'a status or type is a lowercase word like "in_progress"');

/** Exact assignee: printable text, no control characters. */
const assignee_schema = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[^\p{Cc}]+$/u, 'an assignee is plain text');

export const view_filters_schema = z.strictObject({
	status: z.array(token_schema).min(1).max(16).optional(),
	type: z.array(token_schema).min(1).max(16).optional(),
	priority: z.array(z.number().int().min(0).max(4)).min(1).max(5).optional(),
	q: z.string().min(1).max(VIEW_TEXT_MAX).optional(),
	label: label_schema.optional(),
	assignee: assignee_schema.optional(),
	include_closed: z.boolean().optional(),
	limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional()
});

export const view_spec_schema = z.strictObject({
	/** One project by id, or every project in the catalogue. */
	scope: z.union([z.strictObject({ project: project_id_schema }), z.literal('all')]),
	filters: view_filters_schema.default({}),
	sort: z.enum(VIEW_SORTS).default('updated'),
	presentation: z.enum(VIEW_PRESENTATIONS).default('list'),
	group_by: z.enum(VIEW_GROUPS).optional()
});

export type ViewSpec = z.infer<typeof view_spec_schema>;
export type ViewFilters = z.infer<typeof view_filters_schema>;

/** The browser's copy of the shape (`#lib/views.js`) must stay assignable from the schema's. */
const _shape_check = (spec: ViewSpec): ViewSpecShape => spec;
void _shape_check;

/**
 * Compile a parsed spec's filters onto the read plane's filters. Lists become
 * the comma-joined form `buildIssueWhere` splits again; tokens cannot hold a
 * comma, so the round trip is exact.
 * @param filters Parsed view filters.
 */
export function compileViewFilters(filters: ViewFilters): IssueFilters {
	return {
		limit: filters.limit ?? VIEW_DEFAULT_LIMIT,
		include_closed: filters.include_closed === true,
		status: filters.status?.join(','),
		type: filters.type?.join(','),
		priority: filters.priority?.join(','),
		q: filters.q,
		label: filters.label,
		assignee: filters.assignee
	};
}

export interface RunViewDeps {
	read?: ReadDeps;
	projects?: () => Promise<Project[]>;
	resolve?: (id: string) => Promise<Project | undefined>;
}

const COMPARE: Record<ViewSort, (a: ViewIssue, b: ViewIssue) => number> = {
	updated: (a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at),
	created: (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
	priority: (a, b) => a.priority - b.priority || COMPARE.updated(a, b),
	id: (a, b) => a.id.localeCompare(b.id) || a.project_id.localeCompare(b.project_id)
};

/**
 * Run a view. The read plane returns each project's most recently updated
 * rows up to the limit; `sort` orders those rows, so a priority-sorted view
 * of a large project shows the top priorities among its newest `limit`
 * issues, and `limit_reached` says when that cut applied.
 * @param spec Parsed spec (from the store, which validated it).
 * @param deps Injectable discovery and read clients.
 */
export async function runView(spec: ViewSpec, deps: RunViewDeps = {}): Promise<ViewResult> {
	const filters = compileViewFilters(spec.filters);
	let projects: Project[];
	if (spec.scope === 'all') {
		projects = await (deps.projects ?? (() => discoverProjects()))();
	} else {
		const project = await (deps.resolve ?? resolveProject)(spec.scope.project);
		if (project === undefined) {
			throw new GrownError(
				'not_found',
				`The view's project ${spec.scope.project} is not in the catalogue. Change its scope.`
			);
		}
		projects = [project];
	}
	const skipped: ViewResult['skipped'] = [];
	let limit_reached = false;
	const batches = await Promise.all(
		projects.map(async (project) => {
			try {
				const { issues } = await listProjectIssues(project, filters, deps.read);
				if (issues.length >= filters.limit) limit_reached = true;
				return issues.map((issue) => ({
					...issue,
					project_id: project.id,
					project_name: project.name
				}));
			} catch (error) {
				// A single-project view reports its failure; an all-projects view
				// shows what it could read, as Ready does.
				if (spec.scope !== 'all') throw error;
				skipped.push({ project_id: project.id, message: safeError(error).message });
				return [];
			}
		})
	);
	const merged = batches.flat().sort(COMPARE[spec.sort]);
	if (merged.length > filters.limit) limit_reached = true;
	return { issues: merged.slice(0, filters.limit), limit_reached, skipped };
}
