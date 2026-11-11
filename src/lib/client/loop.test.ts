import { describe, expect, it } from 'vitest';
import {
	commitRange,
	filterMissions,
	formatCost,
	iterationLimitError,
	loopAvailability,
	loopFlagsLine,
	loopLaunch,
	loopPresets,
	loopScope,
	loopRuns,
	loopStopText,
	missionKind,
	outcomeBadgeKey,
	totalCost,
	validateText
} from './loop.js';
import type {
	DispatchCapabilities,
	DispatchHealth,
	DispatchProviderInfo,
	LoopIteration
} from '#lib/types.js';

function iteration(patch: Partial<LoopIteration> = {}): LoopIteration {
	return {
		run_id: 'run-a',
		iteration: 1,
		outcome: 'completed',
		started_at: '2026-11-11T10:00:00Z',
		finished_at: '2026-11-11T10:05:00Z',
		duration_ms: 300_000,
		head_before: 'aaaaaaa1111',
		head_after: 'bbbbbbb2222',
		input_tokens: 1000,
		output_tokens: 200,
		cost_usd: 0.25,
		validate_ok: true,
		plan_open: 4,
		...patch
	};
}

describe('loopRuns', () => {
	it('is empty before any iteration finishes', () => {
		expect(loopRuns([])).toEqual([]);
		expect(totalCost([])).toBeNull();
	});

	it('keeps a running loop as one run, iterations in order, with totals', () => {
		const runs = loopRuns([iteration({ iteration: 2, cost_usd: 0.5 }), iteration()]);
		expect(runs).toHaveLength(1);
		expect(runs[0].iterations.map((it) => it.iteration)).toEqual([1, 2]);
		expect(runs[0]).toMatchObject({
			number: 1,
			input_tokens: 2000,
			output_tokens: 400,
			cost_usd: 0.75,
			duration_ms: 600_000
		});
	});

	it('groups a restarted loop by run, in the order the runs started', () => {
		const runs = loopRuns([
			iteration({ run_id: 'run-a', iteration: 1 }),
			iteration({ run_id: 'run-a', iteration: 2 }),
			iteration({ run_id: 'run-b', iteration: 1, cost_usd: null }),
			iteration({ run_id: 'run-b', iteration: 2, cost_usd: 1 })
		]);
		expect(runs.map((run) => [run.run_id, run.number, run.iterations.length])).toEqual([
			['run-a', 1, 2],
			['run-b', 2, 2]
		]);
		expect(runs[1].cost_usd).toBe(1);
		expect(totalCost(runs)).toBe(1.5);
	});

	it('reports no cost, not zero, when the harness never reported one', () => {
		const runs = loopRuns([iteration({ cost_usd: null })]);
		expect(runs[0].cost_usd).toBeNull();
		expect(totalCost(runs)).toBeNull();
		expect(formatCost(null)).toBe('—');
	});
});

describe('loop wording', () => {
	it('lists only the flags the loop was launched with', () => {
		expect(loopFlagsLine({ mode: 'plan' })).toBe('plan');
		expect(
			loopFlagsLine({
				mode: 'build',
				harness: 'claude',
				model: 'opus',
				effort: 'high',
				max_iterations: 20,
				iteration_timeout_minutes: 30
			})
		).toBe('build · claude · opus · high · up to 20 iterations · 30 min each');
		expect(loopFlagsLine({ mode: 'build', max_iterations: 1 })).toBe('build · up to 1 iteration');
	});

	it('says nothing about a stop while the loop runs, and why once it ended', () => {
		expect(loopStopText(undefined)).toBeUndefined();
		expect(loopStopText({ mode: 'build' })).toBeUndefined();
		expect(loopStopText({ mode: 'build', stop_reason: 'validate_failed' })).toBe(
			'Ended: validation kept failing'
		);
	});

	it('formats costs, commit ranges and validation for the table', () => {
		expect(formatCost(0)).toBe('$0.00');
		expect(formatCost(0.004)).toBe('<$0.01');
		expect(formatCost(1.234)).toBe('$1.23');
		expect(commitRange(iteration())).toBe('aaaaaaa..bbbbbbb');
		expect(commitRange(iteration({ head_after: 'aaaaaaa1111' }))).toBe('no commits');
		expect(commitRange(iteration({ head_before: null }))).toBeUndefined();
		expect(validateText(true)).toBe('passed');
		expect(validateText(false)).toBe('failed');
		expect(validateText(null)).toBeUndefined();
	});

	it('colours outcomes with the shared status badges', () => {
		expect(outcomeBadgeKey('completed')).toBe('closed');
		expect(outcomeBadgeKey('interrupted')).toBe('deferred');
		expect(outcomeBadgeKey('rate_limited')).toBe('blocked');
	});
});

describe('mission kind filter', () => {
	const missions = [
		{ id: '1', operation: 'loop' as const },
		{ id: '2', operation: 'tackle' as const },
		{ id: '3', operation: 'discuss' as const },
		{ id: '4', operation: 'loop' as const }
	];

	it('tells loops from one-shot runs', () => {
		expect(missionKind({ operation: 'loop' })).toBe('loop');
		expect(missionKind({ operation: 'file' })).toBe('one_shot');
	});

	it('keeps the original order and shows everything for all', () => {
		expect(filterMissions(missions, 'all').map((m) => m.id)).toEqual(['1', '2', '3', '4']);
		expect(filterMissions(missions, 'loop').map((m) => m.id)).toEqual(['1', '4']);
		expect(filterMissions(missions, 'one_shot').map((m) => m.id)).toEqual(['2', '3']);
		expect(filterMissions([], 'loop')).toEqual([]);
	});
});

