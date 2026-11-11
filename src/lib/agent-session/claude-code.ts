/**
 * The Claude Code harness for the interactive session core (ADR-0021 rule 2):
 * how to launch the CLI in an hc terminal, where it writes its session
 * transcript, and how that transcript maps onto the sanitized MissionEvent
 * union (rule 3).
 *
 * The transcript is the JSONL file Claude Code keeps for `--session-id`
 * under `<config dir>/projects/<cwd, every non-alphanumeric character turned
 * into '-'>/<session id>.jsonl`. Each `assistant` line carries one content
 * block (text, thinking or tool_use), `user` lines carry the prompt or
 * tool_result blocks, and `system` with subtype `turn_duration` closes a turn
 * with its duration. Everything else (attachments, request records, cost,
 * file snapshots, sidechains) is dropped, and so are tool inputs and outputs:
 * only text, tool names and call ids survive, the same contract as the
 * headless stream mappings this replaces (docs/file-tackle-dispatch.md,
 * "Request contract").
 *
 * Another CLI that reports OSC 7501 implements {@link AgentHarness}; nothing
 * else in the session core knows it is Claude Code.
 *
 * Plain JavaScript only (no Node or SvelteKit imports): the forge mate runner
 * and the Beadsmith server both use it.
 */

import { isMissionEvent, type MissionEvent } from '../mission-events.js';
import { readDurationMs, sanitizeResultSummary } from '../server/dispatch/sanitize.js';

/** What one launch of the agent CLI needs. Nothing here is secret. */
export interface HarnessLaunch {
	/** The CLI's session id (a UUID); the transcript is named after it. */
	session_id: string;
	/** Continue an existing session (`--resume`) instead of creating it. */
	resume: boolean;
	/** Absolute working directory in the sandbox. */
	cwd: string;
	/** Absolute path of the CLI's config directory in the sandbox (`~/.claude`). */
	config_dir: string;
	/** The executable, looked up on the sandbox's PATH when not absolute. */
	command?: string;
	model?: string;
	effort?: string;
	/** An MCP config file in the sandbox (`--mcp-config`), for crew tools (ADR-0020). */
	mcp_config?: string;
	append_system_prompt?: string;
}

/** Facts about the turn being read, gathered from the transcript. */
export interface TurnFacts {
	/** The CLI wrote its end-of-turn record. */
	ended: boolean;
	duration_ms?: number;
	/** The last assistant text of the turn, raw (the session sanitizes it once). */
	last_text?: string;
	/** The model request failed (Claude Code's API error message). */
	api_error: boolean;
}

/** Maps transcript lines to events and keeps the current turn's facts. */
export interface TranscriptMapper {
	/**
	 * Events for one transcript line, with ids `<line>.<index>` so a
	 * reconnecting client can resume after the last one it saw.
	 */
	map(line: string, line_number: number): MissionEvent[];
	/** The facts gathered since the last {@link beginTurn}. */
	readonly turn: TurnFacts;
	beginTurn(): void;
}

/** The seam ADR-0021 rule 2 keeps for other harnesses. */
export interface AgentHarness {
	/** The `app` the CLI reports through OSC 7501. */
	readonly app: string;
	argv(launch: HarnessLaunch): string[];
	transcriptPath(launch: Pick<HarnessLaunch, 'cwd' | 'config_dir' | 'session_id'>): string;
	mapper(redact: string): TranscriptMapper;
}

/** Upper bound on one streamed text event; the final summary has its own bound. */
const MAX_EVENT_TEXT = 8_000;
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const CALL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Model names and aliases (`opus`, `claude-opus-5-5`, `claude-opus-5-5[1m]`); never a flag. */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,127}$/;
const EFFORT_PATTERN = /^[a-z][a-z0-9-]{0,15}$/;

type EventWithoutId = MissionEvent extends infer E
	? E extends MissionEvent
		? Omit<E, 'id'>
		: never
	: never;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function absolute(value: string, what: string): string {
	if (!value.startsWith('/') || value.includes('\0')) {
		throw new Error(`${what} must be an absolute path`);
	}
	return value;
}

function toolName(value: unknown): string {
	if (typeof value !== 'string') return 'tool';
	// MCP tools arrive as mcp__server__tool; keep a renderable name.
	const name = value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
	return TOOL_NAME_PATTERN.test(name) ? name : 'tool';
}

class ClaudeTranscriptMapper implements TranscriptMapper {
	readonly #tool_names = new Map<string, string>();
	readonly #redact: string;
	#turn: TurnFacts = { ended: false, api_error: false };

	constructor(redact: string) {
		this.#redact = redact;
	}

