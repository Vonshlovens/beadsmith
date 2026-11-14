/**
 * Canonical mission event contract.
 *
 * A provider with live events fills this union. Browser stream UI renders
 * only these types — never raw runner payloads, prompts, tool args, PTY, or
 * unknown fields. Steer and First Mate reuse the same shape. An admin's raw
 * terminal view of a scoped sandbox is a separate relay (ADR-0015) and never
 * feeds this union.
 */

export const MISSION_EVENT_TYPES = [
	'user',
	'assistant',
	'thinking',
	'tool_call',
	'result',
	'error'
] as const;

export type MissionEventType = (typeof MISSION_EVENT_TYPES)[number];

/**
 * `failed`: the tool returned an error (Claude Code's `tool_result` with
 * `is_error`). Only the status crosses; the error text is tool output and
 * stays out of the event.
 */
export type MissionToolCallStatus = 'running' | 'completed' | 'failed';

export type MissionResultStatus = 'succeeded' | 'cancelled' | 'failed';

interface MissionEventBase {
	type: MissionEventType;
	/** Opaque stream id (the provider's SSE `id` when present). */
	id: string;
}

export interface MissionUserEvent extends MissionEventBase {
	type: 'user';
	text: string;
	/** Client message identity, so replay can settle a pending send before its POST returns. */
	message_id?: string;
}

export interface MissionAssistantEvent extends MissionEventBase {
	type: 'assistant';
	text: string;
}

export interface MissionThinkingEvent extends MissionEventBase {
	type: 'thinking';
	text: string;
}

export interface MissionToolCallEvent extends MissionEventBase {
	type: 'tool_call';
	call_id: string;
	name: string;
	status: MissionToolCallStatus;
	truncated?: boolean;
}

export interface MissionResultEvent extends MissionEventBase {
	type: 'result';
	status: MissionResultStatus;
	text?: string;
	duration_ms?: number;
	git_pr_url?: string;
}

export interface MissionErrorEvent extends MissionEventBase {
	type: 'error';
	message: string;
}

export type MissionEvent =
	| MissionUserEvent
	| MissionAssistantEvent
	| MissionThinkingEvent
	| MissionToolCallEvent
	| MissionResultEvent
	| MissionErrorEvent;

const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const EVENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function asEventId(value: unknown): string | undefined {
	return typeof value === 'string' && EVENT_ID_PATTERN.test(value) ? value : undefined;
}

