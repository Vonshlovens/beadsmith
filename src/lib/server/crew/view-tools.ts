/**
 * Crew view tools (ADR-0025 rules 1, 5, 7, 8 and 9): First Mate creates and
 * revises saved views, lists them, runs them and reverts them, through the
 * same grown things store the `/api/views` routes use. The store decides
 * who may see or change what, so these tools add no rule of their own.
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
import type { Permission } from '../auth/roles.js';
import { getGrownStore } from '../state/db.js';
import { GrownError } from '../grown/errors.js';
import {
	GROWN_DESCRIPTION_MAX,
	GROWN_NAME_MAX,
	GROWN_SLUG_MAX,
	GROWN_SLUG_PATTERN,
	type GrownAuthor,
	type GrownStore,
	type GrownThing,
	type GrownViewer
} from '../grown/store.js';
import {
	runView,
	view_filters_schema,
	view_spec_schema,
	type RunViewDeps
} from '../grown/view-spec.js';
import { requireView, revisionView, viewSummary } from '../grown/views-api.js';
import { VIEW_GROUPS, VIEW_PRESENTATIONS, VIEW_SORTS } from '#lib/views.js';
import { compactIssue, resolveCrewProject } from './read-tools.js';
import {
	CrewToolError,
	defineTool,
	type CrewContext,
	type CrewDeps,
	type CrewTool
} from './registry.js';

/** Writes need what the `/api/views` writes need: the request gate's admin default. */
const VIEW_WRITE_PERMISSION: Permission = { console: ['manage'] };

/** Revisions `view_history` returns unless asked for more. */
const HISTORY_DEFAULT = 10;

const slug_schema = z
	.string()
	.max(GROWN_SLUG_MAX)
	.regex(GROWN_SLUG_PATTERN, 'lowercase letters and digits in dash-separated words')
	.describe('The view\'s slug, like "blocked-on-review"; its page is /views/<slug>.');

function grownStore(deps: CrewDeps): Promise<GrownStore> {
	return (deps.grown ?? getGrownStore)();
}

function viewerOf(ctx: CrewContext): GrownViewer {
	return { account_id: ctx.account_id, role: ctx.role };
}

function firstMate(ctx: CrewContext): GrownAuthor {
	return { kind: 'first_mate', account_id: ctx.account_id, chat_id: ctx.chat_id };
}

/** The page a view renders on, which the create and revise tools return (rule 9). */
export function viewUrl(slug: string): string {
	return `/views/${slug}`;
}

/** Run a store call, turning its refusal into a message the model reads. */
async function grown<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (error instanceof GrownError) throw new CrewToolError(error.message);
		throw error;
	}
}

function compactView(thing: GrownThing, viewer: GrownViewer) {
	return { ...viewSummary(thing, viewer), url: viewUrl(thing.slug) };
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
	permission: VIEW_WRITE_PERMISSION,
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
		const store = await grownStore(deps);
		const viewer = viewerOf(ctx);
		return grown(async () => {
			const existing = await store.read(viewer, input.slug);
			if (existing !== undefined && existing.kind !== 'view') {
				throw new GrownError('conflict', `The slug "${input.slug}" is taken. Pick another.`);
			}
			const thing =
				existing === undefined
					? await store.create(viewer, {
							kind: 'view',
							slug: input.slug,
							name: input.name,
							description: input.description,
							spec,
							author: firstMate(ctx)
						})
					: await store.revise(viewer, input.slug, {
							name: input.name,
							description: input.description,
							spec,
							author: firstMate(ctx)
						});
			return {
				written: existing === undefined ? 'created' : 'revised',
				view: compactView(thing, viewer)
			};
		});
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
			const thing = await requireView(await grownStore(deps), viewer, input.slug);
			// As the run route does: parse again to type the spec and refuse one
			// today's schema no longer accepts.
			const result = await runView(view_spec_schema.parse(thing.revision.spec), runDeps(deps));
			return {
				view: {
					slug: thing.slug,
					name: thing.revision.name,
					revision: thing.revision.number,
					url: viewUrl(thing.slug)
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

export const view_history = defineTool({
	name: 'view_history',
	description:
		'The kept revisions of one of the chat owner’s views, newest first: number, who wrote ' +
		'it, its definition and whether members see it. Use a number with revert_view.',
	input: z.strictObject({
		slug: slug_schema,
		limit: z.number().int().min(1).max(50).default(HISTORY_DEFAULT)
	}),
	permission: VIEW_WRITE_PERMISSION,
	async handler(ctx, input, deps) {
		const viewer = viewerOf(ctx);
		return grown(async () => {
			const store = await grownStore(deps);
			const thing = await requireView(store, viewer, input.slug);
			const revisions = await store.history(viewer, input.slug);
			return {
				slug: thing.slug,
				url: viewUrl(thing.slug),
				revisions: revisions
					.slice(0, input.limit)
					.map((revision) => revisionView(revision, thing.published_revision_id)),
				...(revisions.length > input.limit
					? { note: `${revisions.length - input.limit} older revisions not shown.` }
					: {})
			};
		});
	}
});

export const revert_view = defineTool({
	name: 'revert_view',
	description:
		'Restore one of the chat owner’s views to an earlier revision (from view_history). ' +
		'The revert is itself a new revision, so nothing is lost. What members see changes only ' +
		'when an admin publishes.',
	input: z.strictObject({
		slug: slug_schema,
		number: z.number().int().min(1).describe('The revision number to restore.')
	}),
	permission: VIEW_WRITE_PERMISSION,
	async handler(ctx, input, deps) {
		const viewer = viewerOf(ctx);
		return grown(async () => {
			const store = await grownStore(deps);
			await requireView(store, viewer, input.slug);
			const thing = await store.revert(viewer, input.slug, input.number, firstMate(ctx));
			return { reverted_to: input.number, view: compactView(thing, viewer) };
		});
	}
});

export const VIEW_TOOLS: CrewTool[] = [
	define_view,
	list_views,
	run_view,
	view_history,
	revert_view
];
