/**
 * Claude Code's headless event log (`claude -p --output-format stream-json
 * --verbose`, one JSON object per line) mapped onto the canonical mission
 * event union. Only text, tool names and ids survive: tool inputs, tool
 * results, file bodies and unknown fields are dropped here, before anything
 * reaches the browser (docs/file-tackle-dispatch.md, "Request contract").
 */
import { isMissionEvent, type MissionEvent } from '#lib/mission-events.js';
import { readDurationMs, sanitizeResultSummary } from './sanitize.js';

/** Upper bound on one streamed text event; the final summary has its own bound. */
const MAX_EVENT_TEXT = 8_000;
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const CALL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** The final `result` line: the run's own verdict, text and duration. */
export interface ClaudeResult {
	is_error: boolean;
	text?: string;
	duration_ms?: number;
}

/** A mission event before it gets its id (distributes over the union). */
type EventWithoutId = MissionEvent extends infer E
	? E extends MissionEvent
		? Omit<E, 'id'>
		: never
	: never;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseLine(line: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(line);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function cleanText(value: unknown, redact: string): string | undefined {
	const text = sanitizeResultSummary(value, redact);
	if (text === undefined) return undefined;
	return text.length > MAX_EVENT_TEXT ? `${text.slice(0, MAX_EVENT_TEXT - 1)}…` : text;
}

function toolName(value: unknown): string {
	if (typeof value !== 'string') return 'tool';
	// MCP tools arrive as mcp__server__tool; keep a renderable name.
	const name = value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
	return TOOL_NAME_PATTERN.test(name) ? name : 'tool';
}

/** Read a `result` line, or undefined when the line is anything else. */
export function parseClaudeResult(line: string, redact = ''): ClaudeResult | undefined {
	const event = parseLine(line);
	if (event?.type !== 'result') return undefined;
	return {
		is_error: event.is_error === true || event.subtype !== 'success',
		text: sanitizeResultSummary(event.result, redact),
		duration_ms: readDurationMs(event.duration_ms)
	};
}

/**
 * Maps log lines to mission events. Tool names are remembered by call id so a
 * tool result (which carries only the id) can close the right call.
 */
export class ClaudeStreamMapper {
	private readonly tool_names = new Map<string, string>();

	constructor(private readonly redact = '') {}

	/**
	 * Events for one log line, with ids `<line>.<index>` so a reconnecting
	 * client can resume after the last one it saw.
	 *
	 * @param line - One JSON line from the log.
	 * @param line_number - Its 1-based position in the log.
	 */
	map(line: string, line_number: number): MissionEvent[] {
		const event = parseLine(line);
		if (event === undefined) return [];
		const out: MissionEvent[] = [];
		const push = (partial: EventWithoutId) => {
			const candidate = { ...partial, id: `${line_number}.${out.length}` };
			if (isMissionEvent(candidate)) out.push(candidate);
		};
		const content = isRecord(event.message) ? event.message.content : undefined;
		const blocks = Array.isArray(content) ? content.filter(isRecord) : [];

		if (event.type === 'assistant') {
			for (const block of blocks) {
				if (block.type === 'text') {
					const text = cleanText(block.text, this.redact);
					if (text !== undefined) push({ type: 'assistant', text });
				} else if (block.type === 'thinking') {
					const text = cleanText(block.thinking, this.redact);
					if (text !== undefined) push({ type: 'thinking', text });
				} else if (
					block.type === 'tool_use' &&
					typeof block.id === 'string' &&
					CALL_ID_PATTERN.test(block.id)
				) {
					const name = toolName(block.name);
					this.tool_names.set(block.id, name);
					push({ type: 'tool_call', call_id: block.id, name, status: 'running' });
				}
			}
		} else if (event.type === 'user') {
			// The prompt echo is the operator's turn, shown already; only close tools.
			for (const block of blocks) {
				if (
					block.type === 'tool_result' &&
					typeof block.tool_use_id === 'string' &&
					CALL_ID_PATTERN.test(block.tool_use_id)
				) {
					push({
						type: 'tool_call',
						call_id: block.tool_use_id,
						name: this.tool_names.get(block.tool_use_id) ?? 'tool',
						status: block.is_error === true ? 'failed' : 'completed'
					});
				}
			}
		} else if (event.type === 'result') {
			const result = parseClaudeResult(line, this.redact);
			if (result !== undefined) {
				push({
					type: 'result',
					status: result.is_error ? 'failed' : 'succeeded',
					...(result.text === undefined ? {} : { text: result.text }),
					...(result.duration_ms === undefined ? {} : { duration_ms: result.duration_ms })
				});
			}
		}
		return out;
	}
}

/** Parse a `<line>.<index>` event id; undefined for anything else. */
export function parseStreamEventId(
	value: string | undefined
): { line: number; index: number } | undefined {
	const match = value === undefined ? null : /^([1-9][0-9]{0,8})\.([0-9]{1,4})$/.exec(value);
	if (match === null) return undefined;
	return { line: Number(match[1]), index: Number(match[2]) };
}

/** The first GitHub pull request URL in a run summary, if any. */
export function findPullRequestUrl(text: string | undefined): string | undefined {
	const match = text?.match(
		/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*/
	);
	return match?.[0];
}
