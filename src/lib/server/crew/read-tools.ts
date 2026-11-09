/**
 * Crew read tools (ADR-0020 rule 4): projects, ready work, issues, missions
 * and todos, read through the same modules and permission checks as the
 * browser API. Results are compact: the fields a liaison needs to answer and
 * route, never the full rows.
 */
import { z } from 'zod';
import { discoverProjects } from '../discovery.js';
import {
	getIssueEvents,
	getMergedReadyIssues,
	getProjectIssue,
	getProjectReadyIssues,
	listProjectIssues
} from '../read-model.js';
import { getDispatch, listDispatchTurns, listMissions } from '../dispatch/service.js';
import { getTodoStore } from '../state/db.js';
import {
	dispatch_request_id_schema,
	issue_id_schema,
	label_schema,
	todo_tag_schema
} from '../validation.js';
import type { DispatchRequest, IssueSummary, Project } from '#lib/types.js';
import type { Todo } from '../todos/store.js';
import {
	CrewToolError,
	defineTool,
	truncateText,
	type CrewContext,
	type CrewDeps,
	type CrewTool
} from './registry.js';

/** A project id from `list_projects` (`d_…`) or its database name. */
const project_ref_schema = z
	.string()
	.regex(/^[A-Za-z0-9_-]{1,80}$/, 'invalid project')
	.describe('Project id from list_projects (d_…) or its database name.');

/** Shown when a list hit its limit, so the model knows to narrow or page. */
const MORE_NOTE = 'Limit reached; there may be more. Narrow the filters or raise limit.';
/** Short excerpts in lists; `show_*` tools return the long text. */
const EXCERPT_CHARS = 300;
const SHOW_COMMENTS = 10;
const SHOW_EVENTS = 10;
const SHOW_TURNS = 6;

function allProjects(deps: CrewDeps, force = false): Promise<Project[]> {
	return (deps.projects ?? discoverProjects)({ force });
}

/**
 * Resolve the project a call names, or the chat's project when it names none.
 * Unknown names refresh discovery once, as `resolveProject` does for the UI.
 */
export async function resolveCrewProject(
	ctx: CrewContext,
	deps: CrewDeps,
	ref: string | undefined
): Promise<Project> {
	const wanted = ref ?? ctx.scope ?? undefined;
	if (wanted === undefined) {
		throw new CrewToolError('Name a project: pass project, an id from list_projects.');
	}
	const match = (projects: Project[]) =>
		projects.find((project) => project.id === wanted || project.name === wanted);
	const found = match(await allProjects(deps)) ?? match(await allProjects(deps, true));
	if (found === undefined) {
		throw new CrewToolError(`No project "${wanted}". Call list_projects for the ids.`);
	}
	return found;
}

function compactIssue(issue: IssueSummary) {
	return {
		id: issue.id,
		title: issue.title,
		status: issue.status,
		priority: issue.priority,
		type: issue.issue_type,
		assignee: issue.assignee,
		labels: issue.labels.length > 0 ? issue.labels : undefined,
		updated_at: issue.updated_at
	};
}

/** `Mission` from lists; a project's dispatch (no name or title) from show_mission. */
export function compactMission(
	mission: DispatchRequest & { project_name?: string; title?: string }
) {
	return {
		id: mission.id,
		project_id: mission.project_id,
		project_name: mission.project_name,
		operation: mission.operation,
		intent: mission.intent,
		status: mission.status,
		issue_id: mission.issue_id,
		title: mission.title,
		pr_url: mission.git_pr_url,
		result: mission.result_summary && truncateText(mission.result_summary, EXCERPT_CHARS),
		error: mission.error_message,
		created_at: mission.created_at,
		updated_at: mission.updated_at
	};
}

