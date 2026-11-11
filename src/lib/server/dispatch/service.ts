import type {
	DispatchLoop,
	DispatchProviderId,
	DispatchTurn,
	IssueDetail,
	LoopIteration,
	Mission,
	Project
} from '#lib/types.js';
import type { MissionEvent } from '#lib/mission-events.js';
import { encodeMissionEvent } from '#lib/mission-events.js';
import { getEnv } from '../env.js';
import {
	getDispatchPolicyStore,
	getDispatchStore,
	getFileMapStore,
	getTackleMapStore,
	getTodoStore
} from '../state/db.js';
import {
	AGENT_BUSY_MESSAGE,
	getAgentProvider,
	LOOP_NOT_RUNNING_MESSAGE,
	RUN_NOT_CANCELLABLE_MESSAGE,
	type AgentLaunch,
	type AgentLaunchInput,
	type AgentLoopLaunchInput,
	type AgentProvider,
	type AgentRunStatus,
	type AgentRunUpdate,
	type AgentStreamOutcome
} from './provider.js';
import { buildDispatchAgentName, buildDispatchPrompt } from './prompts.js';
import {
	deniedOperationMessage,
	DISARMED_DISPATCH_MESSAGE,
	type DispatchPolicy,
	operationAllowed
} from './policy.js';
import {
	INVALID_FILE_CHECKOUT_MESSAGE,
	type FileCheckoutMapping,
	type FileCheckoutRecord
} from './file-maps.js';
import {
	INVALID_TACKLE_MAPPING_MESSAGE,
	type TackleRepositoryMapping,
	UNMAPPED_TACKLE_MESSAGE
} from './repositories.js';
import { mergeTackleMaps } from './tackle-maps.js';
import {
	RELAY_UNAVAILABLE_MESSAGE,
	TerminalRelayError,
	type TerminalAttachRequest,
	type TerminalRelay
} from '../terminal-relay/relay.js';
import { DispatchError, type DispatchPayload, type DispatchRecord } from './types.js';
import { chatNoticeKey, type DispatchStore, type ListDispatchFilter } from './store.js';

export interface EnqueueDispatchInput {
	idempotency_key: string;
	project: Project;
	actor: string;
	payload: DispatchPayload;
	issue?: IssueDetail;
	/** Launch on this configured provider; omitted means the default one. */
	provider?: DispatchProviderId;
	/** First Mate chat launching it through a crew tool (ADR-0020 rule 5). */
	chat_id?: string;
}

export interface DispatchDeps {
	store?: DispatchStore;
	/** Dispatch provider; defaults to the configured one. */
	provider?: AgentProvider;
	/** Several providers, default first (tests); overrides `provider`. */
	providers?: AgentProvider[];
	configured?: boolean;
	repositories?: Record<string, TackleRepositoryMapping>;
	repositories_invalid?: boolean;
	sqlite_maps?: Record<string, TackleRepositoryMapping>;
	file_maps?: Record<string, FileCheckoutMapping>;
	file_map_invalid?: boolean;
	schedule_background?: (task: () => Promise<void>) => void;
	sleep?: (delay_ms: number) => Promise<void>;
	max_poll_attempts?: number;
	policy?: DispatchPolicy;
	/**
	 * Tell a chat-launched mission's chat its outcome (ADR-0020 rule 5).
	 * Called, not awaited, on every terminal transition of such a mission;
	 * defaults to `deliverCrewNotice`, which skips outcomes already told.
	 */
	notify_chat?: (record: DispatchRecord) => Promise<unknown>;
}

const NOT_CONFIGURED_MESSAGE = 'Agent dispatch is not configured on this service.';
export const LOOP_NOT_SUPPORTED_MESSAGE = 'That agent runner cannot run loops.';
export const LOOP_FOLLOW_UP_MESSAGE = 'A loop takes steer notes and stops, not a follow-up.';
export const NOT_A_LOOP_MESSAGE = 'Only a loop takes steer notes and stops after an iteration.';
export const RESTART_NOT_A_LOOP_MESSAGE = 'Only a loop can be restarted.';
export const LOOP_STILL_RUNNING_MESSAGE = 'The loop is still running. Stop it before restarting.';
export const MISSION_NOT_LAUNCHED_MESSAGE = 'This mission has not launched an agent yet.';

export const UNKNOWN_PROVIDER_MESSAGE = 'That agent runner is not configured on this service.';

/**
 * A configured provider, honouring test injection: `id`, or the default
 * (first) one when `id` is omitted.
 */
function resolveProvider(deps: DispatchDeps, id?: DispatchProviderId): AgentProvider | undefined {
	if (deps.providers !== undefined) {
		return id === undefined ? deps.providers[0] : deps.providers.find((p) => p.id === id);
	}
	if (deps.provider !== undefined) {
		return id === undefined || id === deps.provider.id ? deps.provider : undefined;
	}
	return getAgentProvider(getEnv(), id);
}

function requireProvider(deps: DispatchDeps, id?: DispatchProviderId): AgentProvider {
	const provider = resolveProvider(deps, id);
	if (provider === undefined) {
		throw new DispatchError(
			'forbidden',
			id === undefined ? NOT_CONFIGURED_MESSAGE : UNKNOWN_PROVIDER_MESSAGE
		);
	}
	return provider;
}

/**
 * The provider that launched this mission, if it is still configured. Rows
 * without a known provider came from one this build no longer has.
 */
function providerForRecord(record: DispatchRecord, deps: DispatchDeps): AgentProvider | undefined {
	if (record.provider === undefined) return undefined;
	return resolveProvider(deps, record.provider);
}

function requireRecordProvider(record: DispatchRecord, deps: DispatchDeps): AgentProvider {
	const provider = providerForRecord(record, deps);
	if (provider === undefined) {
		throw new DispatchError(
			'conflict',
			'This mission was launched by a provider that is no longer configured.'
		);
	}
	return provider;
}
export { AGENT_BUSY_MESSAGE, LOOP_NOT_RUNNING_MESSAGE, RUN_NOT_CANCELLABLE_MESSAGE };
const DEFAULT_MAX_POLL_ATTEMPTS = 120;
const active_followers = new Set<string>();

function isFollowableStatus(status: DispatchRecord['status']): boolean {
	return status === 'launched' || status === 'running';
}

function isTerminalRunStatus(
	status: AgentRunStatus
): status is 'succeeded' | 'cancelled' | 'failed' {
	return status === 'succeeded' || status === 'cancelled' || status === 'failed';
}

function defaultSleep(delay_ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, delay_ms);
	});
}

