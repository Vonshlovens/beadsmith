import type { DispatchTurn, IssueDetail, Mission, Project } from '$lib/types.js';
import type { MissionEvent } from '$lib/mission-events.js';
import { encodeMissionEvent } from '$lib/mission-events.js';
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
	RUN_NOT_CANCELLABLE_MESSAGE,
	type AgentLaunchInput,
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
import { DispatchError, type DispatchPayload, type DispatchRecord } from './types.js';
import type { DispatchStore, ListDispatchFilter } from './store.js';

export interface EnqueueDispatchInput {
	idempotency_key: string;
	project: Project;
	actor: string;
	payload: DispatchPayload;
	issue?: IssueDetail;
}

export interface DispatchDeps {
	store?: DispatchStore;
	/** Dispatch provider; defaults to the configured one. */
	provider?: AgentProvider;
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
}

const NOT_CONFIGURED_MESSAGE = 'Agent dispatch is not configured on this service.';
export const MISSION_NOT_LAUNCHED_MESSAGE = 'This mission has not launched an agent yet.';

/** The configured provider, honouring test injection. */
function resolveProvider(deps: DispatchDeps): AgentProvider | undefined {
	if (deps.provider !== undefined) return deps.provider;
	return getAgentProvider();
}

function requireProvider(deps: DispatchDeps): AgentProvider {
	const provider = resolveProvider(deps);
	if (provider === undefined) throw new DispatchError('forbidden', NOT_CONFIGURED_MESSAGE);
	return provider;
}

/**
 * The provider that launched this mission, if it is still the configured
 * one. Rows without a known provider came from one this build no longer has.
 */
function providerForRecord(record: DispatchRecord, deps: DispatchDeps): AgentProvider | undefined {
	const provider = resolveProvider(deps);
	if (provider === undefined) return undefined;
	return record.provider === provider.id ? provider : undefined;
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
export { AGENT_BUSY_MESSAGE, RUN_NOT_CANCELLABLE_MESSAGE };
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
	update: AgentRunUpdate
): Promise<DispatchRecord | undefined> {
	const saved = await store.updateStatus(request_id, {
		status: update.status,
		result_summary: update.result_summary,
		duration_ms: update.duration_ms,
		git_pr_url: update.git_pr_url,
		error_message: update.error_message
	});
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
	}
	return saved;
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

/** What the operator asked for, in words, as the first turn of a mission. */
export function operatorTurnText(payload: DispatchPayload): string {
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
	provider: AgentProvider
): Promise<DispatchRecord> {
	const resolved = await resolveRunId(record, store, provider);
	if (resolved.agent_id === undefined || resolved.run_id === undefined) {
		return resolved;
	}
	const update = await provider.getRun(resolved.agent_id, resolved.run_id);
	return (
		(await persistRunUpdate(store, resolved.id, resolved.run_id, update)) ?? {
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
					await persistRunUpdate(store, resolved.id, run_id, update);
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
			await persistRunUpdate(store, resolved.id, run_id, update);
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
		error_message: record.status === 'failed' ? record.error_message : undefined
	};
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
 * Persist a File/Tackle/comment/discuss intent, then launch an agent.
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
		payload: enrichPayload(input.payload, input.issue)
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
		return {
			request: toPublicDispatch(failed ?? { ...working, status: 'failed' }),
			created: true
		};
	}

	let provider: AgentProvider | undefined;
	try {
		provider = requireProvider(deps);
		const launched = await provider.launch(plan.input);
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

async function planLaunch(
	record: DispatchRecord,
	deps: DispatchDeps
): Promise<{ ok: true; input: AgentLaunchInput } | { ok: false; error_message: string }> {
	const name = buildDispatchAgentName(record);
	const prompt = buildDispatchPrompt(record);
	if (record.operation === 'file') {
		const checkout = await resolveFileCheckout(record.project_id, deps);
		if (checkout.kind === 'invalid') {
			return { ok: false, error_message: INVALID_FILE_CHECKOUT_MESSAGE };
		}
		if (checkout.kind === 'none') {
			return { ok: true, input: { name, prompt, auto_create_pr: false } };
		}
		return {
			ok: true,
			input: {
				name,
				prompt,
				auto_create_pr: false,
				repository: { url: checkout.mapping.url, starting_ref: checkout.mapping.ref }
			}
		};
	}

	if (record.operation === 'discuss') {
		return {
			ok: true,
			input: { name, prompt, auto_create_pr: false, ...(await discussCheckout(record, deps)) }
		};
	}

	if (record.operation !== 'tackle') {
		return { ok: true, input: { name, prompt, auto_create_pr: false } };
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
			auto_create_pr,
			repository: { url: mapping.url, starting_ref: mapping.ref }
		}
	};
}

/**
 * A discussion reads the project's Tackle checkout when one is mapped, so the
 * agent can look at the code it is asked about. It never opens a pull
 * request, and an unmapped or invalid map just launches without a checkout.
 */
async function discussCheckout(
	record: DispatchRecord,
	deps: DispatchDeps
): Promise<Pick<AgentLaunchInput, 'repository'>> {
	try {
		const resolved = await resolveLaunchMaps(deps);
		const mapping = resolved.invalid ? undefined : resolved.mappings[record.project_id];
		return mapping === undefined
			? {}
			: { repository: { url: mapping.url, starting_ref: mapping.ref } };
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
			current = await refreshDispatchRecord(record, store, provider);
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
			current = await refreshDispatchRecord(current, store, provider);
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
				current = await refreshDispatchRecord(current, store, provider);
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
		current = await refreshDispatchRecord(current, store, provider);
	} catch {
		const cancelled = await store.updateStatus(current.id, { status: 'cancelled' });
		await appendAgentTurn(store, current.id, current.run_id, 'cancelled', {});
		return toPublicDispatch(cancelled ?? { ...current, status: 'cancelled' });
	}
	if (!isTerminalDispatchStatus(current.status)) {
		const cancelled = await store.updateStatus(current.id, { status: 'cancelled' });
		await appendAgentTurn(store, current.id, current.run_id, 'cancelled', {});
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
			current = await refreshDispatchRecord(current, store, provider);
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
