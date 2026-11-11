/**
 * The one ralph client in Beadsmith (ADR-0019 rules 3 and 4): a fixed
 * allowlist of `ralph serve` `/v1` calls, ralph's run, iteration and report
 * records narrowed to what Beadsmith keeps, and one mapping from ralph's
 * events onto the sanitized MissionEvent union.
 *
 * The client does not know how it reaches ralph. `ralph serve --no-web`
 * listens on the sandbox's loopback, so each runner supplies a
 * {@link RalphFetch} over a channel it already holds: on Sand, commands over
 * the E2B process channel; on forge, the runner's signed relay. Both runners
 * share this module, so the allowlist, the narrowing and the event mapping
 * exist once. Raw ralph payloads never leave this file: tool inputs and
 * outputs, prompts, validation output, log paths and session locators are
 * dropped here, and every text that survives goes through the sanitizer and
 * the Dolt password scrubber.
 *
 * Beadsmith never calls `POST /v1/runs`, `restart` or the schedule routes: a
 * loop starts as `ralph <mode>` in an hc terminal and restarts as a new
 * terminal (ADR-0019 rule 2), so every run stays inside hc and dispatch.
 */
import { isMissionEvent, type MissionEvent } from '#lib/mission-events.js';
import type { LoopIteration } from '#lib/types.js';
import { readSseStream } from '../mate/runner.js';
import type { AgentRunStatus, AgentStreamOutcome } from './provider.js';
import {
	RALPH_ITERATION_OUTCOMES,
	RALPH_MODES,
	RALPH_STEER_MAX_LENGTH,
	RALPH_STOP_REASON_TEXT,
	RALPH_STOP_REASONS,
	type RalphIterationOutcome,
	type RalphMode,
	type RalphStopReason
} from '#lib/ralph.js';
import { readDurationMs, sanitizeResultSummary } from './sanitize.js';

/** ralph's own run name rule; Beadsmith addresses a run by the name it launched it with. */
const RUN_NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** Bounds on what a report may carry into state.db. */
const REPORT_MAX_COMMITS = 200;
const REPORT_MAX_NOTES = 50;

// ------------------------------------------------------------------ transport

export type RalphMethod = 'GET' | 'POST';

export interface RalphRequest {
	method: RalphMethod;
	/** Always an allowlisted `/v1` path with no query (see {@link ralphRouteAllowed}). */
	path: string;
	headers: Record<string, string>;
	body?: string;
	signal?: AbortSignal;
}

/**
 * Reach `ralph serve` inside the runner. The implementation owns the channel
 * (and refuses anything {@link ralphRouteAllowed} refuses, if it relays for
 * someone else); the client owns what is asked and how answers are read.
 */
export type RalphFetch = (request: RalphRequest) => Promise<Response>;

const RUN_ROUTE = /^\/v1\/runs\/([A-Za-z0-9._-]{1,100})(\/report|\/stream|\/steer|\/stop)?$/;

/**
 * The ADR-0019 allowlist: run detail (with its iterations), report, the event
 * stream, steer and stop. Nothing else, and no query strings: the stream
 * resumes with `Last-Event-ID`. A relay that forwards requests to ralph
 * checks every request with this function.
 */
export function ralphRouteAllowed(method: string, path: string): boolean {
	const match = RUN_ROUTE.exec(path);
	// `.` and `..` are valid ralph names but would climb out of the run path in a relay.
	if (match === null || /^\.+$/.test(match[1])) return false;
	const suffix = match[2] ?? '';
	if (method === 'GET') return suffix === '' || suffix === '/report' || suffix === '/stream';
	if (method === 'POST') return suffix === '/steer' || suffix === '/stop';
	return false;
}

export class RalphError extends Error {
	/** HTTP status from ralph, or 0 when ralph was not reached or answered nonsense. */
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = 'RalphError';
		this.status = status;
	}
}

// ------------------------------------------------------------------ records

export type RalphRunState = 'running' | 'finished' | 'failed' | 'stopped';

