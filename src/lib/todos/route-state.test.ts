import { describe, expect, it } from 'vitest';
import { canRouteTodo, todoRouteState, type RoutedTodoFields } from './route-state.js';

const UNROUTED: RoutedTodoFields = {
	status: 'open',
	routed_project_id: null,
	routed_dispatch_id: null,
	routed_issue_id: null
};
const ROUTED: RoutedTodoFields = { ...UNROUTED, routed_project_id: 'p1', routed_dispatch_id: 'm1' };
const FILED: RoutedTodoFields = { ...ROUTED, routed_issue_id: 'bw-9' };

describe('todoRouteState', () => {
	it('is unrouted without a project and mission, and routing is allowed', () => {
		const state = todoRouteState(UNROUTED);
		expect(state).toEqual({ kind: 'unrouted' });
		expect(canRouteTodo(state)).toBe(true);
	});

	it('is routing while the mission is unread, queued or running', () => {
		expect(todoRouteState(ROUTED)).toMatchObject({ kind: 'routing', mission_status: null });
		for (const status of ['queued', 'running'] as const) {
			const state = todoRouteState(ROUTED, { status });
			expect(state).toMatchObject({ kind: 'routing', mission_status: status });
			expect(canRouteTodo(state)).toBe(false);
		}
	});

	it('is failed, with a retry, when the mission failed, was cancelled or is gone', () => {
		const failed = todoRouteState(ROUTED, { status: 'failed', error_message: 'no checkout' });
		expect(failed).toMatchObject({
			kind: 'failed',
			mission_status: 'failed',
			error: 'no checkout'
		});
		expect(todoRouteState(ROUTED, { status: 'cancelled' })).toMatchObject({
			kind: 'failed',
			mission_status: 'cancelled'
		});
		const missing = todoRouteState(ROUTED, null);
		expect(missing).toMatchObject({ kind: 'failed', mission_status: 'missing' });
		expect(canRouteTodo(failed)).toBe(true);
		expect(canRouteTodo(missing)).toBe(true);
	});

	it('is unreported when the mission succeeded without a bead, and refuses a duplicate route', () => {
		const state = todoRouteState(ROUTED, { status: 'succeeded' });
		expect(state).toEqual({ kind: 'unreported', project_id: 'p1', mission_id: 'm1' });
		expect(canRouteTodo(state)).toBe(false);
	});

	it('is filed once a bead is reported, offering tackle while it is open', () => {
		const state = todoRouteState(FILED, { status: 'succeeded' }, { status: 'open', title: 'T' });
		expect(state).toEqual({
			kind: 'filed',
			project_id: 'p1',
			mission_id: 'm1',
			issue_id: 'bw-9',
			issue_status: 'open',
			issue_title: 'T',
			offer_complete: false,
			offer_tackle: true
		});
		expect(canRouteTodo(state)).toBe(false);
	});

	it('offers to complete the todo when the bead is closed', () => {
		const state = todoRouteState(FILED, undefined, { status: 'closed', title: 'T' });
		expect(state).toMatchObject({ kind: 'filed', offer_complete: true, offer_tackle: false });
	});

	it('stays filed, never re-routable, even if the mission later reads as failed', () => {
		const state = todoRouteState(FILED, { status: 'failed' }, null);
		expect(state).toMatchObject({ kind: 'filed', issue_status: null, offer_tackle: true });
		expect(canRouteTodo(state)).toBe(false);
	});

	it('offers nothing for a todo that is already done', () => {
		const state = todoRouteState({ ...FILED, status: 'done' }, undefined, {
			status: 'closed',
			title: 'T'
		});
		expect(state).toMatchObject({ offer_complete: false, offer_tackle: false });
	});
});
