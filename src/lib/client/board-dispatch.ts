/**
 * Board drag is an agent-dispatch intent, not a status write.
 *
 * Pointer drops and keyboard moves share this destination → skill map and
 * confirm copy. The card stays in its source column until Beads changes.
 */
import { STATUS_KEYS, statusLabel, type StatusKey } from './format.js';
import type { IssueSummary } from '$lib/types';

/** Destinations that can enqueue an agent from the board. */
export const BOARD_DISPATCH_DESTINATIONS = [
	'open',
	'in_progress',
	'blocked',
	'deferred',
	'closed'
] as const;

export type BoardDispatchDestination = (typeof BOARD_DISPATCH_DESTINATIONS)[number];

/** MIME type for a board card drag payload. */
export const BOARD_CARD_MIME = 'application/x-beads-board-card';

/** JSON stored on a card drag. */
export interface BoardCardDragPayload {
	issue_id: string;
	source_status: StatusKey;
}

/** Proposed agent work for one destination column. */
export interface BoardDispatchAction {
	destination: BoardDispatchDestination;
	skill: 'tackle' | 'close' | 'block' | 'defer' | 'unclaim';
	confirm_title: string;
	confirm_question: string;
	confirm_button: string;
}

export interface BoardDispatchPending {
	issue: IssueSummary;
	source_status: StatusKey;
	action: BoardDispatchAction;
}

export type BoardDropIntent =
	{ kind: 'noop' } | { kind: 'unsupported' } | { kind: 'dispatch'; action: BoardDispatchAction };

const ACTIONS: Record<BoardDispatchDestination, BoardDispatchAction> = {
	in_progress: {
		destination: 'in_progress',
		skill: 'tackle',
		confirm_title: 'Send to an agent',
		confirm_question: 'Send this to an agent with /tackle?',
		confirm_button: 'Launch tackling agent'
	},
	closed: {
		destination: 'closed',
		skill: 'close',
		confirm_title: 'Ask an agent to close',
		confirm_question: 'Ask an agent to check whether this work is finished and close it?',
		confirm_button: 'Launch closing agent'
	},
	blocked: {
		destination: 'blocked',
		skill: 'block',
		confirm_title: 'Ask an agent about blockers',
		confirm_question: 'Ask an agent to investigate blockers?',
		confirm_button: 'Launch blocking agent'
	},
	deferred: {
		destination: 'deferred',
		skill: 'defer',
		confirm_title: 'Ask an agent to defer',
		confirm_question: 'Ask an agent to defer / park this issue?',
		confirm_button: 'Launch deferring agent'
	},
	open: {
		destination: 'open',
		skill: 'unclaim',
		confirm_title: 'Ask an agent to unclaim',
		confirm_question: 'Ask an agent to stop/unclaim and return this to the ready queue?',
		confirm_button: 'Launch unclaim agent'
	}
};

/**
 * Whether a status column can receive a board dispatch drop.
 *
 * @param status - Candidate destination.
 */
export function isBoardDispatchDestination(status: string): status is BoardDispatchDestination {
	return (BOARD_DISPATCH_DESTINATIONS as readonly string[]).includes(status);
}

/**
 * Destination → agent action for a droppable column.
 *
 * @param destination - Column the card was dropped on.
 */
export function boardDispatchAction(destination: StatusKey): BoardDispatchAction | undefined {
	if (!isBoardDispatchDestination(destination)) {
		return undefined;
	}
	return ACTIONS[destination];
}

/**
 * Destinations a keyboard or menu path may propose for one source card.
 *
 * Same map as a drop: current status is omitted, pinned/hooked are never
 * offered. Hidden columns still appear here so a filtered board is not a
 * keyboard dead end.
 *
 * @param source - Status the focused card currently has.
 */
export function keyboardDispatchChoices(source: StatusKey): BoardDispatchAction[] {
	const choices: BoardDispatchAction[] = [];
	for (const destination of BOARD_DISPATCH_DESTINATIONS) {
		const intent = boardDropIntent(source, destination);
		if (intent.kind === 'dispatch') {
			choices.push(intent.action);
		}
	}
	return choices;
}

/**
 * Classify a board drop. Same-column is always a no-op. pinned/hooked are not
 * drop targets until a skill exists.
 *
 * @param source - Status the card currently has.
 * @param destination - Column it was dropped on.
 */
export function boardDropIntent(source: StatusKey, destination: StatusKey): BoardDropIntent {
	if (source === destination) {
		return { kind: 'noop' };
	}
	const action = boardDispatchAction(destination);
	if (action === undefined) {
		return { kind: 'unsupported' };
	}
	return { kind: 'dispatch', action };
}

/**
 * Parse a drag payload. Unknown or malformed data is ignored.
 *
 * @param raw - text/plain or custom MIME body.
 */
export function parseBoardCardDragPayload(
	raw: string | undefined | null
): BoardCardDragPayload | undefined {
	if (raw === undefined || raw === null || raw.trim().length === 0) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (parsed === null || typeof parsed !== 'object') {
			return undefined;
		}
		const record = parsed as { issue_id?: unknown; source_status?: unknown };
		if (typeof record.issue_id !== 'string' || record.issue_id.trim().length === 0) {
			return undefined;
		}
		if (!(STATUS_KEYS as readonly string[]).includes(record.source_status as string)) {
			return undefined;
		}
		return {
			issue_id: record.issue_id,
			source_status: record.source_status as StatusKey
		};
	} catch {
		return undefined;
	}
}

/**
 * Serialize a card drag payload as JSON.
 *
 * @param payload - Issue id and source column.
 */
export function serializeBoardCardDragPayload(payload: BoardCardDragPayload): string {
	return JSON.stringify(payload);
}

/**
 * Human labels for the confirm modal.
 *
 * @param source - Status the card is in now.
 * @param destination - Status the drop requested.
 */
export function boardDispatchStatusCopy(
	source: StatusKey,
	destination: StatusKey
): { source_label: string; destination_label: string } {
	return {
		source_label: statusLabel(source),
		destination_label: statusLabel(destination)
	};
}
