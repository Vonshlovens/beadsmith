/**
 * Canonical mission event contract.
 *
 * A provider with live events fills this union. Browser stream UI renders
 * only these types — never raw runner payloads, prompts, tool args, PTY, or
 * unknown fields. Steer (s42.5) and First Mate attach (s42.8) reuse the same
 * shape.
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

export type MissionToolCallStatus = 'running' | 'completed';

export type MissionResultStatus = 'succeeded' | 'cancelled' | 'failed';

interface MissionEventBase {
	type: MissionEventType;
	/** Opaque stream id (the provider's SSE `id` when present). */
	id: string;
}

export interface MissionUserEvent extends MissionEventBase {
	type: 'user';
	text: string;
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
				(value.status === 'running' || value.status === 'completed')
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
		case 'user':
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

export function missionStreamPath(project_id: string, request_id: string): string {
	return `/api/projects/${encodeURIComponent(project_id)}/dispatch/${encodeURIComponent(request_id)}/stream`;
}
