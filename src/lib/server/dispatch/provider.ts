/**
 * Agent dispatch providers. File, Tackle, and comment
 * launch an external agent through exactly one configured provider:
 *
 * - `webhook`: any runner implementing the small signed HTTP contract in
 *   `webhook-provider.ts` (a self-hosted agent box, a microVM platform, CI).
 * - `e2b`: one hosted E2B sandbox per mission (`e2b-provider.ts`), shown as
 *   "Sand" unless the operator renames it.
 * - `none`: dispatch is off; the UI hides File/Tackle and the API refuses.
 *
 * Several providers can be configured at once (`BDX_DISPATCH_PROVIDER` is a
 * list; the first is the default). A launch may name one of them; a mission
 * keeps the provider that launched it for follow-up, cancel and streaming.
 *
 * Launch and run status are required. Follow-up, cancel, and live event
 * streaming are optional capabilities; the service polls status when a
 * provider cannot stream and refuses follow-up/cancel it cannot perform.
 * A native provider (for example Overalls) implements
 * `AgentProvider`, adds its id and capabilities here, and adds a branch to
 * `createAgentProvider`.
 */
import type { MissionEvent } from '#lib/mission-events.js';
import type { DispatchCapabilities, DispatchProviderId, DispatchProviderInfo } from '#lib/types.js';
import { getEnv, type ServerEnv } from '../env.js';
import { createE2bProvider } from './e2b-provider.js';
import type { RalphStopReason } from '#lib/ralph.js';
import type { RalphIteration } from './ralph.js';
import type { LoopPayload } from './types.js';
import type { TerminalAttachRequest, TerminalRelay } from '../terminal-relay/relay.js';
import { createWebhookProvider } from './webhook-provider.js';

export type { DispatchProviderId };
export type DispatchProviderSetting = DispatchProviderId | 'none';

export interface AgentLaunchInput {
	name: string;
	prompt: string;
	auto_create_pr: boolean;
	/** The project's Dolt database the agent works in. */
	dolt_database: string;
	/** When set, launch this checkout instead of BDX_AGENT_REPOSITORY. */
	repository?: {
		url: string;
		starting_ref: string;
	};
	/** Only on a provider with the `models` capability (checked before launch). */
	model?: string;
	effort?: string;
}

/**
 * A ralph loop to start (ADR-0019 rule 2): `ralph <mode>` with these flags in
 * the project's Tackle checkout, in the runner's hc terminal.
 */
export interface AgentLoopLaunchInput {
	name: string;
	/** The project's Dolt database the loop's agents work in. */
	dolt_database: string;
	repository: {
		url: string;
		starting_ref: string;
	};
	loop: Omit<LoopPayload, 'operation' | 'title'>;
}

export interface AgentLaunch {
	agent_id: string;
	agent_url?: string;
	run_id?: string;
}

/** Where a restarted loop's new run is: its sandbox may be a new one (ADR-0019 rule 5). */
export interface AgentLoopRestart {
	agent_id: string;
	run_id: string;
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
	/**
	 * A loop's finished iterations so far, as ralph records them. The service
	 * copies them into state.db as they arrive, because the sandbox and its
	 * ralph database are destroyed when the loop ends (ADR-0019 rule 5).
	 * Repeats are harmless: an iteration is stored once.
	 */
	iterations?: RalphIteration[];
	/** How a loop's run ended, on its terminal update (ADR-0019 rule 4). */
	loop_end?: LoopEnd;
}

