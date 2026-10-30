/**
 * Agent dispatch providers. File, Tackle, and comment
 * launch an external agent through exactly one configured provider:
 *
 * - `webhook`: any runner implementing the small signed HTTP contract in
 *   `webhook-provider.ts` (a self-hosted agent box, a microVM platform, CI).
 * - `none`: dispatch is off; the UI hides File/Tackle and the API refuses.
 *
 * Launch and run status are required. Follow-up, cancel, and live event
 * streaming are optional capabilities; the service polls status when a
 * provider cannot stream and refuses follow-up/cancel it cannot perform.
 * A native provider (for example Overalls) implements
 * `AgentProvider`, adds its id and capabilities here, and adds a branch to
 * `getAgentProvider`.
 */
import type { MissionEvent } from '$lib/mission-events.js';
import type { DispatchCapabilities, DispatchProviderId } from '$lib/types.js';
import { getEnv, type ServerEnv } from '../env.js';
import { createWebhookProvider } from './webhook-provider.js';

export type { DispatchProviderId };
export type DispatchProviderSetting = DispatchProviderId | 'none';

export interface AgentLaunchInput {
	name: string;
	prompt: string;
	auto_create_pr: boolean;
	/** When set, launch this checkout instead of BDX_AGENT_REPOSITORY. */
	repository?: {
		url: string;
		starting_ref: string;
	};
}

export interface AgentLaunch {
	agent_id: string;
	agent_url?: string;
	run_id?: string;
}

export type AgentRunStatus = 'running' | 'succeeded' | 'cancelled' | 'failed';

export interface AgentRunUpdate {
	status: AgentRunStatus;
	result_summary?: string;
	duration_ms?: number;
	git_pr_url?: string;
	/** Bead a File run created, when the runner reports it (webhook contract v1 `issue_id`). */
	issue_id?: string;
	error_message?: string;
}

export interface AgentFollowUpRun {
	run_id: string;
}

export interface AgentStreamOptions {
	last_event_id?: string;
	signal?: AbortSignal;
}

export type AgentStreamOutcome = 'terminal' | 'stream_expired' | 'disconnected';

export interface AgentProvider {
	readonly id: DispatchProviderId;
	/** Human name for status and messages, e.g. "Webhook agent runner". */
	readonly label: string;
	launch(input: AgentLaunchInput): Promise<AgentLaunch>;
	getLatestRunId(agent_id: string): Promise<string | undefined>;
	getRun(agent_id: string, run_id: string): Promise<AgentRunUpdate>;
	createRun?(agent_id: string, prompt: string): Promise<AgentFollowUpRun>;
	cancelRun?(agent_id: string, run_id: string): Promise<void>;
	streamRun?(
		agent_id: string,
		run_id: string,
		on_update: (update: AgentRunUpdate) => Promise<void>,
		options?: AgentStreamOptions
	): Promise<AgentStreamOutcome>;
	streamMissionEvents?(
		agent_id: string,
		run_id: string,
		on_event: (event: MissionEvent) => Promise<void>,
		options?: AgentStreamOptions
	): Promise<AgentStreamOutcome>;
}

/** Public message when a runner refuses a follow-up because a run is active. */
export const AGENT_BUSY_MESSAGE = 'The agent is still busy.';
/** Public message when the active run cannot be cancelled. */
export const RUN_NOT_CANCELLABLE_MESSAGE = 'This run cannot be cancelled.';

export const WEBHOOK_PROVIDER_LABEL = 'Webhook agent runner';

/**
 * What each provider can do, for the agent console. The
 * webhook contract makes follow-up and cancel optional; a runner that does
 * not support them answers 404 and the console shows that refusal. A new
 * provider adds its row here.
 */
export const PROVIDER_CAPABILITIES: Record<DispatchProviderId, DispatchCapabilities> = {
	webhook: { live_events: false, follow_up: true, cancel: true }
};

/** Label for a provider id, for status and messages. */
export function providerLabel(id: DispatchProviderSetting): string {
	if (id === 'webhook') return WEBHOOK_PROVIDER_LABEL;
	return 'None';
}

/**
 * The configured provider, or undefined when dispatch is off (`none`, an
 * invalid setting, or a provider missing its required configuration).
 */
export function getAgentProvider(env: ServerEnv = getEnv()): AgentProvider | undefined {
	if (env.dispatch_provider === 'webhook') return createWebhookProvider({ server_env: env });
	return undefined;
}