function defaultScheduleBackground(task: () => Promise<void>): void {
	setTimeout(() => {
		void task().catch(() => {
			// Provider availability must not create an unhandled rejection.
		});
	}, 0);
}

function pollDelay(attempt: number): number {
	return Math.min(2_000 * 2 ** attempt, 30_000);
}

async function persistRunUpdate(
	store: DispatchStore,
	request_id: string,
	run_id: string,
	update: AgentRunUpdate,
	deps: DispatchDeps
): Promise<DispatchRecord | undefined> {
	const saved = await store.updateStatus(request_id, {
		status: update.status,
		result_summary: update.result_summary,
		duration_ms: update.duration_ms,
		git_pr_url: update.git_pr_url,
		error_message: update.error_message,
		loop_end: update.loop_end
	});
	if (update.iterations !== undefined && update.iterations.length > 0) {
		try {
			await store.recordLoopIterations(request_id, run_id, update.iterations);
		} catch {
			// The next update carries the same iterations and tries again.
		}
	}
	if (update.issue_id !== undefined) {
		try {
			// A routed todo learns its bead here; others have no match.
			await (await getTodoStore()).linkRoutedIssue(request_id, update.issue_id);
		} catch {
			// The link is display state; the dispatch row stays the source of truth.
		}
	}
	if (isTerminalRunStatus(update.status)) {
		await appendAgentTurn(store, request_id, run_id, update.status, {
			result_summary: update.result_summary,
			error_message: update.error_message
		});
		notifyChat(saved, deps);
	}
	return saved;
}

async function defaultNotifyChat(record: DispatchRecord): Promise<unknown> {
	// Imported on use: the notice module reaches the chat runners, which load
	// the crew tools, which import this module.
	const notices = await import('../crew/notices.js');
	return notices.deliverCrewNotice(record, await notices.defaultCrewNoticeDeps());
}

/**
 * Tell the launching chat a mission's outcome, in the background. Status
 * bookkeeping never waits on the chat's runner and never fails because of it.
 */
function notifyChat(record: DispatchRecord | undefined, deps: DispatchDeps): void {
	if (record?.chat_id === undefined || chatNoticeKey(record) === undefined) return;
	try {
		void (deps.notify_chat ?? defaultNotifyChat)(record).catch(() => {});
	} catch {
		// A notifier that throws synchronously is as good as a deferred notice.
	}
}

/**
 * A launch that fails synchronously answers the crew tool that asked for it,
 * so its chat already knows: record that instead of sending a notice too.
 */
async function markChatToldAtLaunch(
	store: DispatchStore,
	record: DispatchRecord | undefined
): Promise<void> {
	const key = record === undefined ? undefined : chatNoticeKey(record);
	if (record?.chat_id === undefined || key === undefined) return;
	try {
		await store.markChatNotice(record.id, key);
	} catch {
		// At worst the chat hears the outcome twice.
	}
}

/**
 * Record a finished run's reply once. Turn bookkeeping never fails a status
 * update: the durable row stays the source of truth.
 */
async function appendAgentTurn(
	store: DispatchStore,
	request_id: string,
	run_id: string | undefined,
	status: 'succeeded' | 'cancelled' | 'failed',
	result: { result_summary?: string; error_message?: string }
): Promise<void> {
	try {
		await store.appendTurn(request_id, {
			role: 'agent',
			text: agentTurnText(status, result),
			run_id,
			status
		});
	} catch {
		// A missing turn only thins the transcript.
	}
}

function agentTurnText(
	status: 'succeeded' | 'cancelled' | 'failed',
	result: { result_summary?: string; error_message?: string }
): string {
	if (status === 'failed') {
		return result.error_message ?? result.result_summary ?? 'The run failed.';
	}
	if (status === 'cancelled') {
		return result.result_summary ?? 'The run was cancelled.';
	}
	return result.result_summary ?? 'The run finished without a summary.';
}

const TACKLE_TURN_TEXT: Record<string, string> = {
	in_progress: 'Start work on this issue.',
	closed: 'Check whether this is finished, then close it.',
	blocked: 'Find out what blocks this issue.',
	deferred: 'Park this issue as deferred.',
	open: 'Stop work and return this issue to ready.'
};

const DISCUSS_TURN_TEXT: Record<string, string> = {
	discuss: 'Discuss this issue.',
	elaborate: 'Elaborate the description and acceptance criteria.',
	close: 'Close this issue.'
};

const LOOP_MODE_TEXT: Record<string, string> = {
	build: 'Run a build loop',
	plan: 'Run a planning loop',
	reverse: 'Run a reverse-engineering loop'
};

/** What the operator asked for, in words, as the first turn of a mission. */
export function operatorTurnText(payload: DispatchPayload): string {
	if (payload.operation === 'loop') {
		if (payload.prompt !== undefined) {
			return payload.prompt;
		}
		const what = LOOP_MODE_TEXT[payload.mode] ?? 'Run a loop';
		return payload.issue_id === undefined
			? `${what} on the project's plan.`
			: `${what} on ${payload.issue_id}.`;
	}
	if (payload.operation === 'file') {
		return payload.notes;
	}
	if (payload.operation === 'comment') {
		return payload.text;
	}
	if (payload.operation === 'discuss') {
		return payload.message ?? DISCUSS_TURN_TEXT[payload.intent] ?? 'Discuss this issue.';
	}
	return (
		TACKLE_TURN_TEXT[payload.destination_status ?? 'in_progress'] ?? 'Start work on this issue.'
	);
}

/** The policy question a payload asks: its operation, plus a discuss intent. */
function payloadIntent(payload: DispatchPayload) {
	return payload.operation === 'discuss' ? payload.intent : undefined;
}

async function resolveRunId(
	record: DispatchRecord,
	store: DispatchStore,
	provider: AgentProvider
): Promise<DispatchRecord> {
	if (record.run_id !== undefined || record.agent_id === undefined) {
		return record;
	}
	const run_id = await provider.getLatestRunId(record.agent_id);
	if (run_id === undefined) {
		return record;
	}
	return (
		(await store.updateStatus(record.id, {
			status: record.status,
			run_id: run_id,
			error_message: record.error_message
		})) ?? { ...record, run_id: run_id }
	);
}

async function refreshDispatchRecord(
	record: DispatchRecord,
	store: DispatchStore,
	provider: AgentProvider,
	deps: DispatchDeps
): Promise<DispatchRecord> {
	const resolved = await resolveRunId(record, store, provider);
	if (resolved.agent_id === undefined || resolved.run_id === undefined) {
		return resolved;
	}
	const update = await provider.getRun(resolved.agent_id, resolved.run_id);
	return (
		(await persistRunUpdate(store, resolved.id, resolved.run_id, update, deps)) ?? {
			...resolved,
			...update
		}
	);
}

