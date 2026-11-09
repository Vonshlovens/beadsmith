/**
 * Crew write tools (ADR-0020 rules 3 to 6). Todos are app-owned rows, so the
 * todo tools change them directly. Beads is never written here: filing,
 * commenting, tackling and discussing each start a mission through
 * `enqueueDispatch`, the same function, policy (arm, allow list, repository
 * mapping) and durable queue `POST /api/projects/:id/dispatch` uses, as the
 * chat's owner and on the default provider. There are no delete tools.
 *
 * Every launching tool:
 * - keys the mission on the chat and the tool call (`launchKey`), so a
 *   retried call replays the first mission instead of starting another;
 * - records the chat on the mission, so its outcome can be reported back;
 * - takes a slot from the per-chat launch limiter, given back on a replay or
 *   a refusal;
 * - names the operation, project, issue and mission in its result.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DispatchRequest, IssueDetail, Project } from '#lib/types.js';
import type { Permission } from '../auth/roles.js';
import {
	cancelDispatch,
	enqueueDispatch,
	followUpDispatch,
	type EnqueueDispatchInput
} from '../dispatch/service.js';
import { getProjectIssue } from '../read-model.js';
import { getTodoStore } from '../state/db.js';
import { routeTodo } from '../todos/route.js';
import type { TodoStore } from '../todos/store.js';
import {
	dispatch_request_id_schema,
	FOLLOW_UP_TEXT_MAX,
	issue_id_schema,
	label_schema,
	todo_due_schema,
	todo_id_schema,
	todo_priority_schema,
	todo_tags_schema
} from '../validation.js';
import { getLaunchLimiter } from './launch-limit.js';
import { compactMission, compactTodo, resolveCrewProject } from './read-tools.js';
import {
	CrewToolError,
	defineTool,
	type CrewCall,
	type CrewContext,
	type CrewDeps,
	type CrewTool
} from './registry.js';

/** `/api/todos` is admin-only (roles.ts). */
const TODO_PERMISSION: Permission = { console: ['manage'] };
/** `/api/projects/:id/dispatch` needs `dispatch:launch` (roles.ts). */
const DISPATCH_PERMISSION: Permission = { dispatch: ['launch'] };

const project_ref_schema = z
	.string()
	.regex(/^[A-Za-z0-9_-]{1,80}$/, 'invalid project')
	.describe(
		'Project id from list_projects (d_…) or its database name. Omit for the chat’s project.'
	);

const mission_id_schema = dispatch_request_id_schema.describe('Mission id (dq_…).');

function todoStore(deps: CrewDeps): Promise<TodoStore> {
	return (deps.todos ?? getTodoStore)();
}

/**
 * Idempotency key for a mission a tool call starts. Hashed because the call
 * id is client text; the chat is part of it so two chats can never collide.
 * @param ctx Caller.
 * @param tool Tool name.
 * @param call The call.
 */
export function launchKey(ctx: CrewContext, tool: string, call: CrewCall): string {
	const digest = createHash('sha256')
		.update(`${ctx.chat_id}\0${tool}\0${call.id}`)
		.digest('hex')
		.slice(0, 40);
	return `crew:${digest}`;
}

/** Minutes, rounded up, for the limit message. */
function minutes(ms: number): number {
	return Math.max(1, Math.ceil(ms / 60_000));
}

/**
 * Run one launch under the chat's limit. A replay (`created: false`) or a
 * refusal gives the slot back, so only missions that really started count.
 */
async function underLimit<T extends { created: boolean }>(
	ctx: CrewContext,
	deps: CrewDeps,
	run: () => Promise<T>
): Promise<T> {
	const limiter = deps.launch_limiter ?? getLaunchLimiter();
	const taken = limiter.acquire(ctx.chat_id);
	if (!taken.ok) {
		throw new CrewToolError(
			`Launch limit reached: this chat may start ${limiter.count} missions per ` +
				`${minutes(limiter.window_ms)} minutes. Try again in about ` +
				`${minutes(taken.retry_after_ms)} minutes, or ask the owner to start it from Beadsmith.`
		);
	}
	try {
		const result = await run();
		if (!result.created) taken.slot.release();
		return result;
	} catch (error) {
		taken.slot.release();
		throw error;
	}
}

