/**
 * How the loop UI reads a ralph loop mission (ADR-0019 rule 5): its flags,
 * why it ended, and its iterations grouped by run. Pure functions, so the
 * thread and the Missions list share one reading and tests cover every state
 * without a DOM.
 */
import { agentAvailability, type AgentAvailability } from '#lib/client/agent.js';
import {
	LOOP_MAX_ITERATIONS,
	RALPH_STOP_REASON_TEXT,
	type RalphHarness,
	type RalphIterationOutcome,
	type RalphMode
} from '#lib/ralph.js';
import type {
	DispatchLoop,
	DispatchProjectAllow,
	DispatchProviderId,
	DispatchProviderInfo,
	DispatchRequest,
	LoopIteration,
	StatusSnapshot
} from '#lib/types.js';

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

/**
 * Where a loop is started from. The bead, when there is one, is what a
 * single-bead loop works on; its type tells an epic apart, because ralph has
 * no epic scope yet (ADR-0019 rule 6) and the dialog has to say so.
 */
export interface LoopTarget {
	project_id: string;
	issue?: { id: string; title: string; issue_type: string };
}

export type LoopScope = 'project' | 'epic' | 'issue';

/** The page a loop is started from: a project, an epic, or another bead. */
export function loopScope(target: Pick<LoopTarget, 'issue'>): LoopScope {
	if (target.issue === undefined) return 'project';
	return target.issue.issue_type === 'epic' ? 'epic' : 'issue';
}

/** One way to start a loop, with ralph's mode and a sensible iteration limit. */
export interface LoopPreset {
	id: 'bead' | 'build' | 'plan';
	label: string;
	hint: string;
	mode: Extract<RalphMode, 'build' | 'plan'>;
	/** Narrow the loop to the target bead (`ralph build --bead`). */
	on_bead: boolean;
	max_iterations: number;
}

/**
 * The presets a scope offers, the one that fits the page first. A bead page
 * leads with a loop on that bead; every scope can build or refresh the whole
 * plan. The limits are starting points: a plan settles in a few passes, a
 * build works through many items.
 */
export function loopPresets(scope: LoopScope): LoopPreset[] {
	const build: LoopPreset = {
		id: 'build',
		label: 'Build the plan',
		hint:
			scope === 'epic'
				? 'Works through the open items of the whole project plan, one per iteration. A loop cannot be limited to this epic yet.'
				: 'Works through the open items of the project plan, one per iteration.',
		mode: 'build',
		on_bead: false,
		max_iterations: 20
	};
	const plan: LoopPreset = {
		id: 'plan',
		label: 'Plan the project',
		hint: 'Reads the specs and code and refreshes the plan. Changes no code.',
		mode: 'plan',
		on_bead: false,
		max_iterations: 5
	};
	if (scope === 'project') return [build, plan];
	const bead: LoopPreset = {
		id: 'bead',
		label: scope === 'epic' ? 'Loop on this epic' : 'Tackle in a loop',
		hint:
			scope === 'epic'
				? 'Builds this epic as one bead until it is done. Its children are not picked up.'
				: 'Builds this bead, iterating until it is done or the limit is reached.',
		mode: 'build',
		on_bead: true,
		max_iterations: 10
	};
	return [bead, build, plan];
}

/**
 * The provider a new launch goes to: the viewer's "Runs on" pick when it
 * names one, else the server default, with what it can do.
 */
export function launchRunner(
	dispatch: StatusSnapshot['dispatch'],
	picked: DispatchProviderId | undefined
): DispatchProviderInfo | undefined {
	const id = picked ?? (dispatch.provider === 'none' ? undefined : dispatch.provider);
	if (id === undefined) return undefined;
	const listed = dispatch.providers?.find((entry) => entry.id === id);
	if (listed !== undefined) return listed;
	// A server without the providers list reports only its default's capabilities.
	return id === dispatch.provider && dispatch.capabilities !== undefined
		? { id, label: id, capabilities: dispatch.capabilities }
		: undefined;
}

/**
 * Whether to offer a loop, and whether it would start. Hidden from viewers
 * who may not launch (members) and on services where no runner has ralph.
 * Disabled with the most actionable reason first: dispatch disarmed, the
 * picked runner has no ralph (and which one does), Tackle not allowed. A
 * loop changes code and the plan, so it needs Tackle like a Tackle does.
 *
 * @param status - Latest health snapshot.
 * @param allow - The project's File/Tackle allow, when known.
 * @param picked - The viewer's "Runs on" provider, when they picked one.
 */
export function loopAvailability(
	status: Pick<StatusSnapshot, 'dispatch'> | null,
	allow?: DispatchProjectAllow,
	picked?: DispatchProviderId
): AgentAvailability {
	const agent = agentAvailability(status, allow);
	if (status === null || !agent.visible) return { visible: false, enabled: false };
	const { dispatch } = status;
	const runner = launchRunner(dispatch, picked);
	const loopers = (dispatch.providers ?? (runner === undefined ? [] : [runner])).filter(
		(entry) => entry.capabilities.loop
	);
	if (loopers.length === 0) return { visible: false, enabled: false };
	if (!agent.enabled) return agent;
	if (runner?.capabilities.loop !== true) {
		const other = loopers[0]!;
		return {
			visible: true,
			enabled: false,
			reason: `${runner?.label ?? 'This runner'} does not run loops. Pick ${other.label} under Runs on.`
		};
	}
	if (allow !== undefined && !allow.tackle) {
		return { visible: true, enabled: false, reason: 'Loops need Tackle allowed for this project.' };
	}
	return { visible: true, enabled: true };
}

/**
 * Why an iteration limit typed in the dialog would be refused, mirroring the
 * request schema (1 to {@link LOOP_MAX_ITERATIONS}); undefined when it is fine.
 */
export function iterationLimitError(raw: string): string | undefined {
	const max = LOOP_MAX_ITERATIONS;
	const text = raw.trim();
	if (!/^\d+$/.test(text)) return 'Enter a whole number of iterations.';
	const value = Number(text);
	if (value < 1 || value > max) return `Between 1 and ${max} iterations.`;
	return undefined;
}

/** The loop fields of a launch body, before the idempotency key and runner. */
export interface LoopLaunch {
	mode: RalphMode;
	max_iterations: number;
	issue_id?: string;
	harness?: RalphHarness;
}

/**
 * The launch for a preset. No harness means ralph's own default, so the
 * field is left out rather than guessed.
 */
export function loopLaunch(
	preset: LoopPreset,
	target: Pick<LoopTarget, 'issue'>,
	settings: { max_iterations: number; harness?: RalphHarness }
): LoopLaunch {
	return {
		mode: preset.mode,
		max_iterations: settings.max_iterations,
		...(preset.on_bead && target.issue !== undefined ? { issue_id: target.issue.id } : {}),
		...(settings.harness === undefined ? {} : { harness: settings.harness })
	};
}