const CAPS: DispatchCapabilities = {
	live_events: true,
	follow_up: true,
	cancel: true,
	loop: false,
	terminal: false
};

function runner(
	id: DispatchProviderInfo['id'],
	label: string,
	loop: boolean
): DispatchProviderInfo {
	return { id, label, capabilities: { ...CAPS, loop } };
}

function health(patch: Partial<DispatchHealth> = {}): { dispatch: DispatchHealth } {
	const providers = patch.providers ?? [runner('e2b', 'Sand', true)];
	return {
		dispatch: {
			enabled: true,
			key_configured: true,
			armed: true,
			viewer_can_launch: true,
			provider: providers[0]?.id ?? 'none',
			capabilities: providers[0]?.capabilities,
			providers,
			...patch
		}
	};
}

const BOTH = { file: true, tackle: true };

describe('loopAvailability', () => {
	it('offers a loop when the picked runner has ralph and Tackle is allowed', () => {
		expect(loopAvailability(health(), BOTH)).toEqual({ visible: true, enabled: true });
	});

	it('shows members no control at all', () => {
		expect(loopAvailability(health({ viewer_can_launch: false }), BOTH).visible).toBe(false);
		expect(loopAvailability(null, BOTH).visible).toBe(false);
	});

	it('hides the control when no runner on the service runs loops', () => {
		const status = health({ providers: [runner('webhook', 'forge', false)] });
		expect(loopAvailability(status, BOTH).visible).toBe(false);
	});

	it('explains a disarmed service first', () => {
		const result = loopAvailability(health({ armed: false }), { file: true, tackle: false });
		expect(result).toEqual({
			visible: true,
			enabled: false,
			reason: 'Agent dispatch is disarmed in the console.'
		});
	});

	it('names the runner that can loop when the picked one cannot', () => {
		const status = health({
			providers: [runner('webhook', 'forge', false), runner('e2b', 'Sand', true)]
		});
		expect(loopAvailability(status, BOTH)).toEqual({
			visible: true,
			enabled: false,
			reason: 'forge does not run loops. Pick Sand under Runs on.'
		});
		expect(loopAvailability(status, BOTH, 'e2b').enabled).toBe(true);
	});

	it('needs Tackle allowed for the project', () => {
		expect(loopAvailability(health(), { file: true, tackle: false })).toEqual({
			visible: true,
			enabled: false,
			reason: 'Loops need Tackle allowed for this project.'
		});
	});

	it('reads the default provider capabilities from a server without a providers list', () => {
		const status = health({
			providers: undefined,
			provider: 'e2b',
			capabilities: { ...CAPS, loop: true }
		});
		expect(loopAvailability(status, BOTH).enabled).toBe(true);
	});
});

describe('loopPresets', () => {
	it('tells a project, an epic and a bead apart', () => {
		expect(loopScope({})).toBe('project');
		expect(loopScope({ issue: { id: 'x-1', title: 'E', issue_type: 'epic' } })).toBe('epic');
		expect(loopScope({ issue: { id: 'x-2', title: 'T', issue_type: 'task' } })).toBe('issue');
	});

	it('offers plan-wide presets on a project and leads with the bead elsewhere', () => {
		expect(loopPresets('project').map((p) => p.id)).toEqual(['build', 'plan']);
		expect(loopPresets('issue').map((p) => p.id)).toEqual(['bead', 'build', 'plan']);
		expect(loopPresets('epic')[0]!.label).toBe('Loop on this epic');
	});

	it('says on an epic that a loop cannot be limited to it', () => {
		const build = loopPresets('epic').find((p) => p.id === 'build')!;
		expect(build.hint).toMatch(/cannot be limited to this epic/);
	});
});

describe('loopLaunch', () => {
	const issue = { id: 'x-2', title: 'T', issue_type: 'task' };

	it('narrows a bead preset to the bead and leaves the harness to ralph', () => {
		const bead = loopPresets('issue')[0]!;
		expect(loopLaunch(bead, { issue }, { max_iterations: 10 })).toEqual({
			mode: 'build',
			max_iterations: 10,
			issue_id: 'x-2'
		});
	});

	it('sends a plan-wide loop without a bead', () => {
		const plan = loopPresets('issue').find((p) => p.id === 'plan')!;
		expect(loopLaunch(plan, { issue }, { max_iterations: 5, harness: 'codex' })).toEqual({
			mode: 'plan',
			max_iterations: 5,
			harness: 'codex'
		});
	});
});

describe('iterationLimitError', () => {
	it('accepts 1 to 200 and refuses anything else', () => {
		expect(iterationLimitError(' 20 ')).toBeUndefined();
		expect(iterationLimitError('200')).toBeUndefined();
		expect(iterationLimitError('0')).toBe('Between 1 and 200 iterations.');
		expect(iterationLimitError('201')).toBe('Between 1 and 200 iterations.');
		expect(iterationLimitError('2.5')).toBe('Enter a whole number of iterations.');
		expect(iterationLimitError('')).toBe('Enter a whole number of iterations.');
	});
});
