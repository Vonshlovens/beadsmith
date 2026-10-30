import { describe, expect, it } from 'vitest';
import {
	boardCardAccessibleName,
	boardColumnAccessibleName,
	moveBoardFocus,
	targetInColumn,
	type BoardNavColumn
} from './board-keyboard.js';

function columns(
	rows: Array<Partial<BoardNavColumn> & { status: BoardNavColumn['status'] }>
): BoardNavColumn[] {
	return rows.map((row) => ({
		issue_ids: row.issue_ids ?? [],
		collapsed: row.collapsed ?? false,
		status: row.status
	}));
}

const board = columns([
	{ status: 'open', issue_ids: ['a', 'b', 'c'] },
	{ status: 'in_progress', issue_ids: ['d'] },
	{ status: 'blocked', issue_ids: [] },
	{ status: 'deferred', issue_ids: ['e'], collapsed: true }
]);

describe('board accessible names', () => {
	it('names a column with its status and count', () => {
		expect(boardColumnAccessibleName('in progress', 2)).toBe('in progress column, 2 issues');
		expect(boardColumnAccessibleName('open', 1)).toBe('open column, 1 issue');
		expect(boardColumnAccessibleName('blocked', 0)).toBe('blocked column, 0 issues');
	});

	it('names a card with id, title, and status', () => {
		expect(
			boardCardAccessibleName({ id: 'beads-web-1', title: 'Keyboard dispatch', status: 'open' })
		).toBe('beads-web-1: Keyboard dispatch, open');
		expect(
			boardCardAccessibleName({
				id: 'beads-web-2',
				title: 'In flight',
				status: 'in_progress'
			})
		).toBe('beads-web-2: In flight, in progress');
	});
});

describe('targetInColumn', () => {
	it('lands on the header when the column is empty or collapsed', () => {
		expect(targetInColumn(board[2]!, 0)).toEqual({ kind: 'column', status: 'blocked' });
		expect(targetInColumn(board[3]!, 0)).toEqual({ kind: 'column', status: 'deferred' });
	});

	it('clamps the preferred card index', () => {
		expect(targetInColumn(board[0]!, 99)).toEqual({
			kind: 'card',
			status: 'open',
			issue_id: 'c'
		});
	});
});

describe('moveBoardFocus', () => {
	it('moves up and down within a column, then onto the header', () => {
		expect(
			moveBoardFocus(board, { kind: 'card', status: 'open', issue_id: 'b' }, 'ArrowDown')
		).toEqual({ target: { kind: 'card', status: 'open', issue_id: 'c' } });
		expect(
			moveBoardFocus(board, { kind: 'card', status: 'open', issue_id: 'a' }, 'ArrowUp')
		).toEqual({ target: { kind: 'column', status: 'open' } });
		expect(moveBoardFocus(board, { kind: 'column', status: 'open' }, 'ArrowDown')).toEqual({
			target: { kind: 'card', status: 'open', issue_id: 'a' }
		});
	});

	it('does not wrap off the last card or above a header', () => {
		expect(
			moveBoardFocus(board, { kind: 'card', status: 'open', issue_id: 'c' }, 'ArrowDown')
		).toBeNull();
		expect(moveBoardFocus(board, { kind: 'column', status: 'open' }, 'ArrowUp')).toBeNull();
	});

	it('keeps the row when moving left and right between columns', () => {
		expect(
			moveBoardFocus(board, { kind: 'card', status: 'open', issue_id: 'b' }, 'ArrowRight')
		).toEqual({ target: { kind: 'card', status: 'in_progress', issue_id: 'd' } });
		expect(
			moveBoardFocus(board, { kind: 'card', status: 'in_progress', issue_id: 'd' }, 'ArrowRight')
		).toEqual({ target: { kind: 'column', status: 'blocked' } });
	});

	it('expands a collapsed neighbor instead of trapping focus', () => {
		expect(moveBoardFocus(board, { kind: 'column', status: 'blocked' }, 'ArrowRight')).toEqual({
			target: { kind: 'card', status: 'deferred', issue_id: 'e' },
			expand: 'deferred'
		});
	});

	it('sends Home to the first card and End to the last', () => {
		expect(moveBoardFocus(board, { kind: 'card', status: 'open', issue_id: 'c' }, 'Home')).toEqual({
			target: { kind: 'card', status: 'open', issue_id: 'a' }
		});
		expect(moveBoardFocus(board, { kind: 'card', status: 'open', issue_id: 'a' }, 'Home')).toEqual({
			target: { kind: 'column', status: 'open' }
		});
		expect(moveBoardFocus(board, { kind: 'card', status: 'open', issue_id: 'a' }, 'End')).toEqual({
			target: { kind: 'card', status: 'open', issue_id: 'c' }
		});
	});

	it('returns null when the current column is not on the board', () => {
		expect(
			moveBoardFocus(board, { kind: 'card', status: 'closed', issue_id: 'z' }, 'ArrowDown')
		).toBeNull();
	});
});
