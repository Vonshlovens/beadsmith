/**
 * Agent console rules shared by the issue agent dialog, the First Mate
 * threads and the missions table. They are
 * provider-agnostic: what a runner can do comes from `dispatch.capabilities`,
 * never from its name.
 */
import type {
	DiscussIntent,
	DispatchCapabilities,
	DispatchOperation,
	DispatchProjectAllow,
	DispatchProviderInfo,
	DispatchRequest,
	DispatchStatus,
	StatusSnapshot
} from '#lib/types.js';

/** What the operator can ask of an agent about one issue. */
export type AgentIntent = DiscussIntent | 'tackle';

/** The issue the agent dialog is about. */
export interface AgentTarget {
	project_id: string;
	issue_id: string;
	issue_title: string;
	/** Preselect an intent. */
	intent?: AgentIntent;
	/** Open this mission's thread instead of starting a new one. */
	request_id?: string;
}

export interface AgentIntentInfo {
	id: AgentIntent;
	label: string;
	/** Single-key shortcut inside the dialog. */
	key: string;
	hint: string;
	placeholder: string;
	/** `talk` is allowed by File or Tackle; `tackle` needs Tackle. */
	needs: 'talk' | 'tackle';
}

export const AGENT_INTENTS: readonly AgentIntentInfo[] = [
	{
		id: 'discuss',
		label: 'Discuss',
		key: 'd',
		hint: 'Ask about it. The agent changes nothing unless you ask.',
		placeholder: 'Question or context (optional)',
		needs: 'talk'
	},
	{
		id: 'elaborate',
		label: 'Elaborate',
		key: 'e',
		hint: 'The agent rewrites the description and acceptance criteria.',
		placeholder: 'What to add or clarify (optional)',
		needs: 'tackle'
	},
	{
		id: 'close',
		label: 'Close',
		key: 'c',
		hint: 'The agent closes it with a reason.',
		placeholder: 'Reason (optional)',
		needs: 'tackle'
	},
	{
		id: 'tackle',
		label: 'Tackle',
		key: 't',
		hint: 'The agent claims it, does the work and opens a pull request.',
		placeholder: '',
		needs: 'tackle'
	}
];

/** Look up one intent's copy. */
export function intentInfo(intent: AgentIntent): AgentIntentInfo {
	return AGENT_INTENTS.find((info) => info.id === intent) ?? AGENT_INTENTS[0]!;
}

export interface AgentAvailability {
	/** Show agent controls at all: some provider is configured. */
	visible: boolean;
	/** A launch would be accepted right now (before per-intent allow). */
	enabled: boolean;
	/** Why not, when visible but not enabled. */
	reason?: string;
}

/**
 * Whether to show the agent controls, and whether they work. With no provider
 * (`none`) there is nothing to show; disarmed or denied shows them disabled
 * with the reason.
 *
 * @param status - Latest health snapshot.
 * @param allow - The project's File/Tackle allow, when known.
 */
export function agentAvailability(
	status: Pick<StatusSnapshot, 'dispatch'> | null,
	allow?: DispatchProjectAllow
): AgentAvailability {
	// A viewer who may not launch (a member) gets no agent controls at all.
	if (
		status === null ||
		!status.dispatch.key_configured ||
		status.dispatch.viewer_can_launch === false
	) {
		return { visible: false, enabled: false };
	}
	if (!status.dispatch.armed) {
		return { visible: true, enabled: false, reason: 'Agent dispatch is disarmed in the console.' };
	}
	if (allow !== undefined && !allow.file && !allow.tackle) {
		return { visible: true, enabled: false, reason: 'Agents are not allowed for this project.' };
	}
	return { visible: true, enabled: true };
}

/**
 * Mirror of the server policy: talking needs File or Tackle; anything that
 * changes the issue needs Tackle. Missing allow means the default (both).
 */
export function intentAllowed(intent: AgentIntent, allow?: DispatchProjectAllow): boolean {
	if (allow === undefined) {
		return true;
	}
	return intentInfo(intent).needs === 'talk' ? allow.file || allow.tackle : allow.tackle;
}

const BUSY: ReadonlySet<DispatchStatus> = new Set(['queued', 'launching', 'launched', 'running']);

/** The agent is still working on this mission. */
export function isBusyStatus(status: DispatchStatus): boolean {
	return BUSY.has(status);
}

/** The dispatch fields the agent console reads. */
export interface DispatchView {
	armed: boolean;
	provider?: string;
	capabilities?: DispatchCapabilities;
	providers?: DispatchProviderInfo[];
}

/**
 * The configured provider a mission was launched by, or undefined when it is
 * no longer configured (or the mission has not launched).
 *
 * @param mission - The thread's mission.
 * @param dispatch - Current dispatch health.
 */