async function followDispatchRecord(
	record: DispatchRecord,
	store: DispatchStore,
	provider: AgentProvider,
	deps: DispatchDeps
): Promise<void> {
	let resolved: DispatchRecord;
	try {
		resolved = await resolveRunId(record, store, provider);
	} catch {
		return;
	}
	if (resolved.agent_id === undefined || resolved.run_id === undefined) {
		return;
	}
	const run_id = resolved.run_id;

	if (provider.streamRun !== undefined) {
		try {
			const stream_outcome = await provider.streamRun(
				resolved.agent_id,
				resolved.run_id,
				async (update) => {
					await persistRunUpdate(store, resolved.id, run_id, update, deps);
				}
			);
			if (stream_outcome === 'terminal') {
				return;
			}
		} catch {
			// A disconnected/expired stream falls through to authoritative GET polling.
		}
	}

	const sleep = deps.sleep ?? defaultSleep;
	const attempts = deps.max_poll_attempts ?? DEFAULT_MAX_POLL_ATTEMPTS;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		try {
			const update = await provider.getRun(resolved.agent_id, run_id);
			await persistRunUpdate(store, resolved.id, run_id, update, deps);
			if (isTerminalRunStatus(update.status)) {
				return;
			}
		} catch {
			// Leave launched/running honest while the provider is temporarily unavailable.
		}
		if (attempt + 1 < attempts) {
			await sleep(pollDelay(attempt));
		}
	}
}

function scheduleFollower(
	record: DispatchRecord,
	store: DispatchStore,
	provider: AgentProvider,
	deps: DispatchDeps
): void {
	if (!isFollowableStatus(record.status) || active_followers.has(record.id)) {
		return;
	}
	active_followers.add(record.id);
	const schedule = deps.schedule_background ?? defaultScheduleBackground;
	try {
		schedule(async () => {
			try {
				await followDispatchRecord(record, store, provider, deps);
			} finally {
				active_followers.delete(record.id);
			}
		});
	} catch (error) {
		active_followers.delete(record.id);
		throw error;
	}
}

function publicIssueId(record: DispatchRecord): string | undefined {
	if (record.payload.operation === 'file') {
		return undefined;
	}
	// A loop on the whole plan has none.
	return record.payload.issue_id;
}

function publicTitle(payload: DispatchPayload): string | undefined {
	const title = payload.title?.trim();
	return title !== undefined && title.length > 0 ? title : undefined;
}

/** Public representation: no idempotency key, payload, or actor. */
export function toPublicDispatch(record: DispatchRecord) {
	return {
		id: record.id,
		project_id: record.project_id,
		operation: record.operation,
		intent: record.payload.operation === 'discuss' ? record.payload.intent : undefined,
		status: record.status,
		provider: record.provider,
		issue_id: publicIssueId(record),
		agent_id: record.agent_id,
		agent_url: record.agent_url,
		result_summary: record.result_summary,
		duration_ms: record.duration_ms,
		git_pr_url: record.git_pr_url,
		created_at: record.created_at,
		updated_at: record.updated_at,
		error_message: record.status === 'failed' ? record.error_message : undefined,
		loop: publicLoop(record.payload, record.loop_end, record.loop_stop_requested)
	};
}

/**
 * A loop's flags and how it ended; never its `run` prompt. Automations show
 * their template's flags with it too.
 */
export function publicLoop(
	payload: DispatchPayload,
	loop_end?: DispatchRecord['loop_end'],
	stop_requested?: boolean
): DispatchLoop | undefined {
	if (payload.operation !== 'loop') return undefined;
	const loop: DispatchLoop = { mode: payload.mode };
	if (payload.issue_id !== undefined) loop.issue_id = payload.issue_id;
	if (payload.harness !== undefined) loop.harness = payload.harness;
	if (payload.model !== undefined) loop.model = payload.model;
	if (payload.effort !== undefined) loop.effort = payload.effort;
	if (payload.max_iterations !== undefined) loop.max_iterations = payload.max_iterations;
	if (payload.iteration_timeout_minutes !== undefined) {
		loop.iteration_timeout_minutes = payload.iteration_timeout_minutes;
	}
	if (loop_end !== undefined) {
		if (loop_end.stop_reason !== null) loop.stop_reason = loop_end.stop_reason;
		loop.needs_person = loop_end.needs_person;
	}
	if (stop_requested === true) loop.stop_requested = true;
	return loop;
}

/**
 * Fleet representation: includes actor and a short title, never File notes,
 * Tackle description, or the idempotency key.
 */
export function toPublicMission(record: DispatchRecord, project_name: string): Mission {
	return {
		...toPublicDispatch(record),
		actor: record.actor,
		project_name,
		title: publicTitle(record.payload)
	};
}

/**
 * Persist a File/Tackle/comment/discuss/loop intent, then launch an agent.
 *
 * Idempotent replays return the original record without launching a second agent.
 */