	get turn(): TurnFacts {
		return this.#turn;
	}

	beginTurn(): void {
		this.#turn = { ended: false, api_error: false };
	}

	#text(value: unknown): string | undefined {
		const text = sanitizeResultSummary(value, this.#redact);
		if (text === undefined) return undefined;
		return text.length > MAX_EVENT_TEXT ? `${text.slice(0, MAX_EVENT_TEXT - 1)}…` : text;
	}

	map(line: string, line_number: number): MissionEvent[] {
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			return [];
		}
		// Subagent messages are the subagent's business; the parent's tool call shows it ran.
		if (!isRecord(entry) || entry.isSidechain === true) return [];
		const out: MissionEvent[] = [];
		const push = (partial: EventWithoutId) => {
			const candidate = { ...partial, id: `${line_number}.${out.length}` };
			if (isMissionEvent(candidate)) out.push(candidate);
		};
		const content = isRecord(entry.message) ? entry.message.content : undefined;
		const blocks = Array.isArray(content) ? content.filter(isRecord) : [];

		if (entry.type === 'assistant') {
			if (entry.isApiErrorMessage === true) this.#turn.api_error = true;
			for (const block of blocks) {
				if (block.type === 'text') {
					const text = this.#text(block.text);
					if (text === undefined) continue;
					this.#turn.last_text = block.text as string;
					push({ type: 'assistant', text });
				} else if (block.type === 'thinking') {
					const text = this.#text(block.thinking);
					if (text !== undefined) push({ type: 'thinking', text });
				} else if (
					block.type === 'tool_use' &&
					typeof block.id === 'string' &&
					CALL_ID_PATTERN.test(block.id)
				) {
					const name = toolName(block.name);
					this.#tool_names.set(block.id, name);
					push({ type: 'tool_call', call_id: block.id, name, status: 'running' });
				}
			}
		} else if (entry.type === 'user') {
			// The prompt is the operator's turn, shown by the caller already; only close tools.
			for (const block of blocks) {
				if (
					block.type === 'tool_result' &&
					typeof block.tool_use_id === 'string' &&
					CALL_ID_PATTERN.test(block.tool_use_id)
				) {
					const name = this.#tool_names.get(block.tool_use_id) ?? 'tool';
					this.#tool_names.delete(block.tool_use_id);
					push({
						type: 'tool_call',
						call_id: block.tool_use_id,
						name,
						status: block.is_error === true ? 'failed' : 'completed'
					});
				}
			}
		} else if (entry.type === 'system' && entry.subtype === 'turn_duration') {
			this.#turn.ended = true;
			const duration = readDurationMs(entry.durationMs);
			if (duration !== undefined) this.#turn.duration_ms = duration;
		}
		return out;
	}
}

/** Claude Code's project directory name for a working directory. */
export function claudeProjectDir(cwd: string): string {
	return absolute(cwd, 'cwd').replace(/[^A-Za-z0-9]/g, '-');
}

export const claudeCode: AgentHarness = {
	app: 'claude-code',

	argv(launch) {
		if (!SESSION_ID_PATTERN.test(launch.session_id)) {
			throw new Error('session_id must be a lowercase UUID');
		}
		const args = [
			launch.command ?? 'claude',
			// The sandbox is the boundary (ADR-0015); the image pre-accepts the
			// warning this mode shows, so the launch needs no keypress.
			'--permission-mode',
			'bypassPermissions',
			launch.resume ? '--resume' : '--session-id',
			launch.session_id
		];
		if (launch.model !== undefined) {
			if (!MODEL_PATTERN.test(launch.model)) throw new Error('model is not a model name');
			args.push('--model', launch.model);
		}
		if (launch.effort !== undefined) {
			if (!EFFORT_PATTERN.test(launch.effort)) throw new Error('effort is not an effort level');
			args.push('--effort', launch.effort);
		}
		if (launch.append_system_prompt !== undefined) {
			args.push('--append-system-prompt', launch.append_system_prompt);
		}
		if (launch.mcp_config !== undefined) {
			args.push('--mcp-config', absolute(launch.mcp_config, 'mcp_config'));
		}
		return args;
	},

	transcriptPath(launch) {
		if (!SESSION_ID_PATTERN.test(launch.session_id)) {
			throw new Error('session_id must be a lowercase UUID');
		}
		const base = absolute(launch.config_dir, 'config_dir').replace(/\/+$/, '');
		return `${base}/projects/${claudeProjectDir(launch.cwd)}/${launch.session_id}.jsonl`;
	},

	mapper(redact) {
		return new ClaudeTranscriptMapper(redact);
	}
};