/** A run as Beadsmith keeps it: no directory, prompt, pid or callback. */
export interface RalphRun {
	id: string;
	name: string;
	mode: RalphMode;
	status: RalphRunState;
	/** False once ralph's process is gone, even if its record still says running. */
	alive: boolean;
	current_iteration: number;
	max_iterations: number;
	stop_reason: RalphStopReason | null;
	started_at: string;
	updated_at: string;
	input_tokens: number;
	output_tokens: number;
	cost_usd: number;
}

/**
 * One finished iteration as ralph reports it: the wire {@link LoopIteration}
 * without the Beadsmith run it belongs to (ADR-0019 rule 5).
 */
export type RalphIteration = Omit<LoopIteration, 'run_id'>;

export interface RalphRunDetail {
	run: RalphRun;
	iterations: RalphIteration[];
}

/** A run's end-of-run summary, without diffs, validation output or log paths. */
export interface RalphReport {
	stop_reason: RalphStopReason | null;
	iterations: number;
	duration_ms: number;
	input_tokens: number;
	output_tokens: number;
	cost_usd: number;
	/** `git log --oneline` lines for the run's commit range, sanitized. */
	commits: string[];
	plan: {
		open_before: number | null;
		open_after: number | null;
		ready_after: number | null;
	} | null;
	validate: { runs: number; failures: number };
	/** Why a person should look, in ralph's words, sanitized. */
	needs_person: string[];
}

export type RalphStopState = 'not_running' | 'already_gone' | 'stopping' | 'stopped' | 'killed';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | undefined {
	return typeof value === 'string' && (values as readonly string[]).includes(value)
		? (value as T)
		: undefined;
}