export async function enqueueDispatch(
	input: EnqueueDispatchInput,
	deps: DispatchDeps = {}
): Promise<{ request: ReturnType<typeof toPublicDispatch>; created: boolean }> {
	if (!(deps.configured ?? resolveProvider(deps) !== undefined)) {
		throw new DispatchError('forbidden', NOT_CONFIGURED_MESSAGE);
	}
	if (input.provider !== undefined && resolveProvider(deps, input.provider) === undefined) {
		throw new DispatchError('forbidden', UNKNOWN_PROVIDER_MESSAGE);
	}
	if (input.payload.operation === 'loop') {
		// Refused before a record exists, so no sandbox ever starts for it
		// (ADR-0019 rule 1).
		const runner = resolveProvider(deps, input.provider);
		if (runner !== undefined && runner.launchLoop === undefined) {
			throw new DispatchError('forbidden', LOOP_NOT_SUPPORTED_MESSAGE);
		}
	}

	const policy = await resolvePolicy(input.project.id, deps);
	if (!policy.armed) {
		throw new DispatchError('forbidden', DISARMED_DISPATCH_MESSAGE);
	}
	const intent = payloadIntent(input.payload);
	if (!operationAllowed(policy.allow, input.payload.operation, intent)) {
		throw new DispatchError('forbidden', deniedOperationMessage(input.payload.operation, intent));
	}

	const store = deps.store ?? (await getDispatchStore());
	const { record, created } = await store.create({
		idempotency_key: input.idempotency_key,
		project_id: input.project.id,
		dolt_database: input.project.dolt_database,
		operation: input.payload.operation,
		actor: input.actor,
		payload: enrichPayload(input.payload, input.issue),
		...(input.chat_id === undefined ? {} : { chat_id: input.chat_id })
	});

	if (!created) {
		const replay_provider = providerForRecord(record, deps);
		if (isFollowableStatus(record.status) && replay_provider !== undefined) {
			try {
				scheduleFollower(record, store, replay_provider, deps);
			} catch {
				// Replays still return the durable record if scheduling is unavailable.
			}
		}
		return { request: toPublicDispatch(record), created: false };
	}

	try {
		await store.appendTurn(record.id, { role: 'operator', text: operatorTurnText(record.payload) });
	} catch {
		// The transcript is display state; launching does not depend on it.
	}

	const launching = await store.updateStatus(record.id, {
		status: 'launching'
	});
	const working = launching ?? record;
	const plan = await planLaunch(working, deps);

	if (!plan.ok) {
		const failed = await store.updateStatus(working.id, {
			status: 'failed',
			error_message: plan.error_message
		});
		await appendAgentTurn(store, working.id, undefined, 'failed', {
			error_message: plan.error_message
		});
		await markChatToldAtLaunch(store, failed);
		return {
			request: toPublicDispatch(failed ?? { ...working, status: 'failed' }),
			created: true
		};
	}

	let provider: AgentProvider | undefined;
	try {
		provider = requireProvider(deps, input.provider);
		const launched = await launchPlanned(provider, plan);
		const saved = await store.updateStatus(working.id, {
			status: 'launched',
			provider: provider.id,
			agent_id: launched.agent_id,
			agent_url: launched.agent_url,
			run_id: launched.run_id
		});
		const launched_record = saved ?? {
			...working,
			status: 'launched' as const,
			provider: provider.id,
			agent_id: launched.agent_id,
			agent_url: launched.agent_url,
			run_id: launched.run_id
		};
		try {
			scheduleFollower(launched_record, store, provider, deps);
		} catch {
			// Launch success remains durable even if this process cannot schedule.
		}
		return { request: toPublicDispatch(launched_record), created: true };
	} catch (error) {
		const message =
			error instanceof DispatchError
				? error.message
				: `${provider?.label ?? 'The dispatch provider'} could not launch the agent.`;
		const failed = await store.updateStatus(working.id, {
			status: 'failed',
			error_message: message
		});
		await appendAgentTurn(store, working.id, undefined, 'failed', { error_message: message });
		await markChatToldAtLaunch(store, failed);
		return {
			request: toPublicDispatch(failed ?? { ...working, status: 'failed' }),
			created: true
		};
	}
}

async function loadSqliteMaps(
	deps: DispatchDeps
): Promise<Record<string, TackleRepositoryMapping>> {
	if (deps.sqlite_maps !== undefined) {
		return deps.sqlite_maps;
	}
	try {
		return await (await getTackleMapStore()).list();
	} catch {
		return {};
	}
}

async function resolvePolicy(project_id: string, deps: DispatchDeps): Promise<DispatchPolicy> {
	if (deps.policy !== undefined) {
		return deps.policy;
	}
	try {
		const store = await getDispatchPolicyStore();
		return {
			armed: await store.getArmed(),
			allow: await store.getAllow(project_id)
		};
	} catch {
		throw new DispatchError('unavailable', 'Dispatch policy could not be read.');
	}
}

async function resolveLaunchMaps(
	deps: DispatchDeps
): Promise<{ invalid: boolean; mappings: Record<string, TackleRepositoryMapping> }> {
	if (deps.repositories_invalid === true) {
		return { invalid: true, mappings: {} };
	}
	if (deps.repositories !== undefined) {
		return { invalid: false, mappings: deps.repositories };
	}

	const env = getEnv();
	const sqlite = await loadSqliteMaps(deps);
	const merged = mergeTackleMaps(
		{
			mappings: env.tackle_repositories,
			error: env.tackle_repositories_error
		},
		sqlite
	);
	return { invalid: merged.invalid, mappings: merged.mappings };
}

async function resolveFileCheckout(
	project_id: string,
	deps: DispatchDeps
): Promise<FileCheckoutRecord> {
	if (deps.file_map_invalid === true) {
		return { kind: 'invalid' };
	}
	if (deps.file_maps !== undefined) {
		const mapping = deps.file_maps[project_id];
		return mapping === undefined ? { kind: 'none' } : { kind: 'valid', mapping };
	}
	try {
		return await (await getFileMapStore()).inspect(project_id);
	} catch {
		return { kind: 'none' };
	}
}

/** What to launch: a one-shot agent, or a ralph loop. */
type LaunchPlan =
	| { ok: true; input: AgentLaunchInput; loop?: undefined }
	| { ok: true; loop: AgentLoopLaunchInput; input?: undefined };

function launchPlanned(provider: AgentProvider, plan: LaunchPlan): Promise<AgentLaunch> {
	if (plan.loop === undefined) {
		return provider.launch(plan.input);
	}
	if (provider.launchLoop === undefined) {
		throw new DispatchError('forbidden', LOOP_NOT_SUPPORTED_MESSAGE);
	}
	return provider.launchLoop(plan.loop);
}

