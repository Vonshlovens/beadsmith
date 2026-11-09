/**
 * Where a todo stands on its way into Beads, derived from the todo row, its
 * routing mission and (once filed) the bead. The todo card and the crew
 * `list_todos` tool both read this, so the browser and First Mate describe a
 * routed todo the same way. Nothing here is stored: the todo keeps only the
 * project, mission and bead ids (ADR-0004), and the mission and bead are read
 * live.
 */
import type { DispatchStatus } from '#lib/types.js';

/** The fields of a todo routing reads. */
export interface RoutedTodoFields {
	status: 'open' | 'done' | 'archived';
	routed_project_id: string | null;
	routed_dispatch_id: string | null;
	routed_issue_id: string | null;
}

/** The routing mission as last read: `null` when it no longer exists. */
export interface RouteMission {
	status: DispatchStatus;
	error_message?: string;
}

/** The filed bead as last read: `null` when Beads could not be read for it. */
export interface RouteIssue {
	status: string;
	title: string;
}

export type TodoRouteState =
	| { kind: 'unrouted' }
	| {
			/** The File mission is queued or running and has reported no bead yet. */
			kind: 'routing';
			project_id: string;
			mission_id: string;
			/** Null until the mission has been read. */
			mission_status: DispatchStatus | null;
	  }
	| {
			/** The mission failed, was cancelled or is gone: routing again is allowed. */
			kind: 'failed';
			project_id: string;
			mission_id: string;
			mission_status: 'failed' | 'cancelled' | 'missing';
			error?: string;
	  }
	| {
			/**
			 * The mission finished but never reported a bead. Routing again would
			 * risk a duplicate, so the server refuses it; the mission's own record
			 * says what happened.
			 */
			kind: 'unreported';
			project_id: string;
			mission_id: string;
	  }
	| {
			kind: 'filed';
			project_id: string;
			mission_id: string;
			issue_id: string;
			/** Null while unknown (not read yet, or Beads unreadable). */
			issue_status: string | null;
			issue_title: string | null;
			/** The bead is closed and the todo still open: offer to complete it. */
			offer_complete: boolean;
			/** The bead is not known to be closed and the todo is open: tackling it is a sensible next step. */
			offer_tackle: boolean;
	  };

/**
 * @param todo The stored todo.
 * @param mission The routing mission: `undefined` when not read yet, `null` when missing.
 * @param issue The filed bead: `undefined` when not read yet, `null` when unreadable.
 */
export function todoRouteState(
	todo: RoutedTodoFields,
	mission?: RouteMission | null,
	issue?: RouteIssue | null
): TodoRouteState {
	const project_id = todo.routed_project_id;
	const mission_id = todo.routed_dispatch_id;
	if (project_id === null || mission_id === null) {
		return { kind: 'unrouted' };
	}
	if (todo.routed_issue_id !== null) {
		const issue_status = issue?.status ?? null;
		const open = todo.status === 'open';
		return {
			kind: 'filed',
			project_id,
			mission_id,
			issue_id: todo.routed_issue_id,
			issue_status,
			issue_title: issue?.title ?? null,
			offer_complete: open && issue_status === 'closed',
			offer_tackle: open && issue_status !== 'closed'
		};
	}
	if (mission === null) {
		return { kind: 'failed', project_id, mission_id, mission_status: 'missing' };
	}
	if (mission?.status === 'failed' || mission?.status === 'cancelled') {
		return {
			kind: 'failed',
			project_id,
			mission_id,
			mission_status: mission.status,
			...(mission.error_message ? { error: mission.error_message } : {})
		};
	}
	if (mission?.status === 'succeeded') {
		return { kind: 'unreported', project_id, mission_id };
	}
	return { kind: 'routing', project_id, mission_id, mission_status: mission?.status ?? null };
}

/** Whether routing (again) is allowed: the server's `routeTodo` retries exactly these. */
export function canRouteTodo(state: TodoRouteState): boolean {
	return state.kind === 'unrouted' || state.kind === 'failed';
}
