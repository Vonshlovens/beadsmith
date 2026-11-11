/**
 * What the Automations API does with the store (ADR-0019 rule 7): check a
 * schedule before it is saved, create one from a validated launch, and shape
 * automations and their runs for the browser. Routes stay thin; the
 * scheduler (`scheduler.ts`) does the firing.
 */
import {
	AUTOMATION_PREVIEW_COUNT,
	type AutomationOverlap,
	type AutomationRunView,
	type AutomationView
} from '#lib/automations.js';
import type { DispatchProviderId, IssueDetail, Project } from '#lib/types.js';
import type { DispatchPayload } from '../dispatch/types.js';
import {
	agentChoiceProblem,
	configuredAgentChoices,
	type AgentChoices
} from '../dispatch/agent-choice.js';
import { launchPayload, payloadIssueId } from '../dispatch/payload.js';
import { publicLoop } from '../dispatch/service.js';
import type { AutomationEditBody, LaunchBody } from '../validation.js';
import { CronError, isTimeZone, nextSlot, parseCron, upcomingSlots } from './cron.js';
import type { Automation, AutomationRun, AutomationStore } from './store.js';

export const UNKNOWN_TIME_ZONE_MESSAGE =
	'Unknown time zone. Use an IANA name such as Europe/London.';
export const NEVER_FIRES_MESSAGE = 'This schedule has no fire time in the next five years.';

export type ScheduleCheck = { ok: true; upcoming: Date[] } | { ok: false; message: string };

/**
 * Whether a schedule can be saved, with its next fire times. A schedule
 * with no slot in five years (`0 0 30 2 *`) is refused: the ticker would
 * search five years for it every minute and never fire it.
 */
export function checkSchedule(cron: string, time_zone: string, now: Date): ScheduleCheck {
	let schedule;
	try {
		schedule = parseCron(cron);
	} catch (error) {
		if (error instanceof CronError) return { ok: false, message: error.message };
		throw error;
	}
	if (!isTimeZone(time_zone)) return { ok: false, message: UNKNOWN_TIME_ZONE_MESSAGE };
	if (nextSlot(schedule, time_zone, now) === undefined) {
		return { ok: false, message: NEVER_FIRES_MESSAGE };
	}
	return { ok: true, upcoming: upcomingSlots(schedule, time_zone, now, AUTOMATION_PREVIEW_COUNT) };
}

/** The next fire times of a saved automation; none while it is paused. */
export function automationUpcoming(automation: Automation, now: Date, count: number): string[] {
	if (!automation.enabled) return [];
	try {
		return upcomingSlots(parseCron(automation.cron), automation.time_zone, now, count).map((slot) =>
			slot.toISOString()
		);
	} catch (error) {
		// Validated when saved; a stored schedule this build cannot read has no next run.
		if (error instanceof CronError) return [];
		throw error;
	}
}

export function automationRunView(run: AutomationRun): AutomationRunView {
	return {
		slot: run.slot,
		trigger: run.trigger,
		outcome: run.outcome,
		...(run.mission_id === undefined ? {} : { mission_id: run.mission_id }),
		...(run.message === undefined ? {} : { message: run.message }),
		updated_at: run.updated_at
	};
}

/**
 * The browser's view: the launch's shape and flags, never its text (File
 * notes, a comment, a `run` prompt) or its creator's account id.
 */
export function automationView(
	automation: Automation,
	context: { project_name?: string; last_run?: AutomationRun; now: Date }
): AutomationView {
	const { payload } = automation;
	const issue_id = payloadIssueId(payload);
	const loop = publicLoop(payload);
	const next_run = automationUpcoming(automation, context.now, 1)[0];
	return {
		id: automation.id,
		project_id: automation.project_id,
		project_name: context.project_name ?? automation.project_id,
		name: automation.name,
		cron: automation.cron,
		time_zone: automation.time_zone,
		...(automation.provider === undefined ? {} : { provider: automation.provider }),
		launch: {
			operation: payload.operation,
			...(issue_id === undefined ? {} : { issue_id }),
			...(loop === undefined ? {} : { loop })
		},
		overlap: automation.overlap,
		enabled: automation.enabled,
		...(automation.paused_reason === undefined ? {} : { paused_reason: automation.paused_reason }),
		...(next_run === undefined ? {} : { next_run }),
		...(context.last_run === undefined ? {} : { last_run: automationRunView(context.last_run) }),
		created_at: automation.created_at,
		updated_at: automation.updated_at
	};
}