async function planLaunch(
	record: DispatchRecord,
	deps: DispatchDeps
): Promise<LaunchPlan | { ok: false; error_message: string }> {
	const name = buildDispatchAgentName(record);
	const dolt_database = record.dolt_database;
	if (record.payload.operation === 'loop') {
		// A loop writes code and Beads like a Tackle, so it runs in the
		// project's Tackle checkout; loops add no repository map of their own
		// (ADR-0019 rule 5).
		const resolved = await resolveLaunchMaps(deps);
		if (resolved.invalid) {
			return { ok: false, error_message: INVALID_TACKLE_MAPPING_MESSAGE };
		}
		const mapping = resolved.mappings[record.project_id];
		if (mapping === undefined) {
			return { ok: false, error_message: UNMAPPED_TACKLE_MESSAGE };
		}
		const { operation: _operation, title: _title, ...loop } = record.payload;
		return {
			ok: true,
			loop: {
				name,
				dolt_database,
				repository: { url: mapping.url, starting_ref: mapping.ref },
				loop
			}
		};
	}
	const prompt = buildDispatchPrompt(record);
	if (record.operation === 'file') {
		const checkout = await resolveFileCheckout(record.project_id, deps);
		if (checkout.kind === 'invalid') {
			return { ok: false, error_message: INVALID_FILE_CHECKOUT_MESSAGE };
		}
		if (checkout.kind === 'none') {
			return { ok: true, input: { name, prompt, dolt_database, auto_create_pr: false } };
		}
		return {
			ok: true,
			input: {
				name,
				prompt,
				dolt_database,
				auto_create_pr: false,
				repository: { url: checkout.mapping.url, starting_ref: checkout.mapping.ref }
			}
		};
	}

	if (record.operation === 'discuss') {
		return {
			ok: true,
			input: {
				name,
				prompt,
				dolt_database,
				auto_create_pr: false,
				...(await discussCheckout(record, deps))
			}
		};
	}

	if (record.operation !== 'tackle') {
		return { ok: true, input: { name, prompt, dolt_database, auto_create_pr: false } };
	}

	const resolved = await resolveLaunchMaps(deps);
	if (resolved.invalid) {
		return { ok: false, error_message: INVALID_TACKLE_MAPPING_MESSAGE };
	}

	const mapping = resolved.mappings[record.project_id];
	if (mapping === undefined) {
		return { ok: false, error_message: UNMAPPED_TACKLE_MESSAGE };
	}

	const auto_create_pr =
		record.payload.operation === 'tackle' && tackleCreatesPullRequest(record.payload)
			? mapping.auto_create_pr
			: false;

	return {
		ok: true,
		input: {
			name,
			prompt,
			dolt_database,
			auto_create_pr,
			repository: { url: mapping.url, starting_ref: mapping.ref }
		}
	};
}

/**
 * A discussion reads the project's Tackle checkout when one is mapped, else
 * its File checkout, so the agent can look at the code (and, on Sand, the
 * repository's pull requests) it is asked about. It never opens a pull
 * request, and an unmapped or invalid map just launches without a checkout.
 */
async function discussCheckout(
	record: DispatchRecord,
	deps: DispatchDeps
): Promise<Pick<AgentLaunchInput, 'repository'>> {
	try {
		const resolved = await resolveLaunchMaps(deps);
		const tackle = resolved.invalid ? undefined : resolved.mappings[record.project_id];
		if (tackle !== undefined) {
			return { repository: { url: tackle.url, starting_ref: tackle.ref } };
		}
		const file = await resolveFileCheckout(record.project_id, deps);
		return file.kind === 'valid'
			? { repository: { url: file.mapping.url, starting_ref: file.mapping.ref } }
			: {};
	} catch {
		return {};
	}
}

/** Start-work /tackle may open a PR. Other board destinations are bd-only. */
function tackleCreatesPullRequest(
	payload: Extract<DispatchPayload, { operation: 'tackle' }>
): boolean {
	return payload.destination_status === undefined || payload.destination_status === 'in_progress';
}

function enrichPayload(payload: DispatchPayload, issue: IssueDetail | undefined): DispatchPayload {
	if (issue === undefined) {
		return payload;
	}
	if (payload.operation === 'tackle') {
		return {
			...payload,
			title: issue.title,
			description: issue.description
		};
	}
	if (payload.operation === 'comment') {
		return {
			...payload,
			title: issue.title
		};
	}
	if (payload.operation === 'discuss') {
		return {
			...payload,
			title: issue.title,
			description: issue.description
		};
	}
	if (payload.operation === 'loop') {
		return {
			...payload,
			title: issue.title
		};
	}
	return payload;
}

/** True when a dispatch row exists for this project. Does not follow the run. */
export async function dispatchExists(
	project_id: string,
	request_id: string,
	deps: DispatchDeps = {}
): Promise<boolean> {
	const store = deps.store ?? (await getDispatchStore());
	const record = await store.get(request_id);
	return record !== undefined && record.project_id === project_id;
}

/** Load one dispatch record for the given project. */
export async function getDispatch(
	project_id: string,
	request_id: string,
	deps: DispatchDeps = {}
): Promise<ReturnType<typeof toPublicDispatch> | undefined> {
	const store = deps.store ?? (await getDispatchStore());
	const record = await store.get(request_id);
	if (record === undefined || record.project_id !== project_id) {
		return undefined;
	}
	let current = record;
	const provider = providerForRecord(record, deps);
	if (isFollowableStatus(record.status) && provider !== undefined) {
		try {
			current = await refreshDispatchRecord(record, store, provider, deps);
		} catch {
			// GET returns the last durable state when the provider is unavailable.
		}
		if (isFollowableStatus(current.status)) {
			try {
				scheduleFollower(current, store, provider, deps);
			} catch {
				// The refreshed durable state is still safe to return.
			}
		}
	}
	return toPublicDispatch(current);
}

function isTerminalDispatchStatus(status: DispatchRecord['status']): boolean {
	return status === 'succeeded' || status === 'cancelled' || status === 'failed';
}

async function requireConfigured(deps: DispatchDeps): Promise<void> {
	if (!(deps.configured ?? resolveProvider(deps) !== undefined)) {
		throw new DispatchError('forbidden', NOT_CONFIGURED_MESSAGE);
	}
}

async function loadOwnedRecord(
	project_id: string,
	request_id: string,
	store: DispatchStore
): Promise<DispatchRecord | undefined> {
	const record = await store.get(request_id);
	if (record === undefined || record.project_id !== project_id) {
		return undefined;
	}
	return record;
}

/**
 * Cancel the active agent run for a File/Tackle mission. Idempotent when the
 * run is already terminal. Does not require the global arm — operators can
 * still stop spend after disarming.
 */