function count(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function money(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nullableCount(value: unknown): number | null | undefined {
	return value === null ? null : count(value);
}

function timestamp(value: unknown): string | undefined {
	return typeof value === 'string' && value.length <= 64 && !Number.isNaN(Date.parse(value))
		? value
		: undefined;
}

function commitHash(value: unknown): string | null | undefined {
	if (value === null) return null;
	return typeof value === 'string' && /^[0-9a-f]{7,64}$/.test(value) ? value : undefined;
}

function invalid(what: string): RalphError {
	return new RalphError(0, `ralph sent an unreadable ${what}.`);
}

/** Narrow ralph's run summary (`GET /v1/runs/:id` `run`). */
export function parseRalphRun(value: unknown): RalphRun {
	if (!isRecord(value)) throw invalid('run');
	const id = typeof value.id === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value.id);
	const name = typeof value.name === 'string' && RUN_NAME_PATTERN.test(value.name);
	const mode = oneOf(RALPH_MODES, value.mode);
	const status = oneOf(['running', 'finished', 'failed', 'stopped'] as const, value.status);
	const stop_reason =
		value.stopReason === null ? null : oneOf(RALPH_STOP_REASONS, value.stopReason);
	const current_iteration = count(value.currentIteration);
	const max_iterations = count(value.maxIterations);
	const started_at = timestamp(value.startedAt);
	const updated_at = timestamp(value.updatedAt);
	if (
		!id ||
		!name ||
		mode === undefined ||
		status === undefined ||
		// An unknown stop reason (a newer ralph) reads as no reason; the exit code decides.
		current_iteration === undefined ||
		max_iterations === undefined ||
		started_at === undefined ||
		updated_at === undefined
	) {
		throw invalid('run');
	}
	return {
		id: value.id as string,
		name: value.name as string,
		mode,
		status,
		alive: value.alive === true,
		current_iteration,
		max_iterations,
		stop_reason: stop_reason ?? null,
		started_at,
		updated_at,
		input_tokens: count(value.inputTokens) ?? 0,
		output_tokens: count(value.outputTokens) ?? 0,
		cost_usd: money(value.costUsd) ?? 0
	};
}

/** Narrow one iteration record; undefined when it is not one. */
export function parseRalphIteration(value: unknown): RalphIteration | undefined {
	if (!isRecord(value)) return undefined;
	const iteration = count(value.iteration);
	const outcome = oneOf(RALPH_ITERATION_OUTCOMES, value.outcome);
	const started_at = timestamp(value.startedAt);
	const finished_at = timestamp(value.finishedAt);
	const duration_ms = readDurationMs(value.durationMs);
	const head_before = commitHash(value.headBefore);
	const head_after = commitHash(value.headAfter);
	const plan_open = nullableCount(value.planOpen);
	if (
		iteration === undefined ||
		outcome === undefined ||
		started_at === undefined ||
		finished_at === undefined ||
		duration_ms === undefined ||
		head_before === undefined ||
		head_after === undefined ||
		plan_open === undefined
	) {
		return undefined;
	}
	return {
		iteration,
		outcome,
		started_at,
		finished_at,
		duration_ms,
		head_before,
		head_after,
		input_tokens: count(value.inputTokens) ?? 0,
		output_tokens: count(value.outputTokens) ?? 0,
		cost_usd: value.costUsd === null ? null : (money(value.costUsd) ?? null),
		validate_ok: typeof value.validateOk === 'boolean' ? value.validateOk : null,
		plan_open
	};
}

function sanitizedLines(value: unknown, max: number, secret: string): string[] {
	if (!Array.isArray(value)) return [];
	const lines: string[] = [];
	for (const item of value.slice(0, max)) {
		const text = sanitizeResultSummary(item, secret);
		if (text !== undefined) lines.push(text.split('\n', 1)[0] ?? text);
	}
	return lines;
}

/** Narrow ralph's report (`GET /v1/runs/:id/report`). */
export function parseRalphReport(value: unknown, secret: string): RalphReport {
	if (!isRecord(value)) throw invalid('report');
	const tokens = isRecord(value.tokens) ? value.tokens : {};
	const validate = isRecord(value.validate) ? value.validate : {};
	const plan = isRecord(value.plan) ? value.plan : undefined;
	const before = plan !== undefined && isRecord(plan.before) ? plan.before : {};
	const after = plan !== undefined && isRecord(plan.after) ? plan.after : {};
	return {
		stop_reason:
			value.stopReason === null ? null : (oneOf(RALPH_STOP_REASONS, value.stopReason) ?? null),
		iterations: count(value.iterations) ?? 0,
		duration_ms: readDurationMs(value.durationMs) ?? 0,
		input_tokens: count(tokens.input) ?? 0,
		output_tokens: count(tokens.output) ?? 0,
		cost_usd: money(value.costUsd) ?? 0,
		commits: sanitizedLines(value.commits, REPORT_MAX_COMMITS, secret),
		plan:
			plan === undefined
				? null
				: {
						open_before: count(before.open) ?? null,
						open_after: count(after.open) ?? null,
						ready_after: count(after.ready) ?? null
					},
		validate: { runs: count(validate.runs) ?? 0, failures: count(validate.failures) ?? 0 },
		needs_person: sanitizedLines(value.needsHuman, REPORT_MAX_NOTES, secret)
	};
}

// ------------------------------------------------------------------ outcome

export interface RalphOutcome {
	/** A finished run's status: never `running`. */
	status: Exclude<AgentRunStatus, 'running'>;
	/** The loop ended on its own but left something for a person (exit 3). */
	needs_person: boolean;
}

/**
 * How a finished loop maps onto mission status (ADR-0019 rule 4): 0
 * succeeded, 3 (plan exhausted, no progress) succeeded and needing a person,
 * an operator stop cancelled, anything else failed.
 *
 * The stop reason wins over the exit code when both are known, because
 * ralph exits 0 after a graceful operator stop and 130 when interrupted: the
 * code alone cannot tell "finished" from "stopped". The code decides only
 * when the reason is unknown (ralph died before recording one, or a newer
 * ralph sent a reason this file does not know).
 */
export function ralphOutcome(input: {
	stop_reason?: RalphStopReason | null;
	exit_code?: number | null;
}): RalphOutcome {
	switch (input.stop_reason) {
		case 'complete':
		case 'plan_complete':
		case 'plan_converged':
		case 'max_iterations':
			return { status: 'succeeded', needs_person: false };
		case 'plan_exhausted':
		case 'no_progress':
			return { status: 'succeeded', needs_person: true };
		case 'operator_stop':
		case 'interrupted':
			return { status: 'cancelled', needs_person: false };
		case undefined:
		case null:
			break;
		default:
			return { status: 'failed', needs_person: false };
	}
	switch (input.exit_code) {
		case 0:
			return { status: 'succeeded', needs_person: false };
		case 3:
			return { status: 'succeeded', needs_person: true };
		case 130:
			return { status: 'cancelled', needs_person: false };
		default:
			return { status: 'failed', needs_person: false };
	}
}

/** One sentence for the mission thread about why a loop ended. */
export function describeRalphStop(reason: RalphStopReason | null, iterations: number): string {
	const ran = `${iterations} ${iterations === 1 ? 'iteration' : 'iterations'}`;
	if (reason === null) return `The loop ended after ${ran}.`;
	const needs = ralphOutcome({ stop_reason: reason }).needs_person ? ' A person should look.' : '';
	return `The loop ended after ${ran}: ${RALPH_STOP_REASON_TEXT[reason]}.${needs}`;
}

// ------------------------------------------------------------------ events

/**
 * The ralph events Beadsmith reads, narrowed to the fields it uses. Every
 * other event type (usage, plan snapshots, observer summaries, notices, …)
 * is dropped when parsed; tool inputs and outputs, prompts and validation
 * output never get this far.
 */
export type RalphEvent = { iteration: number } & (
	| { type: 'assistant'; text: string }
	| { type: 'thinking'; text: string }
	| { type: 'tool_call'; name: string }
	| { type: 'tool_result'; is_error: boolean }
	| { type: 'error'; message: string }
	| { type: 'needs_input'; reason: string }
	| { type: 'iteration_started' }
	| { type: 'iteration_finished'; outcome: RalphIterationOutcome; duration_ms: number }
	| { type: 'validate'; ok: boolean }
	| { type: 'steer_received'; kind: 'note' | 'stop'; text: string }
	| { type: 'run_finished'; reason: RalphStopReason | null; iterations: number }
);

export interface RalphStreamEntry {
	/** ralph's event id, the stream's resume cursor. */
	id: string;
	event: RalphEvent;
}

/** Read one ralph event payload; undefined for types Beadsmith ignores or malformed ones. */
export function parseRalphEvent(value: unknown): RalphEvent | undefined {
	if (!isRecord(value)) return undefined;
	const iteration = count(value.iteration) ?? 0;
	const text = (key: string) => (typeof value[key] === 'string' ? (value[key] as string) : '');
	switch (value.type) {
		case 'assistant':
		case 'thinking':
			return { type: value.type, iteration, text: text('text') };
		case 'tool_call':
			return { type: 'tool_call', iteration, name: text('name') };
		case 'tool_result':
			return { type: 'tool_result', iteration, is_error: value.isError === true };
		case 'error':
			return { type: 'error', iteration, message: text('message') };
		case 'needs_input':
			return { type: 'needs_input', iteration, reason: text('reason') };
		case 'iteration_started':
			return { type: 'iteration_started', iteration };
		case 'iteration_finished': {
			const outcome = oneOf(RALPH_ITERATION_OUTCOMES, value.outcome);
			if (outcome === undefined) return undefined;
			return {
				type: 'iteration_finished',
				iteration,
				outcome,
				duration_ms: readDurationMs(value.durationMs) ?? 0
			};
		}
		case 'validate':
			return typeof value.ok === 'boolean'
				? { type: 'validate', iteration, ok: value.ok }
				: undefined;
		case 'steer_received': {
			const kind = oneOf(['note', 'stop'] as const, value.kind);
			return kind === undefined
				? undefined
				: { type: 'steer_received', iteration, kind, text: text('text') };
		}
		case 'run_finished':
			return {
				type: 'run_finished',
				iteration,
				reason: oneOf(RALPH_STOP_REASONS, value.reason) ?? null,
				iterations: count(value.iterations) ?? iteration
			};
		default:
			return undefined;
	}
}

function toolName(value: string): string {
	// MCP tools arrive as mcp__server__tool; keep a renderable name.
	const name = value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
	return TOOL_NAME_PATTERN.test(name) ? name : 'tool';
}

/**
 * ralph's events onto MissionEvents, one stream at a time. Each MissionEvent
 * takes the ralph event id, so the browser's `Last-Event-ID` resumes ralph's
 * stream directly.
 *
 * ralph's tool events carry no call id: a `tool_result` answers the oldest
 * open `tool_call` of the same iteration, which is how the harnesses ralph
 * runs report them. A result whose call is not known (the stream resumed
 * between the two) is dropped; the call stays shown as running.
 */
export class RalphEventMapper {
	readonly #secret: string;
	#open: Array<{ call_id: string; name: string; iteration: number }> = [];

	constructor(secret: string) {
		this.#secret = secret;
	}

	map(entry: RalphStreamEntry): MissionEvent | undefined {
		const event = this.#map(entry);
		return event !== undefined && isMissionEvent(event) ? event : undefined;
	}

	#text(value: string): string | undefined {
		return sanitizeResultSummary(value, this.#secret);
	}

	#map({ id, event }: RalphStreamEntry): MissionEvent | undefined {
		switch (event.type) {
			case 'assistant':
			case 'thinking': {
				const text = this.#text(event.text);
				return text === undefined ? undefined : { type: event.type, id, text };
			}
			case 'tool_call': {
				const call = {
					call_id: `${event.iteration}.${id}`,
					name: toolName(event.name),
					iteration: event.iteration
				};
				this.#open.push(call);
				return { type: 'tool_call', id, call_id: call.call_id, name: call.name, status: 'running' };
			}
			case 'tool_result': {
				const index = this.#open.findIndex((call) => call.iteration === event.iteration);
				if (index === -1) return undefined;
				const [call] = this.#open.splice(index, 1);
				return {
					type: 'tool_call',
					id,
					call_id: call.call_id,
					name: call.name,
					status: event.is_error ? 'failed' : 'completed'
				};
			}
			case 'iteration_started':
				// A new agent session: calls the last one left open will never answer.
				this.#open = [];
				return undefined;
			case 'error': {
				const message = this.#text(event.message);
				return message === undefined ? undefined : { type: 'error', id, message };
			}
			case 'needs_input': {
				const reason = this.#text(event.reason);
				const message = `Iteration ${event.iteration} needs a person${reason === undefined ? '.' : `: ${reason}`}`;
				return { type: 'error', id, message };
			}
			case 'validate':
				return event.ok
					? undefined
					: { type: 'error', id, message: `Validation failed after iteration ${event.iteration}.` };
			case 'steer_received': {
				if (event.kind !== 'note') return undefined;
				const text = this.#text(event.text);
				return text === undefined ? undefined : { type: 'user', id, text };
			}
			case 'run_finished':
				this.#open = [];
				return {
					type: 'result',
					id,
					status: ralphOutcome({ stop_reason: event.reason }).status,
					text: describeRalphStop(event.reason, event.iterations)
				};
			case 'iteration_finished':
				// Iterations reach the mission as records (getRun), not as thread events.
				return undefined;
		}
	}
}

