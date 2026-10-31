/**
 * Keyboard focus for the project issues board.
 *
 * Arrow keys move between cards and column headers. Dispatch itself is still
 * boardDropIntent / keyboardDispatchChoices — never a status PATCH.
 */
import { statusLabel, type StatusKey } from './format.js';

/** One painted column, including empty and collapsed ones. */
export interface BoardNavColumn {
	status: StatusKey;
	issue_ids: readonly string[];
	collapsed: boolean;
}

/** Where keyboard focus sits on the board. */
export type BoardNavTarget =
	{ kind: 'card'; status: StatusKey; issue_id: string } | { kind: 'column'; status: StatusKey };

/** Keys the board intercepts when focus is inside it. */
export const BOARD_NAV_KEYS = [
	'ArrowUp',
	'ArrowDown',
	'ArrowLeft',
	'ArrowRight',
	'Home',
	'End'
] as const;

export type BoardNavKey = (typeof BOARD_NAV_KEYS)[number];

/** h/j/k/l move like the arrows, for readers who keep their hands on the home row. */
export const VIM_BOARD_KEYS: Readonly<Record<string, BoardNavKey>> = {
	h: 'ArrowLeft',
	j: 'ArrowDown',
	k: 'ArrowUp',
	l: 'ArrowRight'
};

/** Result of one arrow/Home/End press. */
export interface BoardMoveResult {
	target: BoardNavTarget;
	/** Expand this column before focusing so a collapsed strip is not a dead end. */
	expand?: StatusKey;
}

/**
 * Accessible name for a status column: label plus card count.
 *
 * @param label - Human status label (e.g. `in progress`).
 * @param count - Cards in the column.
 */
export function boardColumnAccessibleName(label: string, count: number): string {
	const noun = count === 1 ? 'issue' : 'issues';
	return `${label} column, ${count} ${noun}`;
}

/**
 * Accessible name for a card: id, title, and current status.
 *
 * @param issue - Identity plus status for the focused card.
 */
export function boardCardAccessibleName(issue: {
	id: string;
	title: string;
	status: string;
}): string {
	return `${issue.id}: ${issue.title}, ${statusLabel(issue.status)}`;
}

function columnIndex(columns: readonly BoardNavColumn[], status: StatusKey): number {
	return columns.findIndex((column) => column.status === status);
}

function cardIndex(column: BoardNavColumn, issue_id: string): number {
	return column.issue_ids.indexOf(issue_id);
}

/**
 * Focus target inside one column. Collapsed or empty columns land on the header.
 *
 * @param column - Destination column.
 * @param preferred_index - Card row to keep when moving left/right.
 */
export function targetInColumn(column: BoardNavColumn, preferred_index: number): BoardNavTarget {
	if (column.collapsed || column.issue_ids.length === 0) {
		return { kind: 'column', status: column.status };
	}
	const index = Math.min(Math.max(preferred_index, 0), column.issue_ids.length - 1);
	const issue_id = column.issue_ids[index];
	if (issue_id === undefined) {
		return { kind: 'column', status: column.status };
	}
	return { kind: 'card', status: column.status, issue_id };
}

function neighbor(
	columns: readonly BoardNavColumn[],
	index: number,
	delta: -1 | 1
): BoardNavColumn | undefined {
	return columns[index + delta];
}

function moveIntoColumn(column: BoardNavColumn, preferred_index: number): BoardMoveResult {
	if (column.collapsed) {
		return {
			target: targetInColumn({ ...column, collapsed: false }, preferred_index),
			expand: column.status
		};
	}
	return { target: targetInColumn(column, preferred_index) };
}

/**
 * Next focus target for an arrow/Home/End key. Returns null when the press
 * should fall through (unknown location, or already at that edge).
 *
 * @param columns - Visible board columns in paint order.
 * @param current - Card or column header that currently has focus.
 * @param key - Navigation key.
 */
export function moveBoardFocus(
	columns: readonly BoardNavColumn[],
	current: BoardNavTarget,
	key: BoardNavKey
): BoardMoveResult | null {
	const index = columnIndex(columns, current.status);
	if (index < 0) {
		return null;
	}
	const column = columns[index];
	if (column === undefined) {
		return null;
	}

	const preferred = current.kind === 'card' ? Math.max(0, cardIndex(column, current.issue_id)) : 0;

	if (key === 'ArrowLeft' || key === 'ArrowRight') {
		const next_column = neighbor(columns, index, key === 'ArrowLeft' ? -1 : 1);
		if (next_column === undefined) {
			return null;
		}
		return moveIntoColumn(next_column, current.kind === 'column' ? 0 : preferred);
	}

	if (current.kind === 'column') {
		if (key === 'ArrowDown' || key === 'Home') {
			if (column.collapsed) {
				return moveIntoColumn(column, 0);
			}
			if (column.issue_ids.length === 0) {
				return null;
			}
			return { target: targetInColumn(column, 0) };
		}
		if (key === 'End') {
			if (column.collapsed) {
				return moveIntoColumn(column, Number.MAX_SAFE_INTEGER);
			}
			if (column.issue_ids.length === 0) {
				return null;
			}
			return { target: targetInColumn(column, column.issue_ids.length - 1) };
		}
		if (key === 'ArrowUp') {
			return null;
		}
		return null;
	}

	const at = cardIndex(column, current.issue_id);
	if (at < 0) {
		return { target: targetInColumn(column, 0) };
	}

	if (key === 'Home') {
		if (at === 0) {
			return { target: { kind: 'column', status: column.status } };
		}
		return { target: targetInColumn(column, 0) };
	}
	if (key === 'End') {
		if (at === column.issue_ids.length - 1) {
			return null;
		}
		return { target: targetInColumn(column, column.issue_ids.length - 1) };
	}
	if (key === 'ArrowUp') {
		if (at === 0) {
			return { target: { kind: 'column', status: column.status } };
		}
		return { target: targetInColumn(column, at - 1) };
	}
	if (key === 'ArrowDown') {
		if (at >= column.issue_ids.length - 1) {
			return null;
		}
		return { target: targetInColumn(column, at + 1) };
	}
	return null;
}

/**
 * Whether this key is a board navigation key.
 *
 * @param key - KeyboardEvent.key.
 */
export function isBoardNavKey(key: string): key is BoardNavKey {
	return (BOARD_NAV_KEYS as readonly string[]).includes(key);
}