export async function cancelDispatch(
	project_id: string,
	request_id: string,
	deps: DispatchDeps = {}
): Promise<ReturnType<typeof toPublicDispatch> | undefined> {
	await requireConfigured(deps);
	const store = deps.store ?? (await getDispatchStore());
	const record = await loadOwnedRecord(project_id, request_id, store);
	if (record === undefined) {
		return undefined;
	}
	if (record.agent_id === undefined) {
		throw new DispatchError('conflict', MISSION_NOT_LAUNCHED_MESSAGE);
	}

	const provider = requireRecordProvider(record, deps);
	const cancelRun = provider.cancelRun;
	if (cancelRun === undefined) {
		throw new DispatchError('forbidden', `${provider.label} cannot cancel runs.`);
	}
	let current = record;
	if (isFollowableStatus(current.status)) {
		try {
			current = await refreshDispatchRecord(current, store, provider, deps);
		} catch {
			current = record;
		}
	}
	if (isTerminalDispatchStatus(current.status)) {
		return toPublicDispatch(current);
	}
	if (!isFollowableStatus(current.status) || current.agent_id === undefined) {
		throw new DispatchError('conflict', RUN_NOT_CANCELLABLE_MESSAGE);
	}

	current = await resolveRunId(current, store, provider);
	if (current.agent_id === undefined || current.run_id === undefined) {
		throw new DispatchError('conflict', RUN_NOT_CANCELLABLE_MESSAGE);
	}

	try {
		await cancelRun(current.agent_id, current.run_id);
	} catch (error) {
		if (error instanceof DispatchError && error.code === 'conflict') {
			try {
				current = await refreshDispatchRecord(current, store, provider, deps);
			} catch {
				throw error;
			}
			if (isTerminalDispatchStatus(current.status)) {
				return toPublicDispatch(current);
			}
		}
		throw error;
	}

	try {
		current = await refreshDispatchRecord(current, store, provider, deps);
	} catch {
		const cancelled = await store.updateStatus(current.id, { status: 'cancelled' });
		await appendAgentTurn(store, current.id, current.run_id, 'cancelled', {});
		notifyChat(cancelled, deps);
		return toPublicDispatch(cancelled ?? { ...current, status: 'cancelled' });
	}
	if (!isTerminalDispatchStatus(current.status)) {
		const cancelled = await store.updateStatus(current.id, { status: 'cancelled' });
		await appendAgentTurn(store, current.id, current.run_id, 'cancelled', {});
		notifyChat(cancelled, deps);
		current = cancelled ?? { ...current, status: 'cancelled' };
	}
	return toPublicDispatch(current);
}

/**
 * Send a size-capped follow-up on the same agent. The browser cannot
 * choose repo, model, or shell — only this text. Disabled while the agent is
 * busy (local launched/running, or the runner reports it busy).
 */
export async function followUpDispatch(
	project_id: string,
	request_id: string,
	text: string,
	deps: DispatchDeps = {}
): Promise<ReturnType<typeof toPublicDispatch> | undefined> {
	await requireConfigured(deps);
	const store = deps.store ?? (await getDispatchStore());
	const record = await loadOwnedRecord(project_id, request_id, store);
	if (record === undefined) {
		return undefined;
	}

	const policy = await resolvePolicy(record.project_id, deps);
	if (!policy.armed) {
		throw new DispatchError('forbidden', DISARMED_DISPATCH_MESSAGE);
	}
	const intent = payloadIntent(record.payload);
	if (!operationAllowed(policy.allow, record.operation, intent)) {
		throw new DispatchError('forbidden', deniedOperationMessage(record.operation, intent));
	}
	if (record.operation === 'loop') {
		// A follow-up would start a one-shot agent in the loop's checkout,
		// outside ralph. Loops have their own controls (ADR-0019 rule 5).
		throw new DispatchError('conflict', LOOP_FOLLOW_UP_MESSAGE);
	}
	if (record.agent_id === undefined) {
		throw new DispatchError('conflict', MISSION_NOT_LAUNCHED_MESSAGE);
	}

	const provider = requireRecordProvider(record, deps);
	const createRun = provider.createRun;
	if (createRun === undefined) {
		throw new DispatchError('forbidden', `${provider.label} does not support follow-up.`);
	}
	let current = record;
	if (isFollowableStatus(current.status)) {
		try {
			current = await refreshDispatchRecord(current, store, provider, deps);
		} catch {
			current = record;
		}
	}
	if (isFollowableStatus(current.status)) {
		throw new DispatchError('conflict', AGENT_BUSY_MESSAGE);
	}
	if (!isTerminalDispatchStatus(current.status) || current.agent_id === undefined) {
		throw new DispatchError('conflict', MISSION_NOT_LAUNCHED_MESSAGE);
	}

	const created = await createRun(current.agent_id, text);
	const resumed = await store.startFollowUp(current.id, {
		run_id: created.run_id,
		status: 'launched'
	});
	if (resumed === undefined) {
		throw new DispatchError('conflict', AGENT_BUSY_MESSAGE);
	}
	try {
		await store.appendTurn(resumed.id, { role: 'operator', text, run_id: created.run_id });
	} catch {
		// The follow-up is durable; only the transcript misses the message.
	}
	try {
		scheduleFollower(resumed, store, provider, deps);
	} catch {
		// Follow-up remains durable if this process cannot schedule.
	}
	return toPublicDispatch(resumed);
}

/**
 * A working loop mission, refreshed and with its run id, for a loop control.
 * Refuses a mission that is not a loop, has not launched, or has ended.
 */
async function workingLoop(
	project_id: string,
	request_id: string,
	store: DispatchStore,
	deps: DispatchDeps
): Promise<{ record: DispatchRecord; provider: AgentProvider } | undefined> {
	const record = await loadOwnedRecord(project_id, request_id, store);
	if (record === undefined) {
		return undefined;
	}
	if (record.operation !== 'loop') {
		throw new DispatchError('conflict', NOT_A_LOOP_MESSAGE);
	}
	if (record.agent_id === undefined) {
		throw new DispatchError('conflict', MISSION_NOT_LAUNCHED_MESSAGE);
	}
	const provider = requireRecordProvider(record, deps);
	let current = record;
	if (isFollowableStatus(current.status)) {
		try {
			current = await refreshDispatchRecord(current, store, provider, deps);
		} catch {
			current = record;
		}
	}
	if (!isFollowableStatus(current.status)) {
		throw new DispatchError('conflict', LOOP_NOT_RUNNING_MESSAGE);
	}
	current = await resolveRunId(current, store, provider);
	if (current.agent_id === undefined || current.run_id === undefined) {
		throw new DispatchError('conflict', LOOP_NOT_RUNNING_MESSAGE);
	}
	return { record: current, provider };
}

/**
 * Steer a working loop (ADR-0019 rules 3 and 5): queue a note that ralph
 * adds to its next iteration's prompt. The note is the only thing the
 * browser sends; it is kept in the transcript as an operator turn. Like a
 * follow-up it puts words in front of an agent, so it needs dispatch armed
 * and the loop's operation still allowed for the project.
 */
export async function steerDispatch(
	project_id: string,
	request_id: string,
	text: string,
	deps: DispatchDeps = {}
): Promise<ReturnType<typeof toPublicDispatch> | undefined> {
	await requireConfigured(deps);
	const store = deps.store ?? (await getDispatchStore());
	const found = await workingLoop(project_id, request_id, store, deps);
	if (found === undefined) {
		return undefined;
	}
	const { record, provider } = found;
	const policy = await resolvePolicy(record.project_id, deps);
	if (!policy.armed) {
		throw new DispatchError('forbidden', DISARMED_DISPATCH_MESSAGE);
	}
	if (!operationAllowed(policy.allow, record.operation, payloadIntent(record.payload))) {
		throw new DispatchError('forbidden', deniedOperationMessage(record.operation));
	}
	const steerRun = provider.steerRun;
	if (steerRun === undefined) {
		throw new DispatchError('forbidden', `${provider.label} cannot steer loops.`);
	}
	await steerRun(record.agent_id!, record.run_id!, text);
	try {
		await store.appendTurn(record.id, { role: 'operator', text, run_id: record.run_id });
	} catch {
		// ralph has the note; only the transcript misses it.
	}
	return toPublicDispatch((await store.get(record.id)) ?? record);
}

