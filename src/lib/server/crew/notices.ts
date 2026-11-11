/**
 * Crew notices (ADR-0020 rule 5): when a mission a chat launched finishes,
 * Beadsmith tells that chat's agent in one short system-authored message, so
 * First Mate reports back without being asked.
 *
 * Exactly once per outcome, with two guards:
 * - the mission row records the outcome its chat was last told
 *   (`chat_notice`, see `chatNoticeKey`), so an outcome observed twice, by
 *   the follower and a page refresh or after a restart, is skipped;
 * - the message id is derived from the mission and outcome, and runners drop
 *   a repeat of a message id, so two observers racing past the first guard
 *   still reach the agent once.
 *
 * A notice that cannot be delivered (no runner, runner down) stays due: the
 * next transition retries it, and so does opening the chat
 * (`deliverDueCrewNotices`). Dispatch never waits on or fails because of a
 * notice.
 */
import { createHash } from 'node:crypto';
import { CREW_NOTICE_PREFIX } from '#lib/mate.js';
import type { DispatchOperation } from '#lib/types.js';
import { chatNoticeKey, type DispatchStore } from '../dispatch/store.js';
import type { DispatchRecord } from '../dispatch/types.js';
import { MateRunnerError, type MateRunner } from '../mate/runner.js';
import type { MateStore, StoredMateChat } from '../mate/store.js';

/** How much of a mission's summary or error a notice quotes. */
export const NOTICE_EXCERPT_CHARS = 280;
/** Due notices one chat open delivers at most. */
const MAX_DUE_PER_OPEN = 20;

const OPERATION_LABEL: Record<DispatchOperation, string> = {
	file: 'File',
	tackle: 'Tackle',
	comment: 'Comment',
	discuss: 'Discuss',
	loop: 'Loop'
};

export interface CrewNoticeDeps {
	dispatch: DispatchStore;
	mate: MateStore;
	/** The runner a chat's agent runs on; undefined when it is not configured. */
	runnerFor: (chat: StoredMateChat) => MateRunner | undefined;
	log?: (message: string) => void;
}

export type CrewNoticeOutcome =
	/** Sent to the chat's agent now. */
	| 'sent'
	/** Nothing to tell: no chat, still working, or already told. */
	| 'skipped'
	/**
	 * The chat is gone, its owner is banned, or the runner already has it;
	 * marked told so it stops being due.
	 */
	| 'dropped'
	/** The runner could not take it; it stays due. */
	| 'deferred';

/** The notice's message id: stable for one mission outcome, so runners drop a repeat. */
export function crewNoticeMessageId(record: Pick<DispatchRecord, 'id'>, key: string): string {
	const digest = createHash('sha256').update(`${record.id}\n${key}`).digest('hex');
	return `${CREW_NOTICE_PREFIX}${digest.slice(0, 40)}`;
}

function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The notice text: what finished, how, and the mission id the agent can look
 * up with `show_mission`. It ends with an instruction to report back, because
 * the agent reads it as a message in its conversation.
 */
export function crewNoticeText(record: DispatchRecord): string {
	const operation = OPERATION_LABEL[record.operation] ?? record.operation;
	const issue = 'issue_id' in record.payload ? record.payload.issue_id : undefined;
	const subject =
		issue === undefined
			? `${operation} in ${record.project_id}`
			: `${operation} on ${issue} (${record.project_id})`;
	const parts = [`[crew] ${subject} ${record.status}.`];
	if (record.git_pr_url !== undefined) {
		parts.push(`PR: ${record.git_pr_url}.`);
	}
	const detail = record.status === 'failed' ? record.error_message : record.result_summary;
	if (detail !== undefined && detail.trim() !== '') {
		parts.push(`Summary: ${oneLine(detail, NOTICE_EXCERPT_CHARS)}`);
	}
	parts.push(`Mission ${record.id} (show_mission has the details). Tell the captain.`);
	return parts.join(' ');
}

/** Notices in flight in this process, so two observers do not both send. */
const in_flight = new Set<string>();

/**
 * Tell a mission's chat its current outcome, once. Safe to call on every
 * observed transition; never throws.
 */
export async function deliverCrewNotice(
	record: DispatchRecord,
	deps: CrewNoticeDeps
): Promise<CrewNoticeOutcome> {
	const key = chatNoticeKey(record);
	if (record.chat_id === undefined || key === undefined || record.chat_notice === key) {
		return 'skipped';
	}
	const message_id = crewNoticeMessageId(record, key);
	if (in_flight.has(message_id)) return 'skipped';
	in_flight.add(message_id);
	try {
		const chat = await deps.mate.noticeChat(record.chat_id);
		if (chat === undefined) {
			await deps.dispatch.markChatNotice(record.id, key);
			return 'dropped';
		}
		const runner = deps.runnerFor(chat);
		if (runner === undefined) return 'deferred';
		await runner.sendMessage(chat.id, {
			session_id: chat.session_id,
			message_id,
			prompt: crewNoticeText(record),
			scope: chat.scope,
			model: chat.model,
			effort: chat.effort
		});
		await deps.dispatch.markChatNotice(record.id, key);
		return 'sent';
	} catch (error) {
		if (error instanceof MateRunnerError && error.code === 'conflict') {
			// The runner already holds this message id (an earlier wording of the
			// same outcome) or the chat moved to another session: either way,
			// sending again cannot help.
			try {
				await deps.dispatch.markChatNotice(record.id, key);
			} catch {
				// Stays due; the next attempt meets the same conflict.
			}
			return 'dropped';
		}
		deps.log?.(
			`crew notice for mission ${record.id} deferred: ${error instanceof Error ? error.message : 'unknown error'}`
		);
		return 'deferred';
	} finally {
		in_flight.delete(message_id);
	}
}

/**
 * Deliver every notice a chat is still owed, oldest first: the retry for
 * notices whose runner was unavailable when the mission finished.
 */
export async function deliverDueCrewNotices(
	chat_id: string,
	deps: CrewNoticeDeps
): Promise<CrewNoticeOutcome[]> {
	let due: DispatchRecord[];
	try {
		due = await deps.dispatch.listChatNoticesDue(chat_id, MAX_DUE_PER_OPEN);
	} catch {
		return [];
	}
	const outcomes: CrewNoticeOutcome[] = [];
	for (const record of due) {
		const outcome = await deliverCrewNotice(record, deps);
		outcomes.push(outcome);
		// The runner is down: the rest would only fail the same way.
		if (outcome === 'deferred') break;
	}
	return outcomes;
}

/** Production dependencies: `state.db` and the configured chat runners. */
export async function defaultCrewNoticeDeps(): Promise<CrewNoticeDeps> {
	const [{ getDispatchStore, getMateStore }, { getMateRunner }] = await Promise.all([
		import('../state/db.js'),
		import('../mate/runner.js')
	]);
	return {
		dispatch: await getDispatchStore(),
		mate: await getMateStore(),
		runnerFor: (chat) => getMateRunner(chat.runner),
		log: (message) => console.warn(message)
	};
}
