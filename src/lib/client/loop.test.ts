import { describe, expect, it } from 'vitest';
import {
	commitRange,
	filterMissions,
	formatCost,
	loopFlagsLine,
	loopRuns,
	loopStopText,
	missionKind,
	outcomeBadgeKey,
	totalCost,
	validateText
} from './loop.js';
import type { LoopIteration } from '#lib/types.js';

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