/** What a launching tool returns: enough for the model to tell the owner exactly what started. */
function launchResult(
	project: Project,
	request: DispatchRequest,
	created: boolean,
	extra: Record<string, unknown> = {}
) {
	return {
		launched: created,
		...(created
			? {}
			: { note: 'This call was already handled; this is the mission it started, not a new one.' }),
		operation: request.operation,
		project: { id: project.id, name: project.name },
		issue_id: request.issue_id,
		mission_id: request.id,
		mission: compactMission({ ...request, project_name: project.name }),
		...extra
	};
}

async function requireIssue(
	project: Project,
	issue_id: string,
	deps: CrewDeps
): Promise<IssueDetail> {
	const detail = await getProjectIssue(project, issue_id, deps.read);
	if (detail === undefined) {
		throw new CrewToolError(`No issue ${issue_id} in ${project.name}.`);
	}
	return detail.issue;
}

/** Launch one mission as the owner, keyed on this call and stamped with the chat. */
async function launch(
	ctx: CrewContext,
	deps: CrewDeps,
	call: CrewCall,
	tool: string,
	input: Omit<EnqueueDispatchInput, 'idempotency_key' | 'actor' | 'chat_id' | 'provider'>
) {
	const result = await underLimit(ctx, deps, () =>
		enqueueDispatch(
			{
				...input,
				idempotency_key: launchKey(ctx, tool, call),
				actor: ctx.actor,
				chat_id: ctx.chat_id
			},
			deps.dispatch
		)
	);
	return launchResult(input.project, result.request, result.created);
}

// --- Todos ---------------------------------------------------

export const create_todo = defineTool({
	name: 'create_todo',
	description:
		"Add a todo to the owner's list. Tags like +project or @context become Beads labels " +
		'if the todo is later routed.',
	input: z.strictObject({
		title: z.string().trim().min(1).max(300),
		body: z.string().max(20_000).optional(),
		priority: todo_priority_schema.optional().describe('0 (highest) to 4. Default 2.'),
		due_at: todo_due_schema.optional().describe('ISO date or datetime.'),
		tags: todo_tags_schema.optional()
	}),
	permission: TODO_PERMISSION,
	async handler(ctx, input, deps) {
		const store = await todoStore(deps);
		const todo = await store.create({ ...input, created_by: ctx.account_id });
		return { todo: compactTodo(todo) };
	}
});

export const update_todo = defineTool({
	name: 'update_todo',
	description:
		'Change a todo: title, body, priority, due date, tags or status. null clears body or ' +
		'due_at; status archived hides it (there is no delete).',
	input: z.strictObject({
		todo_id: todo_id_schema,
		title: z.string().trim().min(1).max(300).optional(),
		body: z.string().max(20_000).nullable().optional(),
		priority: todo_priority_schema.optional(),
		due_at: todo_due_schema.nullable().optional(),
		tags: todo_tags_schema.optional(),
		status: z.enum(['open', 'done', 'archived']).optional()
	}),
	permission: TODO_PERMISSION,
	async handler(_ctx, { todo_id, ...patch }, deps) {
		if (Object.keys(patch).length === 0) {
			throw new CrewToolError('Nothing to change: pass at least one field besides todo_id.');
		}
		const todo = await (await todoStore(deps)).update(todo_id, patch);
		if (todo === undefined) throw new CrewToolError(`No todo ${todo_id}.`);
		return { todo: compactTodo(todo) };
	}
});

export const complete_todo = defineTool({
	name: 'complete_todo',
	description: 'Mark a todo done.',
	input: z.strictObject({ todo_id: todo_id_schema }),
	permission: TODO_PERMISSION,
	async handler(_ctx, input, deps) {
		const todo = await (await todoStore(deps)).update(input.todo_id, { status: 'done' });
		if (todo === undefined) throw new CrewToolError(`No todo ${input.todo_id}.`);
		return { todo: compactTodo(todo) };
	}
});