/**
 * Ask a working loop to stop once its current iteration ends (ralph's
 * graceful stop). Like cancel it only ever ends work, so a disarmed service
 * still takes it. Stopping now is `cancelDispatch`.
 */
export async function stopDispatchAfterIteration(
	project_id: string,
	request_id: string,
	deps: DispatchDeps = {}
): Promise<ReturnType<typeof toPublicDispatch> | undefined> {
	await requireConfigured(deps);
	const store = deps.store ?? (await getDispatchStore());
	const found = await workingLoop(project_id, request_id, store, deps);
	if (found === undefined) {
		return undefined;
	}
	const { record, provider } = found;
	if (record.loop_stop_requested === true) {
		return toPublicDispatch(record);
	}
	const stopRunAfterIteration = provider.stopRunAfterIteration;
	if (stopRunAfterIteration === undefined) {
		throw new DispatchError('forbidden', `${provider.label} cannot stop loops gracefully.`);
	}
	try {
		await stopRunAfterIteration(record.agent_id!, record.run_id!);
	} catch (error) {
		if (error instanceof DispatchError && error.code === 'conflict') {
			// It ended on its own meanwhile: report how, not a refusal.
			const refreshed = await refreshDispatchRecord(record, store, provider, deps).catch(
				() => undefined
			);
			if (refreshed !== undefined && isTerminalDispatchStatus(refreshed.status)) {
				return toPublicDispatch(refreshed);
			}
		}
		throw error;
	}
	const marked = await store.markLoopStopRequested(record.id);
	return toPublicDispatch(marked ?? { ...record, loop_stop_requested: true });
}

/**
 * The operator turn a restart adds: what it asked for, so the transcript
 * shows where one run ends and the next begins.
 */
export function restartTurnText(max_iterations: number | undefined): string {
	return max_iterations === undefined
		? 'Restart the loop.'
		: `Restart the loop for up to ${max_iterations} ${max_iterations === 1 ? 'iteration' : 'iterations'}.`;
}

/**
 * Start a new run of an ended loop on the same mission (ADR-0019 rules 2
 * and 5): the loop's stored flags, with an optional new iteration limit for
 * this run only (the launch payload stays as launched, so a replayed launch
 * still matches its idempotency key). Like a launch it starts work, so it
 * needs dispatch armed and Tackle allowed, and it reads the project's
 * current Tackle checkout in case the runner needs a fresh sandbox.
 *
 * The mission is claimed (`launching`) before the runner is asked, so two
 * restarts cannot both start one, and no status read follows the old run's
 * ids while the new run's are not known yet. A refusal from the runner
 * leaves the mission failed with its reason, and is rethrown.
 */
export async function restartDispatch(
	project_id: string,
	request_id: string,
	options: { max_iterations?: number },
	deps: DispatchDeps = {}
): Promise<ReturnType<typeof toPublicDispatch> | undefined> {
	await requireConfigured(deps);
	const store = deps.store ?? (await getDispatchStore());
	const record = await loadOwnedRecord(project_id, request_id, store);
	if (record === undefined) {
		return undefined;
	}
	if (record.payload.operation !== 'loop') {
		throw new DispatchError('conflict', RESTART_NOT_A_LOOP_MESSAGE);
	}
	const policy = await resolvePolicy(record.project_id, deps);
	if (!policy.armed) {
		throw new DispatchError('forbidden', DISARMED_DISPATCH_MESSAGE);
	}
	if (!operationAllowed(policy.allow, record.operation, payloadIntent(record.payload))) {
		throw new DispatchError('forbidden', deniedOperationMessage(record.operation));
	}
	if (record.agent_id === undefined) {
		throw new DispatchError('conflict', MISSION_NOT_LAUNCHED_MESSAGE);
	}
	const provider = requireRecordProvider(record, deps);
	const restartLoop = provider.restartLoop;
	if (restartLoop === undefined) {
		throw new DispatchError('forbidden', `${provider.label} cannot restart loops.`);
	}

	let current = record;
	if (isFollowableStatus(current.status)) {
		try {
			current = await refreshDispatchRecord(current, store, provider, deps);
		} catch {
			current = record;
		}
	}
	if (!isTerminalDispatchStatus(current.status)) {
		throw new DispatchError('conflict', LOOP_STILL_RUNNING_MESSAGE);
	}
	current = await resolveRunId(current, store, provider);
	const agent_id = current.agent_id;
	const after_run_id = current.run_id;
	if (agent_id === undefined || after_run_id === undefined) {
		throw new DispatchError('conflict', MISSION_NOT_LAUNCHED_MESSAGE);
	}

	const plan = await planLaunch(current, deps);
	if (!plan.ok) {
		throw new DispatchError('conflict', plan.error_message);
	}
	if (plan.loop === undefined) {
		throw new DispatchError('conflict', RESTART_NOT_A_LOOP_MESSAGE);
	}
	const input =
		options.max_iterations === undefined
			? plan.loop
			: { ...plan.loop, loop: { ...plan.loop.loop, max_iterations: options.max_iterations } };

	const claimed = await store.startFollowUp(current.id, {
		run_id: after_run_id,
		status: 'launching'
	});
	if (claimed === undefined) {
		throw new DispatchError('conflict', LOOP_STILL_RUNNING_MESSAGE);
	}
	try {
		await store.appendTurn(claimed.id, {
			role: 'operator',
			text: restartTurnText(options.max_iterations)
		});
	} catch {
		// The transcript is display state; the restart does not depend on it.
	}

	let restarted;
	try {
		restarted = await restartLoop(agent_id, after_run_id, input);
	} catch (error) {
		const message =
			error instanceof DispatchError
				? error.message
				: `${provider.label} could not restart the loop.`;
		const failed = await store.updateStatus(claimed.id, {
			status: 'failed',
			error_message: message
		});
		await appendAgentTurn(store, claimed.id, undefined, 'failed', { error_message: message });
		await markChatToldAtLaunch(store, failed);
		throw error instanceof DispatchError ? error : new DispatchError('unavailable', message);
	}

	const saved = await store.updateStatus(claimed.id, {
		status: 'launched',
		agent_id: restarted.agent_id,
		run_id: restarted.run_id
	});
	const launched = saved ?? {
		...claimed,
		status: 'launched' as const,
		agent_id: restarted.agent_id,
		run_id: restarted.run_id
	};
	try {
		scheduleFollower(launched, store, provider, deps);
	} catch {
		// The new run is durable even if this process cannot schedule.
	}
	return toPublicDispatch(launched);
}

