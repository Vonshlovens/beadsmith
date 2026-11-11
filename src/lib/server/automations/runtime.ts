/**
 * Production wiring for the automation ticker (ADR-0019 rule 7), modelled on
 * the backup scheduler (ADR-0010): a once-a-minute, unref'd interval started
 * from the server's `init` hook.
 */
import { createAccountStore } from '../auth/store.js';
import { resolveProject } from '../discovery.js';
import { enqueueDispatch } from '../dispatch/service.js';
import { getProjectIssue } from '../read-model.js';
import { getAutomationStore, getDispatchStore, getStateClient } from '../state/db.js';
import { automationTick, type AutomationTickDeps } from './scheduler.js';

const TICK_MS = 60 * 1000;

export async function automationDeps(): Promise<AutomationTickDeps> {
	const accounts = createAccountStore(await getStateClient());
	return {
		store: await getAutomationStore(),
		dispatch: await getDispatchStore(),
		enqueue: (input) => enqueueDispatch(input),
		resolveProject,
		getIssue: async (project, issue_id) => (await getProjectIssue(project, issue_id))?.issue,
		creator: (user_id) => accounts.getStanding(user_id),
		now: () => new Date()
	};
}

let ticking = false;

/**
 * One pass, unless the previous one is still launching (a launch can wait on
 * a sandbox for longer than a minute). Never throws.
 */
export async function runAutomationTick(): Promise<void> {
	if (ticking) return;
	ticking = true;
	try {
		await automationTick(await automationDeps());
	} catch {
		// State may be unavailable; the next tick retries.
	} finally {
		ticking = false;
	}
}

let started = false;

/**
 * Start the once-a-minute ticker. Idempotent. The first pass runs at once,
 * so slots missed while the server was down fire on boot (once each
 * automation, the latest slot only).
 */
export function startAutomationScheduler(): void {
	if (started) return;
	started = true;
	void runAutomationTick();
	const timer = setInterval(() => void runAutomationTick(), TICK_MS);
	// Do not keep the process alive just for automations.
	(timer as unknown as { unref?: () => void }).unref?.();
}