export interface CreateAutomationRequest {
	project_id: string;
	name: string;
	cron: string;
	time_zone: string;
	overlap: AutomationOverlap;
	provider?: DispatchProviderId;
	launch: LaunchBody;
}

export interface CreateAutomationDeps {
	store: Pick<AutomationStore, 'create'>;
	resolveProject(id: string): Promise<Project | undefined>;
	getIssue(project: Project, issue_id: string): Promise<IssueDetail | undefined>;
	now(): Date;
	/** The operator's models and efforts; the server environment's by default. */
	agent_choices?: AgentChoices;
}

export type CreateAutomationResult =
	| { ok: true; automation: Automation; project: Project }
	| { ok: false; code: 'bad_request' | 'not_found'; message: string };

/**
 * Save an automation for `creator`, an admin's account. The schedule, the
 * project, the bead and the model and effort are checked now so a typo is
 * refused at once rather than recorded as a failed run every night; dispatch
 * policy (armed, the project's allow, the runner) is checked at each fire, as
 * for a launch, and so is the model and effort again, since the operator can
 * withdraw one after the automation is saved.
 */
export async function createAutomation(
	input: CreateAutomationRequest,
	creator: { id: string; email: string },
	deps: CreateAutomationDeps
): Promise<CreateAutomationResult> {
	const schedule = checkSchedule(input.cron, input.time_zone, deps.now());
	if (!schedule.ok) return { ok: false, code: 'bad_request', message: schedule.message };

	const choice = agentChoiceProblem(input.launch, deps.agent_choices ?? configuredAgentChoices());
	if (choice !== undefined) return { ok: false, code: 'bad_request', message: choice };

	const project = await deps.resolveProject(input.project_id);
	if (project === undefined) return { ok: false, code: 'not_found', message: 'project not found' };

	// The comment author is replaced with the automation actor at each fire.
	const payload = launchPayload(input.launch, creator.email);
	const issue_id = payloadIssueId(payload);
	if (issue_id !== undefined && (await deps.getIssue(project, issue_id)) === undefined) {
		return { ok: false, code: 'not_found', message: 'issue not found' };
	}

	const automation = await deps.store.create({
		project_id: project.id,
		name: input.name,
		cron: input.cron,
		time_zone: input.time_zone,
		...(input.provider === undefined ? {} : { provider: input.provider }),
		payload,
		overlap: input.overlap,
		created_by: creator.id
	});
	return { ok: true, automation, project };
}

export const NOT_A_LOOP_MESSAGE = 'Only a loop automation has an agent CLI and an iteration limit.';

export type EditAutomationResult =
	| { ok: true; automation: Automation }
	| { ok: false; code: 'bad_request' | 'not_found'; message: string };

/**
 * Edit a saved automation in place, so its history stays. The schedule is
 * checked as when it was created; the bead and the model and effort are
 * unchanged and checked again at each fire. The store moves the cursor to
 * now, so the edit itself never fires a slot.
 */
export async function editAutomation(
	id: string,
	input: AutomationEditBody,
	deps: { store: Pick<AutomationStore, 'get' | 'update'>; now(): Date }
): Promise<EditAutomationResult> {
	const automation = await deps.store.get(id);
	if (automation === undefined) {
		return { ok: false, code: 'not_found', message: 'automation not found' };
	}
	const schedule = checkSchedule(input.cron, input.time_zone, deps.now());
	if (!schedule.ok) return { ok: false, code: 'bad_request', message: schedule.message };

	let payload: DispatchPayload = automation.payload;
	if (input.loop !== undefined) {
		if (payload.operation !== 'loop') {
			return { ok: false, code: 'bad_request', message: NOT_A_LOOP_MESSAGE };
		}
		// An absent harness means ralph's default, so the edit clears it.
		const { harness: _previous, ...rest } = payload;
		payload = {
			...rest,
			max_iterations: input.loop.max_iterations,
			...(input.loop.harness === undefined ? {} : { harness: input.loop.harness })
		};
	}

	const updated = await deps.store.update(id, {
		name: input.name,
		cron: input.cron,
		time_zone: input.time_zone,
		overlap: input.overlap,
		payload
	});
	if (updated === undefined) {
		return { ok: false, code: 'not_found', message: 'automation not found' };
	}
	return { ok: true, automation: updated };
}