function asNonEmptyText(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * True when `value` is a mission event the browser may render. Extra keys are
 * allowed on the wire but ignored by the UI.
 */
export function isMissionEvent(value: unknown): value is MissionEvent {
	if (!isRecord(value)) {
		return false;
	}
	const id = asEventId(value.id);
	if (id === undefined) {
		return false;
	}
	switch (value.type) {
		case 'user':
		case 'assistant':
		case 'thinking':
			return asNonEmptyText(value.text) !== undefined;
		case 'tool_call':
			return (
				asNonEmptyText(value.call_id) !== undefined &&
				typeof value.name === 'string' &&
				TOOL_NAME_PATTERN.test(value.name) &&
				(value.status === 'running' || value.status === 'completed' || value.status === 'failed')
			);
		case 'result':
			return (
				value.status === 'succeeded' || value.status === 'cancelled' || value.status === 'failed'
			);
		case 'error':
			return asNonEmptyText(value.message) !== undefined;
		default:
			return false;
	}
}

/** Drop unknown keys so a client never round-trips raw runner fields. */
export function encodeMissionEvent(event: MissionEvent): MissionEvent {
	switch (event.type) {
		case 'user': {
			const encoded: MissionUserEvent = { type: event.type, id: event.id, text: event.text };
			if (typeof event.message_id === 'string' && MESSAGE_ID_PATTERN.test(event.message_id)) {
				encoded.message_id = event.message_id;
			}
			return encoded;
		}
		case 'assistant':
		case 'thinking':
			return { type: event.type, id: event.id, text: event.text };
		case 'tool_call':
			return event.truncated === true
				? {
						type: 'tool_call',
						id: event.id,
						call_id: event.call_id,
						name: event.name,
						status: event.status,
						truncated: true
					}
				: {
						type: 'tool_call',
						id: event.id,
						call_id: event.call_id,
						name: event.name,
						status: event.status
					};
		case 'result': {
			const encoded: MissionResultEvent = {
				type: 'result',
				id: event.id,
				status: event.status
			};
			if (event.text !== undefined) {
				encoded.text = event.text;
			}
			if (event.duration_ms !== undefined) {
				encoded.duration_ms = event.duration_ms;
			}
			if (event.git_pr_url !== undefined) {
				encoded.git_pr_url = event.git_pr_url;
			}
			return encoded;
		}
		case 'error':
			return { type: 'error', id: event.id, message: event.message };
	}
}

export function parseMissionEventJson(text: string): MissionEvent | undefined {
	try {
		const parsed: unknown = JSON.parse(text);
		if (!isMissionEvent(parsed)) {
			return undefined;
		}
		return encodeMissionEvent(parsed);
	} catch {
		return undefined;
	}
}

/**
 * Collapse assistant/thinking deltas and upsert tool calls by `call_id` so
 * the stream UI can render turns instead of raw SSE frames.
 */
export function reduceMissionEvents(events: readonly MissionEvent[]): MissionEvent[] {
	const reduced: MissionEvent[] = [];
	const tool_index = new Map<string, number>();

	for (const event of events) {
		const last = reduced.at(-1);
		if ((event.type === 'assistant' || event.type === 'thinking') && last?.type === event.type) {
			reduced[reduced.length - 1] = {
				type: event.type,
				id: event.id,
				text: `${last.text}${event.text}`
			};
			continue;
		}
		if (event.type === 'tool_call') {
			const existing = tool_index.get(event.call_id);
			if (existing !== undefined) {
				reduced[existing] = event;
				continue;
			}
			tool_index.set(event.call_id, reduced.length);
		}
		reduced.push(event);
	}
	return reduced;
}

/**
 * A run of consecutive tool calls, shown as one line instead of one row each.
 * The First Mate chat summarises the same runs (`toolRunSummary` in
 * client/mate-chat.ts), so the two read alike.
 */
export interface MissionToolGroup {
	type: 'tool_group';
	calls: MissionToolCallEvent[];
}

export type MissionStreamItem = Exclude<MissionEvent, MissionToolCallEvent> | MissionToolGroup;

/**
 * The stream as the thread shows it: reduced (see `reduceMissionEvents`),
 * then each run of consecutive tool calls folded into one group, so a long
 * run reads as what the agent said with its tool work in between. Items
 * only grow or append, so a position is a stable key.
 */
export function groupMissionEvents(events: readonly MissionEvent[]): MissionStreamItem[] {
	const items: MissionStreamItem[] = [];
	let calls: MissionToolCallEvent[] = [];
	for (const event of reduceMissionEvents(events)) {
		if (event.type === 'tool_call') {
			calls.push(event);
			continue;
		}
		if (calls.length > 0) {
			items.push({ type: 'tool_group', calls });
			calls = [];
		}
		items.push(event);
	}
	if (calls.length > 0) {
		items.push({ type: 'tool_group', calls });
	}
	return items;
}

/**
 * Whether a stream the proxy closed with `done` is over for good. It is when
 * the run's result arrived, or the proxy answered for itself (not launched,
 * stream expired: reconnecting would get the same answer). Otherwise the
 * runner's side dropped mid-run and the browser should reconnect.
 */
export function missionStreamEnded(seen: { got_result: boolean; got_answer: boolean }): boolean {
	return seen.got_result || seen.got_answer;
}

export function missionStreamPath(project_id: string, request_id: string): string {
	return `/api/projects/${encodeURIComponent(project_id)}/dispatch/${encodeURIComponent(request_id)}/stream`;
}
