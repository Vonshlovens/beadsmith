/**
 * Crew automation tools (ADR-0025 rule 10, ADR-0019 rule 7): First Mate
 * proposes a scheduled launch and lists the automations there are. A
 * proposal goes through `createAutomation`, the function `POST
 * /api/automations` uses, so the schedule, project, bead and model are
 * checked the same way, and it is saved for the chat's owner.
 *
 * - **Always paused.** The automation store saves an automation that names
 *   its proposing chat paused, so nothing First Mate writes ever fires until
 *   a person resumes it on /automations. There is deliberately no tool to
 *   resume, edit, run or delete one: a chat that may have read a
 *   prompt-injected issue must not be able to start a schedule.
 * - **Dispatch policy applies at each fire**, as for every automation: the
 *   scheduler launches through `enqueueDispatch`, so the global arm, the
 *   project's allow list and the repository map refuse a fire exactly as
 *   they refuse a click.
 */
import { z } from 'zod';
import type { AutomationView } from '#lib/automations.js';
import type { Permission } from '../auth/roles.js';
import { automationView, createAutomation } from '../automations/service.js';
import type { AutomationStore } from '../automations/store.js';
import { getProjectIssue } from '../read-model.js';
import { getAutomationStore } from '../state/db.js';
import { automation_create_schema } from '../validation.js';
import { allProjects, resolveCrewProject } from './read-tools.js';
import { CrewToolError, defineTool, type CrewDeps, type CrewTool } from './registry.js';

/** `POST /api/automations` needs `dispatch:launch` (roles.ts). */
const AUTOMATION_WRITE_PERMISSION: Permission = { dispatch: ['launch'] };

/** The browser's create fields, so a proposal is validated exactly as a click is. */
const create = automation_create_schema.shape;

function automationStore(deps: CrewDeps): Promise<AutomationStore> {
	return (deps.automations ?? getAutomationStore)();
}

/** The automation's page, which a proposal returns so the owner can resume it. */
export function automationUrl(id: string): string {
	return `/automations/${id}`;
}

function compactAutomation(view: AutomationView) {
	return {
		id: view.id,
		name: view.name,
		project: { id: view.project_id, name: view.project_name },
		cron: view.cron,
		time_zone: view.time_zone,
		launch: view.launch,
		overlap: view.overlap,
		enabled: view.enabled,
		...(view.proposed_by_first_mate ? { proposed_by_first_mate: true } : {}),
		...(view.paused_reason === undefined ? {} : { paused_reason: view.paused_reason }),
		...(view.next_run === undefined ? {} : { next_run: view.next_run }),
		...(view.last_run === undefined
			? {}
			: { last_run: { slot: view.last_run.slot, outcome: view.last_run.outcome } }),
		url: automationUrl(view.id)
	};
}

export const define_automation = defineTool({
	name: 'define_automation',
	description:
		'Propose an automation: a mission launch on a cron schedule (five fields, e.g. ' +
		'"0 2 * * 1-5" for 02:00 on weekdays) in an IANA time zone. It is created PAUSED and ' +
		'never fires until the owner resumes it on its page; you cannot resume, edit or run ' +
		'it. When it fires, dispatch’s arm switch, the project’s allow list and its repository ' +
		'map apply as for any launch. launch is a launch’s fields: {operation: "file", notes} | ' +
		'{operation: "tackle" | "comment" | "discuss", issue_id, …} | {operation: "loop", mode, ' +
		'max_iterations, …}. Returns the automation and its URL; give the owner the link.',
	input: z.strictObject({
		project: z
			.string()
			.regex(/^[A-Za-z0-9_-]{1,80}$/, 'invalid project')
			.optional()
			.describe(
				'Project id from list_projects (d_…) or its database name. Omit for the chat’s project.'
			),
		name: create.name,
		cron: create.cron,
		time_zone: create.time_zone.describe('IANA zone, like Europe/London.'),
		overlap: create.overlap.describe(
			'When a run falls due while the last mission still works: skip it, or queue one.'
		),
		launch: create.launch
	}),
	permission: AUTOMATION_WRITE_PERMISSION,
	async handler(ctx, input, deps) {
		const project = await resolveCrewProject(ctx, deps, input.project);
		const store = await automationStore(deps);
		const result = await createAutomation(
			{
				project_id: project.id,
				name: input.name,
				cron: input.cron,
				time_zone: input.time_zone,
				overlap: input.overlap,
				launch: input.launch
			},
			{ id: ctx.account_id, email: ctx.actor, proposed_chat_id: ctx.chat_id },
			{
				store,
				resolveProject: async (id) => (id === project.id ? project : undefined),
				getIssue: async (found, issue_id) =>
					(await getProjectIssue(found, issue_id, deps.read))?.issue,
				now: () => new Date()
			}
		);
		if (!result.ok) throw new CrewToolError(`${result.message} (${project.name}).`);
		return {
			proposed: true,
			note: 'Created paused. It fires nothing until the owner resumes it at the URL.',
			automation: compactAutomation(
				automationView(result.automation, { project_name: project.name, now: new Date() })
			)
		};
	}
});

export const list_automations = defineTool({
	name: 'list_automations',
	description:
		'List automations (scheduled launches), optionally for one project: schedule, what ' +
		'they launch, whether they are paused, whether First Mate proposed them, the next and ' +
		'last run, and each page URL.',
	input: z.strictObject({
		project: z
			.string()
			.regex(/^[A-Za-z0-9_-]{1,80}$/, 'invalid project')
			.optional()
			.describe('Project id or database name. Omit for every project.')
	}),
	async handler(ctx, input, deps) {
		const project =
			input.project === undefined ? undefined : await resolveCrewProject(ctx, deps, input.project);
		const store = await automationStore(deps);
		const names = new Map((await allProjects(deps)).map((p) => [p.id, p.name]));
		const now = new Date();
		const automations = await store.list(project === undefined ? {} : { project_id: project.id });
		return {
			automations: await Promise.all(
				automations.map(async (automation) => {
					const [last_run] = await store.listRuns(automation.id, 1);
					return compactAutomation(
						automationView(automation, {
							project_name: names.get(automation.project_id),
							...(last_run === undefined ? {} : { last_run }),
							now
						})
					);
				})
			)
		};
	}
});

export const AUTOMATION_TOOLS: CrewTool[] = [define_automation, list_automations];
