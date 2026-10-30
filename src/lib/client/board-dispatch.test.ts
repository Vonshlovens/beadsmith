import { describe, expect, it } from 'vitest';
import {
	boardDispatchAction,
	boardDropIntent,
	isBoardDispatchDestination,
	keyboardDispatchChoices,
	parseBoardCardDragPayload,
	serializeBoardCardDragPayload
} from './board-dispatch.js';

describe('boardDropIntent', () => {
	it('treats a same-column drop as a no-op', () => {
		expect(boardDropIntent('open', 'open')).toEqual({ kind: 'noop' });
		expect(boardDropIntent('in_progress', 'in_progress')).toEqual({ kind: 'noop' });
		expect(boardDropIntent('pinned', 'pinned')).toEqual({ kind: 'noop' });
	});

	it('maps in_progress to /tackle', () => {
		const intent = boardDropIntent('open', 'in_progress');
		expect(intent.kind).toBe('dispatch');
		if (intent.kind !== 'dispatch') {
			return;
		}
		expect(intent.action.skill).toBe('tackle');
		expect(intent.action.confirm_question).toContain('/tackle');
	});

	it('maps closed, blocked, deferred, and open to agent actions', () => {
		expect(boardDropIntent('open', 'closed')).toMatchObject({
			kind: 'dispatch',
			action: { skill: 'close' }
		});
		expect(boardDropIntent('open', 'blocked')).toMatchObject({
			kind: 'dispatch',
			action: { skill: 'block' }
		});
		expect(boardDropIntent('open', 'deferred')).toMatchObject({
			kind: 'dispatch',
			action: { skill: 'defer' }
		});
		expect(boardDropIntent('in_progress', 'open')).toMatchObject({
			kind: 'dispatch',
			action: { skill: 'unclaim' }
		});
	});

	it('does not treat pinned or hooked as drop targets', () => {
		expect(boardDropIntent('open', 'pinned')).toEqual({ kind: 'unsupported' });
		expect(boardDropIntent('open', 'hooked')).toEqual({ kind: 'unsupported' });
		expect(boardDispatchAction('pinned')).toBeUndefined();
		expect(isBoardDispatchDestination('hooked')).toBe(false);
	});
});

describe('keyboardDispatchChoices', () => {
	it('omits the current status and never offers pinned or hooked', () => {
		expect(keyboardDispatchChoices('open').map((action) => action.destination)).toEqual([
			'in_progress',
			'blocked',
			'deferred',
			'closed'
		]);
		expect(keyboardDispatchChoices('in_progress').map((action) => action.skill)).toEqual([
			'unclaim',
			'block',
			'defer',
			'close'
		]);
		expect(keyboardDispatchChoices('pinned').map((action) => action.destination)).toEqual([
			'open',
			'in_progress',
			'blocked',
			'deferred',
			'closed'
		]);
	});

	it('shares the same /tackle copy as a drop onto in_progress', () => {
		const from_menu = keyboardDispatchChoices('open').find(
			(action) => action.destination === 'in_progress'
		);
		const from_drop = boardDropIntent('open', 'in_progress');
		expect(from_drop.kind).toBe('dispatch');
		if (from_drop.kind !== 'dispatch') {
			return;
		}
		expect(from_menu).toEqual(from_drop.action);
	});
});

describe('parseBoardCardDragPayload', () => {
	it('round-trips a valid payload', () => {
		const payload = { issue_id: 'beads-web-1', source_status: 'open' as const };
		expect(parseBoardCardDragPayload(serializeBoardCardDragPayload(payload))).toEqual(payload);
	});

	it('ignores malformed or empty data', () => {
		expect(parseBoardCardDragPayload(undefined)).toBeUndefined();
		expect(parseBoardCardDragPayload('')).toBeUndefined();
		expect(parseBoardCardDragPayload('not-json')).toBeUndefined();
		expect(parseBoardCardDragPayload('{"issue_id":"x","source_status":"nope"}')).toBeUndefined();
	});
});
