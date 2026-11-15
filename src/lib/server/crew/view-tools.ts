/**
 * Crew view tools (ADR-0025 rules 1, 5, 7, 8 and 9): First Mate creates and
 * revises saved views, lists them, runs them and reverts them, through the
 * same grown things store the `/api/views` routes use, with the rules every
 * grown tool shares (`grown-tools.ts`). The store decides who may see or
 * change what, so these tools add no rule of their own.
 *
 * - Every call acts as the chat's owner with the owner's role (rule 5), and
 *   every revision it writes is attributed to First Mate and the chat (rule 8).
 * - A view First Mate writes is owner-private: there is deliberately no
 *   publish or share tool (rule 7). A revision members can see changes only
 *   when an admin publishes it from the browser.
 * - `run_view` returns the rows the view's page shows, so First Mate reuses
 *   its views as tools instead of rebuilding the query each time.
 */
import { z } from 'zod';
import {
	GROWN_DESCRIPTION_MAX,
	GROWN_NAME_MAX,
	type GrownThing,
	type GrownViewer
} from '../grown/store.js';
import {
	runView,
	view_filters_schema,
	view_spec_schema,
	type RunViewDeps
} from '../grown/view-spec.js';
import { requireGrown } from '../grown/grown-api.js';
import { VIEW_GROUPS, VIEW_PRESENTATIONS, VIEW_SORTS, type ViewSpecShape } from '#lib/views.js';
import { compactIssue, resolveCrewProject } from './read-tools.js';
import { defineTool, type CrewDeps, type CrewTool } from './registry.js';
import {
	compactGrown,
	defineGrown,
	GROWN_WRITE_PERMISSION,
	grown,
	grownHistoryTool,
	grownRevertTool,
	grownSlugSchema,
	grownStore,
	grownUrl,
	viewerOf
} from './grown-tools.js';

const slug_schema = grownSlugSchema('view');

function compactView(thing: GrownThing, viewer: GrownViewer) {
	return compactGrown<ViewSpecShape>(thing, viewer);
}

/**
 * Discovery for `runView`: the crew's injected project list when there is
 * one (tests), else `runView`'s own defaults.
 */
function runDeps(deps: CrewDeps): RunViewDeps {
	const projects = deps.projects;
	if (projects === undefined) return { read: deps.read };
	return {
		read: deps.read,
		projects: () => projects({}),
		resolve: async (id) =>
			(await projects({})).find((project) => project.id === id) ??
			(await projects({ force: true })).find((project) => project.id === id)
	};
}

export const define_view = defineTool({
	name: 'define_view',
	description:
		'Create a saved view, or revise one of yours under the same slug: a named, reusable ' +
		'issue list or board over one project or every project. Send the whole definition each ' +
		'time; omitted filters are not carried over (an omitted description is). Every change is ' +
		'a new revision the owner can revert. Views you write are private to the chat owner ' +
		'until an admin publishes them in the browser. Returns the view and its URL; give the ' +
		'captain the link. Use run_view to read its rows.',
	input: z.strictObject({
		slug: slug_schema,
		name: z.string().min(1).max(GROWN_NAME_MAX),
		description: z.string().max(GROWN_DESCRIPTION_MAX).optional(),
		project: z
			.string()
			.regex(/^[A-Za-z0-9_-]{1,80}$/, 'invalid project')
			.optional()
			.describe(
				'Project id from list_projects (d_…) or its database name, or "all" for every ' +
					'project. Omit to use the chat’s project.'
			),
		filters: view_filters_schema
			.default({})
			.describe(
				'status and type are lists of lowercase words ("open", "in_progress"); priority a ' +
					'list of 0-4; q a substring of id, title or label; label and assignee exact. ' +
					'Closed issues are left out unless status names them or include_closed is true.'
			),
		sort: z.enum(VIEW_SORTS).default('updated'),
		presentation: z.enum(VIEW_PRESENTATIONS).default('list'),
		group_by: z.enum(VIEW_GROUPS).optional().describe('Group a list view’s rows.')
	}),
	permission: GROWN_WRITE_PERMISSION,
	async handler(ctx, input, deps) {
		const scope =
			input.project === 'all'
				? ('all' as const)
				: { project: (await resolveCrewProject(ctx, deps, input.project)).id };
		const spec = {
			scope,
			filters: input.filters,
			sort: input.sort,
			presentation: input.presentation,
			...(input.group_by === undefined ? {} : { group_by: input.group_by })
		};
		const { written, thing, viewer } = await defineGrown(ctx, deps, 'view', {
			slug: input.slug,
			name: input.name,
			description: input.description,
			spec
		});
		return { written, view: compactView(thing, viewer) };
	}
});

export const list_views = defineTool({
	name: 'list_views',
	description:
		'List saved views: the chat owner’s own (latest revision) and the ones members can see ' +
		'(published revision), newest change first, with their definitions and URLs.',
	input: z.strictObject({}),
	async handler(ctx, _input, deps) {
		const viewer = viewerOf(ctx);
		const things = await grown(async () => (await grownStore(deps)).list(viewer, 'view'));
		return { views: things.map((thing) => compactView(thing, viewer)) };
	}
});

export const run_view = defineTool({
	name: 'run_view',
	description:
		'Run a saved view as the chat owner and return its issues: the same rows its page ' +
		'shows, in its sort order. Each row names its project for show_issue.',
	input: z.strictObject({ slug: slug_schema }),
	async handler(ctx, input, deps) {
		const viewer = viewerOf(ctx);
		return grown(async () => {
			const thing = await requireGrown(await grownStore(deps), viewer, 'view', input.slug);
			// As the run route does: parse again to type the spec and refuse one
			// today's schema no longer accepts.
			const result = await runView(view_spec_schema.parse(thing.revision.spec), runDeps(deps));
			return {
				view: {
					slug: thing.slug,
					name: thing.revision.name,
					revision: thing.revision.number,
					url: grownUrl(thing.slug)
				},
				issues: result.issues.map((issue) => ({
					...compactIssue(issue),
					project_id: issue.project_id,
					project_name: issue.project_name
				})),
				...(result.limit_reached
					? {
							note:
								'Limit reached; there may be more. The view reads each project’s most ' +
								'recently updated issues up to its limit.'
						}
					: {}),
				...(result.skipped.length > 0 ? { skipped: result.skipped } : {})
			};
		});
	}
});

export const view_history = grownHistoryTool(
	'view',
	'view_history',
	'The kept revisions of one of the chat owner’s views, newest first: number, who wrote ' +
		'it, its definition and whether members see it. Use a number with revert_view.'
);

export const revert_view = grownRevertTool(
	'view',
	'revert_view',
	'Restore one of the chat owner’s views to an earlier revision (from view_history). ' +
		'The revert is itself a new revision, so nothing is lost. What members see changes only ' +
		'when an admin publishes.'
);

export const VIEW_TOOLS: CrewTool[] = [
	define_view,
	list_views,
	run_view,
	view_history,
	revert_view
];