// ------------------------------------------------------------------ client

export interface RalphStreamOptions {
	/** Resume after this ralph event id (the last MissionEvent id the caller saw). */
	last_event_id?: string;
	signal?: AbortSignal;
}

/** The allowlisted `/v1` calls for one runner's ralph. */
export class RalphClient {
	readonly #fetch: RalphFetch;
	readonly #secret: string;

	/**
	 * @param fetch reaches `ralph serve` inside the runner.
	 * @param secret scrubbed from every text that crosses (the project's Dolt password).
	 */
	constructor(fetch: RalphFetch, secret: string) {
		this.#fetch = fetch;
		this.#secret = secret;
	}

	async getRun(name: string): Promise<RalphRunDetail> {
		const body = await this.#json('GET', runPath(name));
		if (!isRecord(body)) throw invalid('run');
		const iterations = Array.isArray(body.iterations)
			? body.iterations.flatMap((item) => parseRalphIteration(item) ?? [])
			: [];
		return { run: parseRalphRun(body.run), iterations };
	}

	async getReport(name: string): Promise<RalphReport> {
		return parseRalphReport(await this.#json('GET', `${runPath(name)}/report`), this.#secret);
	}

	/** Queue a note for the loop's next iteration; returns ralph's steer id. */
	async steer(name: string, text: string): Promise<number> {
		const note = text.trim();
		if (note.length === 0 || note.length > RALPH_STEER_MAX_LENGTH) {
			throw new RalphError(400, `A steer note must be 1 to ${RALPH_STEER_MAX_LENGTH} characters.`);
		}
		const body = await this.#json('POST', `${runPath(name)}/steer`, { text: note });
		const id = isRecord(body) ? count(body.steerId) : undefined;
		if (id === undefined) throw invalid('steer answer');
		return id;
	}

	/** Stop after the current iteration (`graceful`), or now. */
	async stop(name: string, options: { graceful: boolean }): Promise<RalphStopState> {
		const body = await this.#json('POST', `${runPath(name)}/stop`, { graceful: options.graceful });
		const state = isRecord(body)
			? oneOf(['not_running', 'already_gone', 'stopping', 'stopped', 'killed'] as const, body.state)
			: undefined;
		if (state === undefined) throw invalid('stop answer');
		return state;
	}

	/**
	 * Follow a run's events until ralph ends the stream. `terminal`: ralph
	 * sent its `end` frame (the run finished or its process is gone);
	 * `disconnected`: the channel closed first, so resume from the last id.
	 */
	async streamEvents(
		name: string,
		on_event: (entry: RalphStreamEntry) => Promise<void> | void,
		options: RalphStreamOptions = {}
	): Promise<AgentStreamOutcome> {
		const headers: Record<string, string> = { accept: 'text/event-stream' };
		const resume = options.last_event_id;
		if (resume !== undefined) {
			if (!/^[0-9]{1,15}$/.test(resume)) throw new RalphError(400, 'Not a ralph event id.');
			headers['last-event-id'] = resume;
		}
		const response = await this.#send({
			method: 'GET',
			path: `${runPath(name)}/stream`,
			headers,
			signal: options.signal
		});
		if (response.body === null) return 'disconnected';
		let ended = false;
		await readSseStream(response.body, async (frame) => {
			if (ended) return;
			if (frame.event === 'end') {
				ended = true;
				return;
			}
			if (frame.event === 'error') return;
			const id = frame.id?.trim();
			if (id === undefined || !/^[0-9]{1,15}$/.test(id)) return;
			let payload: unknown;
			try {
				payload = JSON.parse(frame.data);
			} catch {
				return;
			}
			const event = parseRalphEvent(payload);
			if (event !== undefined) await on_event({ id, event });
		});
		return ended ? 'terminal' : 'disconnected';
	}

	async #json(method: RalphMethod, path: string, body?: unknown): Promise<unknown> {
		const response = await this.#send({
			method,
			path,
			headers:
				body === undefined
					? { accept: 'application/json' }
					: { accept: 'application/json', 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		});
		try {
			return await response.json();
		} catch {
			throw invalid('answer');
		}
	}

	async #send(request: RalphRequest): Promise<Response> {
		if (!ralphRouteAllowed(request.method, request.path)) {
			throw new RalphError(400, 'Beadsmith does not call that ralph route.');
		}
		let response: Response;
		try {
			response = await this.#fetch(request);
		} catch (error) {
			if (request.signal?.aborted) throw error;
			throw new RalphError(0, 'ralph could not be reached.');
		}
		if (!response.ok) {
			await response.body?.cancel();
			throw new RalphError(
				response.status,
				response.status === 404 ? 'ralph has no such run.' : `ralph answered ${response.status}.`
			);
		}
		return response;
	}
}

function runPath(name: string): string {
	if (!RUN_NAME_PATTERN.test(name) || /^\.+$/.test(name))
		throw new RalphError(400, 'Not a ralph run name.');
	return `/v1/runs/${name}`;
}
