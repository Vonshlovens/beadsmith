/**
 * The automation ticker (ADR-0019 rule 7). Once a minute, every enabled
 * automation whose latest cron slot is newer than its cursor claims that one
 * slot and fires it through `enqueueDispatch` with the idempotency key
 * `automation:<id>:<slot>`, so the full launch policy applies (arm,
 * per-project allow, repository map, provider capability) and a slot fires
 * once however many ticks or restarts see it.
 *
 * Only the latest due slot is claimed: an automation that missed many slots
 * while Beadsmith was down fires once on the first tick after boot, never a
 * catch-up storm. A claimed slot that a crash interrupted stays `firing` and
 * the next tick finishes it; replaying is safe because the dispatch key is
 * the same.
 */
import type { IssueDetail, Project } from '#lib/types.js';
import type { AccountRole } from '../auth/roles.js';
import type { EnqueueDispatchInput } from '../dispatch/service.js';
import type { DispatchRecord } from '../dispatch/types.js';
import { DispatchError } from '../dispatch/types.js';
import { CronError, latestSlot, parseCron } from './cron.js';
import type { AutomationTrigger } from '#lib/automations.js';
import type { Automation, AutomationRun, AutomationStore } from './store.js';

export interface AutomationTickDeps {
	store: AutomationStore;
	/** Look up a fired slot's mission, and a previous mission's status. */
	dispatch: {
		get(id: string): Promise<DispatchRecord | undefined>;
		getByIdempotencyKey(key: string): Promise<DispatchRecord | undefined>;
	};
	enqueue(input: EnqueueDispatchInput): Promise<{ request: { id: string }; created: boolean }>;
	resolveProject(id: string): Promise<Project | undefined>;
	getIssue(project: Project, issue_id: string): Promise<IssueDetail | undefined>;
	/** The creator's email and standing; undefined when the account is gone. */
	creator(
		user_id: string
	): Promise<{ email: string; role: AccountRole; banned: boolean } | undefined>;
	now(): Date;
}

/** Idempotency key of one slot's dispatch. */
export function automationIdempotencyKey(automation_id: string, slot: string): string {
	return `automation:${automation_id}:${slot}`;
}

/**
 * The mission actor for a fired slot: the automation, on behalf of its
 * creator. Missions show it as is.
 */
export function automationActor(automation: Pick<Automation, 'id'>, creator_email: string): string {
	return `automation:${automation.id} for ${creator_email}`;
}

export const CREATOR_NOT_ADMIN_MESSAGE =
	'Paused: the account that created this automation is no longer an admin.';
export const PREVIOUS_RUNNING_MESSAGE = 'Skipped: the previous mission was still running.';
export const ALREADY_QUEUED_MESSAGE = 'Skipped: another run was already waiting.';
export const WAITING_MESSAGE = 'Waiting for the previous mission to finish.';
export const PROJECT_MISSING_MESSAGE = 'The project no longer exists.';
export const PROJECT_UNREACHABLE_MESSAGE = 'The project could not be read.';
export const ISSUE_MISSING_MESSAGE = 'The issue no longer exists.';
export const LAUNCH_FAILED_MESSAGE = 'The mission could not be launched.';

const ACTIVE_STATUSES = new Set<DispatchRecord['status']>([
	'queued',
	'launching',
	'launched',
	'running'
]);

/**
 * The slot an automation should claim at `now`: its latest cron slot, when
 * that is after the cursor. Undefined when nothing is due or the stored
 * schedule no longer parses (it was validated when saved).
 */
export function dueSlot(automation: Automation, now: Date): string | undefined {
	let schedule;
	try {
		schedule = parseCron(automation.cron);
	} catch (error) {
		if (error instanceof CronError) return undefined;
		throw error;
	}
	const slot = latestSlot(schedule, automation.time_zone, now)?.toISOString();
	return slot !== undefined && slot > automation.last_slot ? slot : undefined;
}

async function previousMissionActive(
	automation: Automation,
	slot: string,
	deps: AutomationTickDeps
): Promise<boolean> {
	const previous = await deps.store.latestMissionRun(automation.id, slot);
	if (previous?.mission_id === undefined) return false;
	const record = await deps.dispatch.get(previous.mission_id);
	return record !== undefined && ACTIVE_STATUSES.has(record.status);
}

/**
 * Decide and resolve one claimed (`firing`) or `queued` slot. Every path ends
 * in a final outcome except the overlap wait, which leaves it `queued`.
 */