export const route_todo = defineTool({
	name: 'route_todo',
	description:
		'File a todo as a Beads issue in a project: starts a File mission from the todo’s ' +
		'title, body, comments and tags, and links the todo to it. Routing a todo again while ' +
		'its mission is alive returns that mission.',
	input: z.strictObject({
		todo_id: todo_id_schema,
		project: project_ref_schema.optional(),
		note: z.string().trim().max(2000).optional().describe('Extra context for the filing agent.')
	}),
	// The todo route needs console:manage; the launch is a dispatch too.
	permission: TODO_PERMISSION,
	async handler(ctx, input, deps) {
		const project = await resolveCrewProject(ctx, deps, input.project);
		const store = await todoStore(deps);
		// routeTodo keys the mission on the todo (and its last failed attempt),
		// which already makes a retried call a replay.
		const result = await underLimit(ctx, deps, async () => {
			const routed = await routeTodo(
				store,
				{
					todo_id: input.todo_id,
					project,
					actor: ctx.actor,
					note: input.note,
					chat_id: ctx.chat_id
				},
				deps.dispatch
			);
			if (routed.kind === 'missing') throw new CrewToolError(`No todo ${input.todo_id}.`);
			return routed;
		});
		if (result.request === undefined) {
			throw new CrewToolError(`Todo ${input.todo_id} is routed, but its mission is gone.`);
		}
		// A replay returns the todo's existing mission, which may live in another
		// project than the one asked for: name the mission's own project, or a
		// follow-up or cancel aimed at the requested one would miss it.
		const mission_project =
			result.request.project_id === project.id
				? project
				: await resolveCrewProject(ctx, deps, result.request.project_id);
		return launchResult(mission_project, result.request, result.created, {
			todo: compactTodo(result.todo)
		});
	}
});

// --- Missions (Beads changes are delegated) ------------------

export const file_issue = defineTool({
	name: 'file_issue',
	description:
		'Start a File mission: an agent researches the project and creates one Beads issue ' +
		'from these notes. Returns the mission; the issue id arrives when it finishes.',
	input: z.strictObject({
		project: project_ref_schema.optional(),
		notes: z
			.string()
			.trim()
			.min(1)
			.max(8000)
			.describe('What the issue is about, with any context the filer needs.'),
		title: z.string().trim().min(1).max(200).optional(),
		issue_type: z.enum(['bug', 'feature', 'task', 'epic', 'chore']).optional(),
		priority: z.number().int().min(0).max(4).optional(),
		labels: z.array(label_schema).max(8).optional()
	}),
	permission: DISPATCH_PERMISSION,
	async handler(ctx, input, deps, call) {
		const project = await resolveCrewProject(ctx, deps, input.project);
		return launch(ctx, deps, call, 'file_issue', {
			project,
			payload: {
				operation: 'file',
				notes: input.notes,
				title: input.title,
				issue_type: input.issue_type,
				priority: input.priority,
				labels: input.labels
			}
		});
	}
});

export const comment_issue = defineTool({
	name: 'comment_issue',
	description:
		'Start a comment mission: an agent adds this comment to the issue with bd, as the owner.',
	input: z.strictObject({
		project: project_ref_schema.optional(),
		issue_id: issue_id_schema,
		text: z.string().trim().min(1).max(8000)
	}),
	permission: DISPATCH_PERMISSION,
	async handler(ctx, input, deps, call) {
		const project = await resolveCrewProject(ctx, deps, input.project);
		const issue = await requireIssue(project, input.issue_id, deps);
		return launch(ctx, deps, call, 'comment_issue', {
			project,
			issue,
			payload: {
				operation: 'comment',
				issue_id: input.issue_id,
				text: input.text,
				author: ctx.actor
			}
		});
	}
});

