/**
 * Claude Code `--output-format stream-json` to mission events.
 *
 * A First Mate chat is one long-lived Claude Code process reading user
 * messages as `--input-format stream-json` on stdin. Its stdout is one JSON
 * object per line: `system` (init), `assistant` and `user` messages whose
 * content blocks are text, thinking, tool_use and tool_result, `result` at
 * the end of every agent turn, and control responses. This module turns
 * those lines into the canonical mission event union (without ids; the event
 * log assigns them), dropping everything the browser must not see: tool
 * inputs and outputs, raw system payloads, usage and cost.
 */

import type { MissionEvent, MissionResultStatus } from '../mission-events.js';

type Draft<T> = T extends MissionEvent ? Omit<T, 'id'> : never;
/** A mission event before the log gives it an id. */
export type MissionEventDraft = Draft<MissionEvent>;

const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const CALL_ID_MAX = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/** A tool name the event union accepts; MCP names (`mcp__x__y`) already fit. */
export function safeToolName(value: unknown): string {
	const raw = typeof value === 'string' ? value : '';
	if (TOOL_NAME_PATTERN.test(raw)) return raw;
	const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '_');
	const named = /^[A-Za-z]/.test(cleaned) ? cleaned : `tool_${cleaned}`;
	return named.slice(0, 64);
}

function callId(value: unknown): string | undefined {
	const id = text(value);
	return id === undefined ? undefined : id.slice(0, CALL_ID_MAX);
}

/**
 * Stateful mapper for one Claude Code process: it remembers tool names by
 * call id so a tool_result can close the call it answers.
 */
export class ClaudeStreamMapper {
	readonly #tools = new Map<string, string>();
	#interrupted = false;

	/** The next `result` ends a turn the runner interrupted. */
	markInterrupted(): void {
		this.#interrupted = true;
	}

	/** Map one parsed stdout line. Unknown or empty lines map to nothing. */
	map(line: unknown): MissionEventDraft[] {
		if (!isRecord(line)) return [];
		switch (line.type) {
			case 'assistant':
				return this.#assistant(line.message);
			case 'user':
				return this.#toolResults(line.message);
			case 'result':
				return [this.#result(line)];
			default:
				return [];
		}
	}

	#assistant(message: unknown): MissionEventDraft[] {
		if (!isRecord(message) || !Array.isArray(message.content)) return [];
		const events: MissionEventDraft[] = [];
		for (const block of message.content) {
			if (!isRecord(block)) continue;
			if (block.type === 'text') {
				const value = text(block.text);
				if (value !== undefined) events.push({ type: 'assistant', text: value });
			} else if (block.type === 'thinking') {
				const value = text(block.thinking);
				if (value !== undefined) events.push({ type: 'thinking', text: value });
			} else if (block.type === 'tool_use') {
				const id = callId(block.id);
				if (id === undefined) continue;
				const name = safeToolName(block.name);
				this.#tools.set(id, name);
				events.push({ type: 'tool_call', call_id: id, name, status: 'running' });
			}
		}
		return events;
	}

	#toolResults(message: unknown): MissionEventDraft[] {
		if (!isRecord(message) || !Array.isArray(message.content)) return [];
		const events: MissionEventDraft[] = [];
		for (const block of message.content) {
			if (!isRecord(block) || block.type !== 'tool_result') continue;
			const id = callId(block.tool_use_id);
			if (id === undefined) continue;
			const name = this.#tools.get(id);
			if (name === undefined) continue;
			this.#tools.delete(id);
			events.push({ type: 'tool_call', call_id: id, name, status: 'completed' });
		}
		return events;
	}

	#result(line: Record<string, unknown>): MissionEventDraft {
		let status: MissionResultStatus;
		if (this.#interrupted) {
			status = 'cancelled';
		} else {
			status = line.subtype === 'success' && line.is_error !== true ? 'succeeded' : 'failed';
		}
		this.#interrupted = false;
		const event: MissionEventDraft = { type: 'result', status };
		const summary = text(line.result);
		if (summary !== undefined) event.text = summary;
		if (typeof line.duration_ms === 'number' && Number.isFinite(line.duration_ms)) {
			event.duration_ms = Math.max(0, Math.round(line.duration_ms));
		}
		return event;
	}
}

/** One user message in Claude Code's `--input-format stream-json` shape. */
export function userInputLine(prompt: string, session_id: string): string {
	return `${JSON.stringify({
		type: 'user',
		message: { role: 'user', content: [{ type: 'text', text: prompt }] },
		parent_tool_use_id: null,
		session_id
	})}\n`;
}

/** Ask the running turn to stop; the process and session survive. */
export function interruptLine(request_id: string): string {
	return `${JSON.stringify({
		type: 'control_request',
		request_id,
		request: { subtype: 'interrupt' }
	})}\n`;
}