export function missionProvider(
	mission: Pick<DispatchRequest, 'provider'>,
	dispatch: Pick<DispatchView, 'provider' | 'capabilities' | 'providers'> | null
): DispatchProviderInfo | undefined {
	if (dispatch === null || mission.provider === undefined) return undefined;
	const listed = dispatch.providers?.find((entry) => entry.id === mission.provider);
	if (listed !== undefined) return listed;
	// A server without the providers list reports only its one provider.
	if (dispatch.providers === undefined && mission.provider === dispatch.provider) {
		return dispatch.capabilities === undefined
			? undefined
			: { id: mission.provider, label: mission.provider, capabilities: dispatch.capabilities };
	}
	return undefined;
}

/**
 * Whether this service still follows a mission. A mission launched by a
 * provider that is no longer configured keeps its stored status, but nothing
 * refreshes, cancels, or streams it. Missions not launched yet, and an unknown
 * dispatch state, count as followed.
 *
 * @param mission - The thread's mission.
 * @param dispatch - Current dispatch health, or null before it loads.
 */
export function isFollowedMission(
	mission: Pick<DispatchRequest, 'agent_id' | 'provider'>,
	dispatch: Pick<DispatchView, 'provider' | 'capabilities' | 'providers'> | null
): boolean {
	return (
		dispatch === null ||
		mission.agent_id === undefined ||
		missionProvider(mission, dispatch) !== undefined
	);
}

export interface ComposerState {
	can_send: boolean;
	/** Shown under a disabled composer. */
	reason?: string;
}

/**
 * Whether the operator can reply on a thread, and if not, why. Order matters:
 * the most actionable reason wins.
 *
 * @param mission - The thread's mission.
 * @param dispatch - Current dispatch health.
 */
export function composerState(
	mission: Pick<DispatchRequest, 'status' | 'agent_id' | 'provider'>,
	dispatch: DispatchView | null
): ComposerState {
	if (dispatch === null || dispatch.provider === undefined || dispatch.provider === 'none') {
		return { can_send: false, reason: 'Agent dispatch is off on this service.' };
	}
	if (mission.agent_id === undefined) {
		return {
			can_send: false,
			reason:
				mission.status === 'failed' ? 'This run never started.' : 'Waiting for the agent to start.'
		};
	}
	const runner = missionProvider(mission, dispatch);
	if (runner === undefined) {
		return { can_send: false, reason: 'Started on a runner that is no longer configured.' };
	}
	if (isBusyStatus(mission.status)) {
		return { can_send: false, reason: 'The agent is working. Wait for its reply or stop the run.' };
	}
	if (runner.capabilities.follow_up !== true) {
		return { can_send: false, reason: 'This runner does not take follow-up messages.' };
	}
	if (!dispatch.armed) {
		return { can_send: false, reason: 'Agent dispatch is disarmed in the console.' };
	}
	return { can_send: true };
}

/** Short verb for a mission, for thread titles and rows. */
export function missionVerb(mission: Pick<DispatchRequest, 'operation' | 'intent'>): string {
	if (mission.operation === 'discuss') {
		return intentInfo(mission.intent ?? 'discuss').label;
	}
	const verbs: Record<DispatchOperation, string> = {
		file: 'File',
		tackle: 'Tackle',
		comment: 'Comment',
		discuss: 'Discuss',
		loop: 'Loop'
	};
	return verbs[mission.operation];
}

/**
 * A run link that is safe to show for any provider: https with no
 * credentials. Anything else is dropped rather than rendered.
 */
export function isSafeRunUrl(url: string | undefined): url is string {
	if (url === undefined || url.length === 0 || url.length > 500) {
		return false;
	}
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '';
	} catch {
		return false;
	}
}

/** How often to poll a busy mission when the runner has no live events. */
export const THREAD_POLL_MS = 4000;

/**
 * Compact run time: `42s`, `3:07`, `1h 05m`.
 *
 * @param ms - Elapsed milliseconds.
 */
export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	if (total < 60) {
		return `${total}s`;
	}
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	if (minutes < 60) {
		return `${minutes}:${String(seconds).padStart(2, '0')}`;
	}
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** What a mission card in a First Mate chat offers right now. */
export interface MissionCardState {
	/** Still working, and this service still follows it. */
	busy: boolean;
	/** Stop is offered: busy, launched, and its runner can cancel. */
	can_cancel: boolean;
	/** A pull request link safe to show, once there is one. */
	pr_url?: string;
}

/**
 * The card state for a chat's mission, by the same rules as its thread:
 * no Stop for a run nothing follows, or a runner that cannot cancel.
 *
 * @param mission - The mission.
 * @param dispatch - Current dispatch health, or null before it loads.
 */
export function missionCardState(
	mission: Pick<DispatchRequest, 'status' | 'agent_id' | 'provider' | 'git_pr_url'>,
	dispatch: Pick<DispatchView, 'provider' | 'capabilities' | 'providers'> | null
): MissionCardState {
	const busy = isBusyStatus(mission.status) && isFollowedMission(mission, dispatch);
	const can_cancel =
		busy &&
		mission.agent_id !== undefined &&
		missionProvider(mission, dispatch)?.capabilities?.cancel === true;
	return {
		busy,
		can_cancel,
		...(isSafeRunUrl(mission.git_pr_url) ? { pr_url: mission.git_pr_url } : {})
	};
}