async function settleRun(
	automation: Automation,
	run: Pick<AutomationRun, 'slot' | 'outcome' | 'trigger'>,
	deps: AutomationTickDeps
): Promise<void> {
	const { store } = deps;
	const key = automationIdempotencyKey(automation.id, run.slot);

	// Already launched before a crash: record it, never launch again.
	const existing = await deps.dispatch.getByIdempotencyKey(key);
	if (existing !== undefined) {
		await store.resolveRun(automation.id, run.slot, { outcome: 'fired', mission_id: existing.id });
		return;
	}

	const creator = await deps.creator(automation.created_by);
	if (creator === undefined || creator.banned || creator.role !== 'admin') {
		await store.setEnabled(automation.id, false, CREATOR_NOT_ADMIN_MESSAGE);
		await store.resolveRun(automation.id, run.slot, {
			outcome: 'refused',
			message: CREATOR_NOT_ADMIN_MESSAGE
		});
		return;
	}

	// A Run now press is an explicit request: it never waits or skips.
	if (run.trigger === 'schedule' && (await previousMissionActive(automation, run.slot, deps))) {
		if (automation.overlap === 'skip') {
			await store.resolveRun(automation.id, run.slot, {
				outcome: 'skipped',
				message: PREVIOUS_RUNNING_MESSAGE
			});
			return;
		}
		if (run.outcome === 'firing') {
			const waiting = (await store.listPending()).some(
				(other) =>
					other.automation_id === automation.id &&
					other.slot !== run.slot &&
					other.outcome === 'queued'
			);
			await store.resolveRun(
				automation.id,
				run.slot,
				waiting
					? { outcome: 'skipped', message: ALREADY_QUEUED_MESSAGE }
					: { outcome: 'queued', message: WAITING_MESSAGE }
			);
		}
		return;
	}

	let project: Project | undefined;
	try {
		project = await deps.resolveProject(automation.project_id);
	} catch {
		await store.resolveRun(automation.id, run.slot, {
			outcome: 'failed',
			message: PROJECT_UNREACHABLE_MESSAGE
		});
		return;
	}
	if (project === undefined) {
		await store.resolveRun(automation.id, run.slot, {
			outcome: 'failed',
			message: PROJECT_MISSING_MESSAGE
		});
		return;
	}

	const actor = automationActor(automation, creator.email);
	const payload =
		automation.payload.operation === 'comment'
			? { ...automation.payload, author: actor }
			: automation.payload;
	const issue_id = 'issue_id' in payload ? payload.issue_id : undefined;
	let issue: IssueDetail | undefined;
	if (issue_id !== undefined) {
		try {
			issue = await deps.getIssue(project, issue_id);
		} catch {
			await store.resolveRun(automation.id, run.slot, {
				outcome: 'failed',
				message: PROJECT_UNREACHABLE_MESSAGE
			});
			return;
		}
		if (issue === undefined) {
			await store.resolveRun(automation.id, run.slot, {
				outcome: 'failed',
				message: ISSUE_MISSING_MESSAGE
			});
			return;
		}
	}

	try {
		const result = await deps.enqueue({
			idempotency_key: key,
			project,
			actor,
			payload,
			...(issue === undefined ? {} : { issue }),
			...(automation.provider === undefined ? {} : { provider: automation.provider })
		});
		await store.resolveRun(automation.id, run.slot, {
			outcome: 'fired',
			mission_id: result.request.id
		});
	} catch (error) {
		// Disarmed dispatch, a disallowed project or a runner without loops:
		// the same refusals a person launching it would get.
		await store.resolveRun(
			automation.id,
			run.slot,
			error instanceof DispatchError && error.code === 'forbidden'
				? { outcome: 'refused', message: error.message }
				: { outcome: 'failed', message: LAUNCH_FAILED_MESSAGE }
		);
	}
}

/**
 * Claim one slot of `automation` and settle it now. Shared by the ticker and
 * Run now, which passes the current instant as a `manual` slot.
 * @returns The run as settled, or undefined when the slot was already claimed.
 */
export async function fireAutomationSlot(
	automation: Automation,
	slot: string,
	trigger: AutomationTrigger,
	deps: AutomationTickDeps
): Promise<AutomationRun | undefined> {
	if (!(await deps.store.claimSlot(automation.id, slot, trigger))) return undefined;
	await settleRun(automation, { slot, outcome: 'firing', trigger }, deps);
	return deps.store.getRun(automation.id, slot);
}

/**
 * One scheduler pass: finish slots left pending (a crash mid-fire, or a
 * queued slot whose previous mission may have ended), then claim and fire
 * each enabled automation's due slot. One automation's failure never stops
 * the others.
 */
export async function automationTick(deps: AutomationTickDeps): Promise<void> {
	const now = deps.now();

	for (const run of await deps.store.listPending()) {
		try {
			const automation = await deps.store.get(run.automation_id);
			if (automation === undefined) continue;
			if (!automation.enabled) {
				// Pausing an automation drops the slot it was holding.
				await deps.store.resolveRun(automation.id, run.slot, {
					outcome: 'skipped',
					message: automation.paused_reason ?? 'Skipped: the automation was paused.'
				});
				continue;
			}
			await settleRun(automation, run, deps);
		} catch {
			// Left pending; the next tick tries again.
		}
	}

	for (const automation of await deps.store.listEnabled()) {
		try {
			const slot = dueSlot(automation, now);
			if (slot !== undefined) await fireAutomationSlot(automation, slot, 'schedule', deps);
		} catch {
			// A claimed slot stays `firing` and the next tick finishes it.
		}
	}
}