export function compactTodo(todo: Todo) {
	return {
		id: todo.id,
		title: todo.title,
		body: todo.body === null ? undefined : truncateText(todo.body, EXCERPT_CHARS),
		priority: todo.priority,
		due_at: todo.due_at ?? undefined,
		tags: todo.tags.length > 0 ? todo.tags : undefined,
		status: todo.status,
		routed_project_id: todo.routed_project_id ?? undefined,
		routed_issue_id: todo.routed_issue_id ?? undefined,
		routed_mission_id: todo.routed_dispatch_id ?? undefined,
		comment_count: todo.comment_count,
		updated_at: todo.updated_at
	};
}

function listResult<T>(items: T[], limit: number) {
	return items.length >= limit ? { note: MORE_NOTE } : {};
}

export const list_projects = defineTool({
	name: 'list_projects',
	description:
		'List the Beads projects Beadsmith can see, with issue counts and last activity. ' +
		'Other tools take a project id from here.',
	input: z.strictObject({}),
	async handler(_ctx, _input, deps) {
		const projects = await allProjects(deps);
		return {
			projects: projects.map((project) => ({
				id: project.id,
				name: project.name,
				counts: project.counts,
				last_activity: project.last_activity
			}))
		};
	}
});

export const ready_work = defineTool({
	name: 'ready_work',
	description:
		'Ready issues (open, not blocked, not in progress), highest priority first. ' +
		'Omit project for every project.',
	input: z.strictObject({
		project: project_ref_schema.optional(),
		limit: z.number().int().min(1).max(50).default(20)
	}),
	async handler(ctx, input, deps) {
		if (input.project !== undefined) {
			const project = await resolveCrewProject(ctx, deps, input.project);
			const issues = await getProjectReadyIssues(project, input.limit, deps.read);
			return {
				project: { id: project.id, name: project.name },
				issues: issues.map(compactIssue),
				...listResult(issues, input.limit)
			};
		}
		const { issues } = await getMergedReadyIssues(await allProjects(deps), input.limit, deps.read);
		return {
			issues: issues.map((issue) => ({ project_id: issue.project_id, ...compactIssue(issue) })),
			...listResult(issues, input.limit)
		};
	}
});

export const list_issues = defineTool({
	name: 'list_issues',
	description:
		"Search one project's issues. Closed issues are left out unless status names them " +
		'or include_closed is true. Omit project to use the chat’s project.',
	input: z.strictObject({
		project: project_ref_schema.optional(),
		status: z
			.string()
			.max(200)
			.optional()
			.describe('Comma-separated statuses, e.g. "open,in_progress".'),
		assignee: z.string().min(1).max(200).optional().describe('Exact assignee.'),
		label: label_schema.optional().describe('Exact label.'),
		text: z.string().min(1).max(200).optional().describe('Substring of id, title or label.'),
		include_closed: z.boolean().default(false),
		limit: z.number().int().min(1).max(100).default(50)
	}),
	async handler(ctx, input, deps) {
		const project = await resolveCrewProject(ctx, deps, input.project);
		const { issues } = await listProjectIssues(
			project,
			{
				limit: input.limit,
				include_closed: input.include_closed,
				status: input.status,
				assignee: input.assignee,
				label: input.label,
				q: input.text
			},
			deps.read
		);
		return {
			project: { id: project.id, name: project.name },
			issues: issues.map(compactIssue),
			...listResult(issues, input.limit)
		};
	}
});

export const show_issue = defineTool({
	name: 'show_issue',
	description:
		'One issue in full: description, acceptance criteria, notes, dependencies, ' +
		'dependents, recent comments and recent events. Omit project to use the chat’s project.',
	input: z.strictObject({
		project: project_ref_schema.optional(),
		issue_id: issue_id_schema
	}),
	async handler(ctx, input, deps) {
		const project = await resolveCrewProject(ctx, deps, input.project);
		const [detail, events] = await Promise.all([
			getProjectIssue(project, input.issue_id, deps.read),
			getIssueEvents(project, input.issue_id, SHOW_EVENTS, deps.read)
		]);
		if (detail === undefined) {
			throw new CrewToolError(`No issue ${input.issue_id} in ${project.name}.`);
		}
		const { issue } = detail;
		return {
			project: { id: project.id, name: project.name },
			issue: {
				...compactIssue(issue),
				owner: issue.owner,
				created_by: issue.created_by,
				created_at: issue.created_at,
				due_at: issue.due_at,
				defer_until: issue.defer_until,
				external_ref: issue.external_ref,
				description: issue.description,
				acceptance_criteria: issue.acceptance_criteria,
				notes: issue.notes,
				design: issue.design
			},
			dependencies: issue.dependencies,
			dependents: issue.dependents,
			comment_count: issue.comments.length,
			recent_comments: issue.comments.slice(-SHOW_COMMENTS),
			recent_events: events.map((event) => ({
				event_type: event.event_type,
				actor: event.actor,
				created_at: event.created_at
			}))
		};
	}
});

