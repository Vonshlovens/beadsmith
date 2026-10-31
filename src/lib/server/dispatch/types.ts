import type {
	DiscussIntent,
	DispatchOperation,
	DispatchProviderId,
	DispatchStatus
} from '$lib/types.js';
import type { StatusKey } from '$lib/client/format.js';

/** Validated File payload stored on the dispatch record. */
export interface FilePayload {
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
export interface TacklePayload {
	operation: 'tackle';
	issue_id: string;
	title?: string;
	description?: string;
	/** Present when the board confirm modal requested a destination other than start-work. */
	destination_status?: TackleDestinationStatus;
}

/** Validated human-comment payload stored on the dispatch record. */
export interface CommentPayload {
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
export interface DiscussPayload {
	operation: 'discuss';
	issue_id: string;
	intent: DiscussIntent;
	message?: string;
	title?: string;
	description?: string;
}

export type DispatchPayload = FilePayload | TacklePayload | CommentPayload | DiscussPayload;

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
	created_at: string;
	updated_at: string;
}

export class DispatchError extends Error {
	readonly code: 'unavailable' | 'conflict' | 'forbidden';

	constructor(code: 'unavailable' | 'conflict' | 'forbidden', message: string) {
		super(message);
		this.name = 'DispatchError';
		this.code = code;
	}
}