/** Why a loop run ended, kept on the mission so the UI need not parse its summary. */
export interface LoopEnd {
	/** null: ralph recorded no reason (it died first, or sent one this build does not know). */
	stop_reason: RalphStopReason | null;
	/** ralph's stop reason, exit code or report asks a person to look. */
	needs_person: boolean;
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
	/**
	 * Start a ralph loop. Present only on a provider whose runner has ralph
	 * (its `loop` capability); without it a loop launch is refused before a
	 * record or a sandbox exists.
	 */
	launchLoop?(input: AgentLoopLaunchInput): Promise<AgentLaunch>;
	getLatestRunId(agent_id: string): Promise<string | undefined>;
	getRun(agent_id: string, run_id: string): Promise<AgentRunUpdate>;
	createRun?(agent_id: string, prompt: string): Promise<AgentFollowUpRun>;
	cancelRun?(agent_id: string, run_id: string): Promise<void>;
	/**
	 * Loop controls (ADR-0019 rules 3 and 5), on every provider that has
	 * `launchLoop`. `steerRun` queues a note for the loop's next iteration;
	 * `stopRunAfterIteration` lets the current iteration finish and then
	 * ends the loop (ralph's graceful stop). Stopping now is `cancelRun`.
	 * Both throw a `conflict` DispatchError when the loop is not running.
	 */
	steerRun?(agent_id: string, run_id: string, text: string): Promise<void>;
	stopRunAfterIteration?(agent_id: string, run_id: string): Promise<void>;
	/**
	 * Start a new run of an ended loop with `input`'s flags, numbered after
	 * `after_run_id`, as a new terminal (ADR-0019 rule 2), never ralph's own
	 * restart. The runner may place it on a different agent (a fresh sandbox
	 * when the old one is gone); the mission follows the returned ids. Throws
	 * a `conflict` DispatchError when the agent is not a loop or has already
	 * moved past `after_run_id`.
	 */
	restartLoop?(
		agent_id: string,
		after_run_id: string,
		input: AgentLoopLaunchInput
	): Promise<AgentLoopRestart>;
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
	/**
	 * Attach to the agent's hc terminal for the admin relay (ADR-0021 rule 4).
	 * Present only on a provider whose agents run in hc; throws
	 * `TerminalRelayError` when there is no live terminal to attach to.
	 */
	attachTerminal?(agent_id: string, request: TerminalAttachRequest): Promise<TerminalRelay>;
}

/** Public message when a runner refuses a follow-up because a run is active. */
export const AGENT_BUSY_MESSAGE = 'The agent is still busy.';
/** Public message when the active run cannot be cancelled. */
export const RUN_NOT_CANCELLABLE_MESSAGE = 'This run cannot be cancelled.';
/** Public message when a loop control reaches a loop that is not (or not yet) running. */
export const LOOP_NOT_RUNNING_MESSAGE = 'The loop is not running.';
/** Public message when a restart reaches an agent that is not a loop. */
export const NOT_A_LOOP_SANDBOX_MESSAGE = "This mission's agent is not a loop.";
/** Public message when another restart already started the next run. */
export const LOOP_ALREADY_RESTARTED_MESSAGE = 'The loop has already been restarted.';

export const WEBHOOK_PROVIDER_LABEL = 'Webhook agent runner';

/**
 * What each provider can do, for the agent console. The
 * webhook contract makes follow-up and cancel optional; a runner that does
 * not support them answers 404 and the console shows that refusal. E2B
 * streams the agent's own event log. `loop` is true exactly when the provider
 * implements `launchLoop`: the webhook contract has no loop, and Sand gains
 * one when its template carries ralph. `terminal` is true exactly when the
 * provider implements `attachTerminal` (Sand's hc relay; the webhook contract
 * has none). `models` is true when the provider passes a launch's model and
 * effort to its agent; the webhook contract carries neither. A new provider
 * adds its row here.
 */
export const PROVIDER_CAPABILITIES: Record<DispatchProviderId, DispatchCapabilities> = {
	webhook: {
		live_events: false,
		follow_up: true,
		cancel: true,
		loop: false,
		terminal: false,
		models: false
	},
	e2b: {
		live_events: true,
		follow_up: true,
		cancel: true,
		loop: true,
		terminal: true,
		models: true
	}
};

/** Label for a provider id, for status and messages. */
export function providerLabel(id: DispatchProviderSetting, env: ServerEnv = getEnv()): string {
	if (id === 'none') return 'None';
	return env.dispatch_labels[id];
}

/** Every usable provider with its label and capabilities, default first. */
export function configuredProviders(env: ServerEnv = getEnv()): DispatchProviderInfo[] {
	return env.dispatch_providers.map((id) => ({
		id,
		label: env.dispatch_labels[id],
		capabilities: PROVIDER_CAPABILITIES[id]
	}));
}

function createAgentProvider(id: DispatchProviderId, env: ServerEnv): AgentProvider | undefined {
	if (id === 'webhook') return createWebhookProvider({ server_env: env });
	if (id === 'e2b' && env.dispatch_e2b !== undefined) {
		return createE2bProvider({ settings: env.dispatch_e2b, label: env.dispatch_labels.e2b });
	}
	return undefined;
}

/**
 * A configured provider, or undefined when dispatch is off or `id` is not
 * configured. Without `id`, the default (first) provider.
 */
export function getAgentProvider(
	env: ServerEnv = getEnv(),
	id?: DispatchProviderId
): AgentProvider | undefined {
	const wanted = id ?? env.dispatch_providers[0];
	if (wanted === undefined || !env.dispatch_providers.includes(wanted)) return undefined;
	return createAgentProvider(wanted, env);
}