export const list_missions = defineTool({
	name: 'list_missions',
	description:
		'Recent agent missions (File, Tackle, comment, discuss), newest first, with status ' +
		'and pull request link. Omit project for every project.',
	input: z.strictObject({
		project: project_ref_schema.optional(),
		issue_id: issue_id_schema.optional(),
		limit: z.number().int().min(1).max(50).default(20)
	}),
	async handler(ctx, input, deps) {
		const project =
			input.project === undefined ? undefined : await resolveCrewProject(ctx, deps, input.project);
		let names = new Map<string, string>();
		try {
			names = new Map((await allProjects(deps)).map((p) => [p.id, p.name]));
		} catch {
			/* Missions live in SQLite; a Dolt outage must not hide them (as /api/missions). */
		}
		const missions = await listMissions(
			{ project_id: project?.id, issue_id: input.issue_id, limit: input.limit },
			{ store: deps.dispatch?.store, project_names: names }
		);
		return { missions: missions.map(compactMission), ...listResult(missions, input.limit) };
	}
});

export const show_mission = defineTool({
	name: 'show_mission',
	description:
		"One mission's current status, pull request, outcome and its latest conversation " +
		'turns. Omit project to use the chat’s project.',
	input: z.strictObject({
		project: project_ref_schema.optional(),
		mission_id: dispatch_request_id_schema.describe('Mission id from list_missions (dq_…).')
	}),
	async handler(ctx, input, deps) {
		const project = await resolveCrewProject(ctx, deps, input.project);
		const mission = await getDispatch(project.id, input.mission_id, deps.dispatch);
		if (mission === undefined) {
			throw new CrewToolError(`No mission ${input.mission_id} in ${project.name}.`);
		}
		const turns =
			(await listDispatchTurns(project.id, input.mission_id, { store: deps.dispatch?.store })) ??
			[];
		return {
			mission: {
				...compactMission({ ...mission, project_name: project.name }),
				result: mission.result_summary,
				agent_url: mission.agent_url,
				duration_ms: mission.duration_ms
			},
			turn_count: turns.length,
			recent_turns: turns.slice(-SHOW_TURNS).map((turn) => ({
				role: turn.role,
				status: turn.status,
				text: turn.text,
				created_at: turn.created_at
			}))
		};
	}
});

export const list_todos = defineTool({
	name: 'list_todos',
	description:
		"The owner's todo list in manual order, with routing (project, issue, mission) " +
		'when a todo has been routed.',
	input: z.strictObject({
		status: z.enum(['open', 'done', 'archived', 'all']).default('open'),
		tag: todo_tag_schema.optional(),
		text: z.string().min(1).max(200).optional().describe('Substring of title or body.'),
		limit: z.number().int().min(1).max(200).default(50)
	}),
	// `/api/todos` is admin-only for reads too (roles.ts).
	permission: { console: ['manage'] },
	async handler(_ctx, input, deps) {
		const store = await (deps.todos ?? getTodoStore)();
		const todos = await store.list({
			status: input.status === 'all' ? undefined : input.status,
			tag: input.tag,
			q: input.text,
			limit: input.limit
		});
		return { todos: todos.map(compactTodo), ...listResult(todos, input.limit) };
	}
});

export const READ_TOOLS: CrewTool[] = [
	list_projects,
	ready_work,
	list_issues,
	show_issue,
	list_missions,
	show_mission,
	list_todos
];
