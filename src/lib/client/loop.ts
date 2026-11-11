/**
 * How the loop UI reads a ralph loop mission (ADR-0019 rule 5): its flags,
 * why it ended, and its iterations grouped by run. Pure functions, so the
 * thread and the Missions list share one reading and tests cover every state
 * without a DOM.
 */
import { RALPH_STOP_REASON_TEXT, type RalphIterationOutcome } from '#lib/ralph.js';
import type { DispatchLoop, DispatchRequest, LoopIteration } from '#lib/types.js';

/** The Missions page's kind filter. */
export const MISSION_KINDS = ['all', 'loop', 'one_shot'] as const;
export type MissionKind = (typeof MISSION_KINDS)[number];

export const MISSION_KIND_LABEL: Record<MissionKind, string> = {
	all: 'All',
	loop: 'Loops',
	one_shot: 'One-shot'
};

/** Whether a mission is a ralph loop or a single agent run. */
export function missionKind(
	mission: Pick<DispatchRequest, 'operation'>
): Exclude<MissionKind, 'all'> {
	return mission.operation === 'loop' ? 'loop' : 'one_shot';
}

/** The missions a kind filter keeps, in their original order. */
export function filterMissions<T extends Pick<DispatchRequest, 'operation'>>(
	missions: readonly T[],
	kind: MissionKind
): T[] {
	return kind === 'all' ? [...missions] : missions.filter((m) => missionKind(m) === kind);
}

/**
 * The loop's flags as one line: `build · claude · opus · high · up to 20`.
 * Absent flags are ralph's defaults and are left out rather than guessed.
 */
export function loopFlagsLine(loop: DispatchLoop): string {
	const parts: string[] = [loop.mode];
	if (loop.harness !== undefined) parts.push(loop.harness);
	if (loop.model !== undefined) parts.push(loop.model);
	if (loop.effort !== undefined) parts.push(loop.effort);
	if (loop.max_iterations !== undefined) {
		parts.push(
			`up to ${loop.max_iterations} ${loop.max_iterations === 1 ? 'iteration' : 'iterations'}`
		);
	}
	if (loop.iteration_timeout_minutes !== undefined) {
		parts.push(`${loop.iteration_timeout_minutes} min each`);
	}
	return parts.join(' · ');
}

/**
 * Why the loop's current run ended, in the wording the run's closing reply
 * uses (`Ended: validation kept failing`); undefined while it runs or when
 * ralph recorded no reason.
 */
export function loopStopText(loop: DispatchLoop | undefined): string | undefined {
	if (loop?.stop_reason === undefined) return undefined;
	return `Ended: ${RALPH_STOP_REASON_TEXT[loop.stop_reason]}`;
}

/** The iteration outcome as the table shows it. */
export const ITERATION_OUTCOME_LABEL: Record<RalphIterationOutcome, string> = {
	completed: 'completed',
	failed: 'failed',
	blocked: 'blocked',
	rate_limited: 'rate limited',
	auth_failed: 'auth failed',
	timed_out: 'timed out',
	interrupted: 'interrupted'
};

/**
 * The status badge colour for an outcome, reusing the bead badge keys:
 * completed reads as done, a failure as blocked, the rest as dim.
 */
export function outcomeBadgeKey(outcome: RalphIterationOutcome): 'closed' | 'blocked' | 'deferred' {
	if (outcome === 'completed') return 'closed';
	if (outcome === 'interrupted') return 'deferred';
	return 'blocked';
}

/** One run of a loop: a restart starts a new one with its own iterations. */
export interface LoopRun {
	run_id: string;
	/** 1-based, in the order the runs started. */
	number: number;
	iterations: LoopIteration[];
	input_tokens: number;
	output_tokens: number;
	/** null when no iteration reported a cost. */
	cost_usd: number | null;
	duration_ms: number;
}

/** Iterations grouped by run, runs and iterations oldest first. */
export function loopRuns(iterations: readonly LoopIteration[]): LoopRun[] {
	const runs = new Map<string, LoopRun>();
	for (const it of iterations) {
		let run = runs.get(it.run_id);
		if (run === undefined) {
			run = {
				run_id: it.run_id,
				number: runs.size + 1,
				iterations: [],
				input_tokens: 0,
				output_tokens: 0,
				cost_usd: null,
				duration_ms: 0
			};
			runs.set(it.run_id, run);
		}
		run.iterations.push(it);
		run.input_tokens += it.input_tokens;
		run.output_tokens += it.output_tokens;
		run.duration_ms += it.duration_ms;
		if (it.cost_usd !== null) run.cost_usd = (run.cost_usd ?? 0) + it.cost_usd;
	}
	for (const run of runs.values()) {
		run.iterations.sort((a, b) => a.iteration - b.iteration);
	}
	return [...runs.values()];
}

/** The total over every run; null when no iteration reported a cost. */
export function totalCost(runs: readonly LoopRun[]): number | null {
	let total: number | null = null;
	for (const run of runs) {
		if (run.cost_usd !== null) total = (total ?? 0) + run.cost_usd;
	}
	return total;
}

/** `$0.42`, `<$0.01`, or an em dash when the harness reported no cost. */
export function formatCost(usd: number | null): string {
	if (usd === null) return '—';
	if (usd > 0 && usd < 0.01) return '<$0.01';
	return `$${usd.toFixed(2)}`;
}

/**
 * What an iteration did to the branch: `a1b2c3d..e4f5a6b`, `no commits`
 * when the head did not move, or undefined when ralph did not record it.
 */
export function commitRange(
	it: Pick<LoopIteration, 'head_before' | 'head_after'>
): string | undefined {
	if (it.head_before === null || it.head_after === null) return undefined;
	if (it.head_before === it.head_after) return 'no commits';
	return `${it.head_before.slice(0, 7)}..${it.head_after.slice(0, 7)}`;
}

/** Validation as a word: passed, failed, or undefined when it did not run. */
export function validateText(ok: boolean | null): 'passed' | 'failed' | undefined {
	if (ok === null) return undefined;
	return ok ? 'passed' : 'failed';
}