function storedMissionEvent(record: DispatchRecord): MissionEvent | undefined {
	if (
		record.status !== 'succeeded' &&
		record.status !== 'cancelled' &&
		record.status !== 'failed'
	) {
		return undefined;
	}
	return encodeMissionEvent({
		type: 'result',
		id: 'stored-result',
		status: record.status,
		text: record.result_summary ?? (record.status === 'failed' ? record.error_message : undefined),
		duration_ms: record.duration_ms,
		git_pr_url: record.git_pr_url
	});
}

export type StreamDispatchEventsOutcome = AgentStreamOutcome | 'not_found' | 'not_launched';

/**
 * Proxy a provider's live events onto the canonical MissionEvent union.
 * Reconstructs a terminal result from the durable row when the provider has
 * no live events or its stream has expired.
 */
export async function streamDispatchMissionEvents(
	project_id: string,
	request_id: string,
	on_event: (event: MissionEvent) => Promise<void>,
	deps: DispatchDeps & { last_event_id?: string; signal?: AbortSignal } = {}
): Promise<StreamDispatchEventsOutcome> {
	const store = deps.store ?? (await getDispatchStore());
	const record = await store.get(request_id);
	if (record === undefined || record.project_id !== project_id) {
		return 'not_found';
	}
	if (record.agent_id === undefined) {
		return 'not_launched';
	}
	const provider = providerForRecord(record, deps);
	let resolved = record;
	if (provider !== undefined) {
		try {
			resolved = await resolveRunId(record, store, provider);
		} catch {
			resolved = record;
		}
	}
	if (resolved.agent_id === undefined || resolved.run_id === undefined) {
		const stored = storedMissionEvent(resolved);
		if (stored !== undefined) {
			await on_event(stored);
			return 'terminal';
		}
		return 'not_launched';
	}

	let outcome: StreamDispatchEventsOutcome = 'disconnected';
	// Providers without live events still deliver the stored terminal result.
	if (provider?.streamMissionEvents !== undefined) {
		try {
			outcome = await provider.streamMissionEvents(resolved.agent_id, resolved.run_id, on_event, {
				last_event_id: deps.last_event_id,
				signal: deps.signal
			});
		} catch {
			outcome = 'disconnected';
		}
	}
	if (outcome === 'terminal') {
		return outcome;
	}
	const latest = (await store.get(resolved.id)) ?? resolved;
	const stored = storedMissionEvent(latest);
	if (stored !== undefined) {
		await on_event(stored);
		return 'terminal';
	}
	return outcome;
}

export const NO_TERMINAL_RELAY_MESSAGE = "This mission's agent runner has no terminal to open.";

/**
 * Attach the admin relay to a mission's agent terminal (ADR-0021 rule 4).
 * The browser names only the mission; the provider resolves its sandbox and
 * terminal. Refusals are `TerminalRelayError`s whose messages may be shown.
 */
export async function attachDispatchTerminal(
	request_id: string,
	request: TerminalAttachRequest,
	deps: DispatchDeps = {}
): Promise<TerminalRelay> {
	const store = deps.store ?? (await getDispatchStore());
	const record = await store.get(request_id);
	if (record === undefined) throw new TerminalRelayError('not_found', 'mission not found');
	if (record.agent_id === undefined) {
		throw new TerminalRelayError('conflict', MISSION_NOT_LAUNCHED_MESSAGE);
	}
	const provider = providerForRecord(record, deps);
	if (provider?.attachTerminal === undefined) {
		throw new TerminalRelayError('conflict', NO_TERMINAL_RELAY_MESSAGE);
	}
	try {
		return await provider.attachTerminal(record.agent_id, request);
	} catch (error) {
		if (error instanceof TerminalRelayError) throw error;
		throw new TerminalRelayError('unavailable', RELAY_UNAVAILABLE_MESSAGE);
	}
}

/** Recent File/Tackle runs for the fleet view or an issue's linked missions. */
export async function listMissions(
	filter: ListDispatchFilter,
	deps: { store?: DispatchStore; project_names?: ReadonlyMap<string, string> } = {}
): Promise<Mission[]> {
	const store = deps.store ?? (await getDispatchStore());
	const records = await store.list(filter);
	return records.map((record) => {
		const project_name = deps.project_names?.get(record.project_id) ?? record.dolt_database;
		return toPublicMission(record, project_name);
	});
}

/**
 * The conversation for one mission: what the operator asked and each finished
 * run's reply. Missions from before turns were recorded get a two-turn
 * transcript rebuilt from the durable row. Never the launch prompt.
 */
export async function listDispatchTurns(
	project_id: string,
	request_id: string,
	deps: { store?: DispatchStore } = {}
): Promise<DispatchTurn[] | undefined> {
	const store = deps.store ?? (await getDispatchStore());
	const record = await loadOwnedRecord(project_id, request_id, store);
	if (record === undefined) {
		return undefined;
	}
	const turns = await store.listTurns(record.id);
	if (turns.length > 0) {
		return turns;
	}
	const rebuilt: DispatchTurn[] = [
		{
			seq: 0,
			role: 'operator',
			text: operatorTurnText(record.payload),
			created_at: record.created_at
		}
	];
	if (isTerminalDispatchStatus(record.status)) {
		const status = record.status as 'succeeded' | 'cancelled' | 'failed';
		rebuilt.push({
			seq: 1,
			role: 'agent',
			text: agentTurnText(status, record),
			run_id: record.run_id,
			status,
			created_at: record.updated_at
		});
	}
	return rebuilt;
}

/**
 * A loop mission's finished iterations across its runs, oldest first
 * (ADR-0019 rule 5). Any other mission has none. Undefined when the mission
 * is not this project's.
 */
export async function listLoopIterations(
	project_id: string,
	request_id: string,
	deps: { store?: DispatchStore } = {}
): Promise<LoopIteration[] | undefined> {
	const store = deps.store ?? (await getDispatchStore());
	const record = await loadOwnedRecord(project_id, request_id, store);
	if (record === undefined) {
		return undefined;
	}
	return record.operation === 'loop' ? store.listLoopIterations(record.id) : [];
}