export const tackle_issue = defineTool({
	name: 'tackle_issue',
	description:
		'Start a Tackle mission: a repo worker implements the issue in the project’s mapped ' +
		'repository and, if the project is set to, opens a pull request. Refused when the ' +
		'project has no repository mapping or Tackle is not allowed.',
	input: z.strictObject({
		project: project_ref_schema.optional(),
		issue_id: issue_id_schema
	}),
	permission: DISPATCH_PERMISSION,
	async handler(ctx, input, deps, call) {
		const project = await resolveCrewProject(ctx, deps, input.project);
		const issue = await requireIssue(project, input.issue_id, deps);
		return launch(ctx, deps, call, 'tackle_issue', {
			project,
			issue,
			payload: { operation: 'tackle', issue_id: input.issue_id }
		});
	}
});

export const discuss_issue = defineTool({
	name: 'discuss_issue',
	description:
		'Start a discuss mission on an issue: discuss (answer or ask about it), elaborate ' +
		'(flesh out the description and acceptance criteria) or close (close it if it is done). ' +
		'The agent makes any Beads change with bd.',
	input: z.strictObject({
		project: project_ref_schema.optional(),
		issue_id: issue_id_schema,
		intent: z.enum(['discuss', 'elaborate', 'close']).default('discuss'),
		message: z.string().trim().min(1).max(FOLLOW_UP_TEXT_MAX).optional()
	}),
	permission: DISPATCH_PERMISSION,
	async handler(ctx, input, deps, call) {
		const project = await resolveCrewProject(ctx, deps, input.project);
		const issue = await requireIssue(project, input.issue_id, deps);
		return launch(ctx, deps, call, 'discuss_issue', {
			project,
			issue,
			payload: {
				operation: 'discuss',
				issue_id: input.issue_id,
				intent: input.intent,
				...(input.message === undefined ? {} : { message: input.message })
			}
		});
	}
});

export const follow_up_mission = defineTool({
	name: 'follow_up_mission',
	description:
		'Send a follow-up message to a finished mission’s agent, which starts a new run on ' +
		'the same agent. Refused while the agent is still working.',
	input: z.strictObject({
		project: project_ref_schema.optional(),
		mission_id: mission_id_schema,
		text: z.string().trim().min(1).max(FOLLOW_UP_TEXT_MAX)
	}),
	permission: DISPATCH_PERMISSION,
	async handler(ctx, input, deps) {
		const project = await resolveCrewProject(ctx, deps, input.project);
		// A retried follow-up finds the agent busy with the first one and is
		// refused, so it cannot start a second run.
		const result = await underLimit(ctx, deps, async () => {
			const request = await followUpDispatch(
				project.id,
				input.mission_id,
				input.text,
				deps.dispatch
			);
			if (request === undefined) {
				throw new CrewToolError(`No mission ${input.mission_id} in ${project.name}.`);
			}
			return { request, created: true };
		});
		return launchResult(project, result.request, true);
	}
});

export const cancel_mission = defineTool({
	name: 'cancel_mission',
	description:
		'Stop a running mission’s agent. Cancelling a finished mission changes nothing. ' +
		'Changes the agent already made stay.',
	input: z.strictObject({
		project: project_ref_schema.optional(),
		mission_id: mission_id_schema
	}),
	permission: DISPATCH_PERMISSION,
	async handler(ctx, input, deps) {
		const project = await resolveCrewProject(ctx, deps, input.project);
		const request = await cancelDispatch(project.id, input.mission_id, deps.dispatch);
		if (request === undefined) {
			throw new CrewToolError(`No mission ${input.mission_id} in ${project.name}.`);
		}
		return {
			operation: request.operation,
			project: { id: project.id, name: project.name },
			issue_id: request.issue_id,
			mission_id: request.id,
			mission: compactMission({ ...request, project_name: project.name })
		};
	}
});

export const WRITE_TOOLS: CrewTool[] = [
	create_todo,
	update_todo,
	complete_todo,
	route_todo,
	file_issue,
	comment_issue,
	tackle_issue,
	discuss_issue,
	follow_up_mission,
	cancel_mission
];
