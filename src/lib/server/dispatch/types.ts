import type {
	DiscussIntent,
	DispatchOperation,
	DispatchProviderId,
	DispatchStatus
} from '#lib/types.js';
import type { StatusKey } from '#lib/client/format.js';
import type { RalphHarness, RalphMode } from '#lib/ralph.js';
import type { LoopEnd } from './provider.js';

/**
 * The model and reasoning effort a launch asked for. Each is one of the
 * operator's choices (`BDX_AGENT_MODELS`, `BDX_AGENT_EFFORTS`), checked when
 * the mission is created; absent means the runner's default.
 */
export interface AgentChoice {
	model?: string;
	effort?: string;
}

/** Validated File payload stored on the dispatch record. */
export interface FilePayload extends AgentChoice {
	operation: 'file';
	notes: string;
	title?: string;
	issue_type?: string;
	priority?: number;
	labels?: string[];
	status?: StatusKey;
}

/** Board column a Tackle-family launch is aiming at. Omitted = /tackle (start work). */
export type TackleDestinationStatus = 'open' | 'in_progress' | 'blocked' | 'deferred' | 'closed';

/** Validated Tackle payload stored on the dispatch record. */
export interface TacklePayload extends AgentChoice {
	operation: 'tackle';
	issue_id: string;
	title?: string;
	description?: string;
	/** Present when the board confirm modal requested a destination other than start-work. */
	destination_status?: TackleDestinationStatus;
}

/** Validated human-comment payload stored on the dispatch record. */
export interface CommentPayload extends AgentChoice {
	operation: 'comment';
	issue_id: string;
	text: string;
	author: string;
	title?: string;
}

/**
 * Validated agent-conversation payload. The operator's
 * optional message steers the run; the agent does any Beads change with bd.
 */
export interface DiscussPayload extends AgentChoice {
	operation: 'discuss';
	issue_id: string;
	intent: DiscussIntent;
	message?: string;
	title?: string;
	description?: string;
}

/**
 * Validated ralph loop payload (ADR-0019 rule 5): the flags of one
 * `ralph <mode>` run. The loop works on the project's whole plan, or on one
 * bead when `issue_id` is set (rule 6); epic and label scope wait for ralph's
 * per-run scope. Everything else (prompts, validation, limits) comes from the
 * checkout's own `.ralph/` configuration, which Beadsmith never edits.
 */
export interface LoopPayload extends AgentChoice {
	operation: 'loop';
	mode: RalphMode;
	/** What a `run` loop does each iteration; only `run` takes one. */
	prompt?: string;
	/** The one bead a `build` or `run` loop works on; absent = the project's plan. */
	issue_id?: string;
	harness?: RalphHarness;
	max_iterations?: number;
	iteration_timeout_minutes?: number;
	/** The bead's title, recorded at launch for display. */
	title?: string;
}

export type DispatchPayload =
	FilePayload | TacklePayload | CommentPayload | DiscussPayload | LoopPayload;

/** Internal row including fields that never leave the control plane. */
export interface DispatchRecord {
	id: string;
	idempotency_key: string;
	project_id: string;
	dolt_database: string;
	operation: DispatchOperation;
	actor: string;
	payload: DispatchPayload;
	status: DispatchStatus;
	/**
	 * Provider that launched the agent; absent before launch and on rows from
	 * a provider this build no longer has.
	 */
	provider?: DispatchProviderId;
	agent_id?: string;
	agent_url?: string;
	run_id?: string;
	error_message?: string;
	result_summary?: string;
	duration_ms?: number;
	git_pr_url?: string;
	/** First Mate chat whose crew tool launched it (ADR-0020 rule 5). */
	chat_id?: string;
	/**
	 * The outcome last reported to that chat (`chatNoticeKey`), so each run's
	 * outcome is told once, across restarts.
	 */
	chat_notice?: string;
	/** A loop's current run has ended and why; absent while it runs (ADR-0019 rule 4). */
	loop_end?: LoopEnd;
	/** An operator asked the current loop run to stop after its iteration. */
	loop_stop_requested?: boolean;
	created_at: string;
	updated_at: string;
}

export class DispatchError extends Error {
	readonly code: 'unavailable' | 'conflict' | 'forbidden' | 'bad_request';

	constructor(code: 'unavailable' | 'conflict' | 'forbidden' | 'bad_request', message: string) {
		super(message);
		this.name = 'DispatchError';
		this.code = code;
	}
}
