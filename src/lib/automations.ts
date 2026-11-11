/**
 * Automations as the server stores them and the browser shows them
 * (ADR-0019 rule 7): a launch template with a cron schedule, and the history
 * of the slots it fired. Shared by `src/lib/server/automations/` and the
 * Automations page, so both read one vocabulary.
 */
import type { DispatchLoop, DispatchOperation, DispatchProviderId } from '#lib/types.js';

/**
 * What to do with a slot that falls due while the automation's previous
 * mission is still working: `skip` records it as skipped (the default);
 * `queue` holds one slot and fires it when the previous mission ends, and
 * skips any further slot while one is already waiting.
 */
export const AUTOMATION_OVERLAPS = ['skip', 'queue'] as const;
export type AutomationOverlap = (typeof AUTOMATION_OVERLAPS)[number];

/**
 * A slot's history. `firing` is claimed and not yet resolved (a crash leaves
 * it, and the next tick finishes it); `queued` waits for the previous
 * mission; the rest are final. `refused` means dispatch policy or the
 * creator's standing said no; `failed` means the launch could not be
 * attempted (no such project or issue, Dolt unreachable).
 */
export type AutomationRunOutcome = 'firing' | 'queued' | 'fired' | 'skipped' | 'refused' | 'failed';

/** `schedule` slots are cron instants; `manual` ones are a Run now press. */
export type AutomationTrigger = 'schedule' | 'manual';

/** Longest automation name; it is a label, not a description. */
export const AUTOMATION_NAME_MAX = 80;

/** Fire times a schedule preview lists. */
export const AUTOMATION_PREVIEW_COUNT = 5;

/** Runs an automation's detail lists, newest first. */
export const AUTOMATION_HISTORY_LIMIT = 50;

/** One fired, skipped or refused slot, as the browser sees it. */
export interface AutomationRunView {
	/** ISO instant of the slot; a Run now press records the instant it was pressed. */
	slot: string;
	trigger: AutomationTrigger;
	outcome: AutomationRunOutcome;
	/** The mission it launched, when it launched one. */
	mission_id?: string;
	message?: string;
	updated_at: string;
}

/**
 * What an automation launches, without the text a launch carries (File
 * notes, a comment, a `run` loop's prompt), like a mission in the fleet list.
 */
export interface AutomationLaunchView {
	operation: DispatchOperation;
	/** The bead it acts on; absent for File and for a loop on the whole plan. */
	issue_id?: string;
	/** A loop's flags. */
	loop?: DispatchLoop;
}

export interface AutomationView {
	id: string;
	project_id: string;
	/** Display name of the project; the id when discovery no longer lists it. */
	project_name: string;
	name: string;
	cron: string;
	time_zone: string;
	/** Launch on this runner; absent means the default one. */
	provider?: DispatchProviderId;
	launch: AutomationLaunchView;
	overlap: AutomationOverlap;
	enabled: boolean;
	/** Why the scheduler paused it, when it did. */
	paused_reason?: string;
	/** The next scheduled fire, when it is enabled and the schedule has one. */
	next_run?: string;
	last_run?: AutomationRunView;
	created_at: string;
	updated_at: string;
}

export interface AutomationsResponse {
	automations: AutomationView[];
}

export interface AutomationDetailResponse {
	automation: AutomationView;
	/** The next fire times, empty while it is paused. */
	upcoming: string[];
	runs: AutomationRunView[];
}

export interface AutomationPreviewResponse {
	upcoming: string[];
}
