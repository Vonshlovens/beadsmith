/**
 * ralph's vocabulary as Beadsmith uses it (ADR-0019): the loop commands and
 * harnesses of its command line (`ralph <mode> --harness …`), and the stop
 * reasons and iteration outcomes of its records. Shared by the request
 * schema, the `/v1` client and the loop UI, so the lists exist once. Kept
 * free of imports so the browser bundle can read it without the server
 * client and its stream readers.
 */

/** ralph's loop commands: `ralph run`, `plan`, `build` and `reverse`. */
export const RALPH_MODES = ['run', 'plan', 'build', 'reverse'] as const;
export type RalphMode = (typeof RALPH_MODES)[number];

/** Agent CLIs ralph can drive (`--harness`). */
export const RALPH_HARNESSES = ['claude', 'codex', 'opencode', 'gh'] as const;
export type RalphHarness = (typeof RALPH_HARNESSES)[number];

/**
 * The most iterations one loop may run. A loop always has an iteration
 * limit: an unbounded loop spends until someone notices, and a Sand sandbox
 * has a lifetime anyway.
 */
export const LOOP_MAX_ITERATIONS = 200;

/** Why a ralph run ended, as its run record names it. */
export const RALPH_STOP_REASONS = [
	'max_iterations',
	'complete',
	'plan_complete',
	'plan_exhausted',
	'plan_converged',
	'no_progress',
	'validate_failed',
	'scope_violation',
	'blocked',
	'rate_limited',
	'auth_failed',
	'harness_failed',
	'operator_stop',
	'interrupted',
	'crashed'
] as const;
export type RalphStopReason = (typeof RALPH_STOP_REASONS)[number];

/** How one iteration ended. */
export const RALPH_ITERATION_OUTCOMES = [
	'completed',
	'failed',
	'blocked',
	'rate_limited',
	'auth_failed',
	'timed_out',
	'interrupted'
] as const;
export type RalphIterationOutcome = (typeof RALPH_ITERATION_OUTCOMES)[number];

/** A stop reason as the end of "The loop ended after N iterations: …". */
export const RALPH_STOP_REASON_TEXT: Record<RalphStopReason, string> = {
	max_iterations: 'reached its iteration limit',
	complete: 'the agent reported the task complete',
	plan_complete: 'no open plan items are left',
	plan_exhausted: 'open plan items remain but none can be worked on',
	plan_converged: 'the plan stopped changing',
	no_progress: 'it stopped making progress',
	validate_failed: 'validation kept failing',
	scope_violation: 'an iteration changed files outside its mode',
	blocked: 'the agent was blocked',
	rate_limited: 'the model was rate limited',
	auth_failed: 'the model refused its credentials',
	harness_failed: 'the agent CLI failed',
	operator_stop: 'it was stopped',
	interrupted: 'it was interrupted',
	crashed: 'ralph stopped unexpectedly'
};
