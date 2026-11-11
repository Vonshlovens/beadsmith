import { describe, expect, it } from 'vitest';
import {
	automationEdit,
	automationLaunch,
	automationOutcomeKey,
	describeSchedule,
	formatSlot,
	launchSummary,
	relativeUntil
} from './automations.js';

describe('describeSchedule', () => {
	it.each([
		['0 2 * * *', 'Daily at 02:00'],
		['30 9 * * 1-5', 'Weekdays at 09:30'],
		['0 10 * * 0,6', 'Weekends at 10:00'],
		['0 6 * * 1', 'Mondays at 06:00'],
		['0 6 * * mon,wed,fri', 'Mondays, Wednesdays and Fridays at 06:00'],
		['0 6 * * 7', 'Sundays at 06:00'],
		['0 3 1 * *', 'Monthly on the 1st at 03:00'],
		['0 3 22 * *', 'Monthly on the 22nd at 03:00'],
		['0 3 13 * *', 'Monthly on the 13th at 03:00'],
		['0 * * * *', 'Hourly'],
		['15 * * * *', 'Hourly at :15'],
		['*/15 * * * *', 'Every 15 minutes'],
		['* * * * *', 'Every minute'],
		['0 */6 * * *', 'Every 6 hours']
	])('%s reads as %s', (cron, words) => {
		expect(describeSchedule(cron)).toBe(words);
	});

	it('leaves anything else to the expression itself', () => {
		for (const cron of ['0 2 * 1 *', '0 2-4 * * *', '0 2 1 * 1', 'nonsense', '0 25 * * *']) {
			expect(describeSchedule(cron), cron).toBeUndefined();
		}
	});
});

describe('launchSummary', () => {
	it('names the loop mode and its scope, or the operation and bead', () => {
		expect(launchSummary({ operation: 'loop', issue_id: 'bw-1', loop: { mode: 'build' } })).toBe(
			'Build loop on bw-1'
		);
		expect(launchSummary({ operation: 'loop', loop: { mode: 'plan' } })).toBe(
			'Plan loop on the whole plan'
		);
		expect(launchSummary({ operation: 'tackle', issue_id: 'bw-2' })).toBe('Tackle bw-2');
		expect(launchSummary({ operation: 'file' })).toBe('File an issue');
	});
});

describe('run outcomes and times', () => {
	it('colours a launch as done and a refusal as blocked', () => {
		expect(automationOutcomeKey('fired')).toBe('closed');
		expect(automationOutcomeKey('refused')).toBe('blocked');
		expect(automationOutcomeKey('queued')).toBe('in_progress');
		expect(automationOutcomeKey('skipped')).toBe('deferred');
	});

	it('shows a fire time in the automation zone', () => {
		expect(formatSlot('2026-11-12T02:00:00.000Z', 'UTC')).toContain('02:00');
		expect(formatSlot('2026-11-12T02:00:00.000Z', 'Asia/Tokyo')).toContain('11:00');
		expect(formatSlot('bad', 'UTC')).toBe('—');
	});

	it('counts down to the next run', () => {
		const now = Date.parse('2026-11-11T12:00:00Z');
		expect(relativeUntil('2026-11-11T12:30:00Z', now)).toBe('in 30m');
		expect(relativeUntil('2026-11-12T02:00:00Z', now)).toBe('in 14h');
		expect(relativeUntil('2026-11-14T12:00:00Z', now)).toBe('in 3d');
		expect(relativeUntil('2026-11-11T11:59:00Z', now)).toBe('due');
		expect(relativeUntil(undefined, now)).toBe('—');
	});
});

describe('automationLaunch', () => {
	it('puts the model and effort inside the loop launch', () => {
		expect(
			automationLaunch(
				'build',
				{ bead: '', max_iterations: 20, harness: 'codex' },
				{ model: 'opus', effort: 'high' }
			)
		).toEqual({
			operation: 'loop',
			mode: 'build',
			max_iterations: 20,
			harness: 'codex',
			model: 'opus',
			effort: 'high'
		});
	});

	it('names the bead only for a one-bead build, and leaves defaults out', () => {
		expect(automationLaunch('bead', { bead: ' bw-1 ', max_iterations: 10 }, {})).toEqual({
			operation: 'loop',
			mode: 'build',
			max_iterations: 10,
			issue_id: 'bw-1'
		});
		expect(
			automationLaunch('plan', { bead: 'bw-1', max_iterations: 5 }, { effort: 'low' })
		).toEqual({ operation: 'loop', mode: 'plan', max_iterations: 5, effort: 'low' });
	});
});

describe('automationEdit', () => {
	const fields = {
		name: ' Nightly ',
		cron: ' 0 2 * * * ',
		time_zone: 'UTC ',
		overlap: 'skip' as const,
		max_iterations: 5
	};

	it('sends loop settings for a loop, with the harness only when one is picked', () => {
		const loop = { operation: 'loop' as const, loop: { mode: 'build' as const } };
		expect(automationEdit(loop, fields)).toEqual({
			name: 'Nightly',
			cron: '0 2 * * *',
			time_zone: 'UTC',
			overlap: 'skip',
			loop: { max_iterations: 5 }
		});
		expect(automationEdit(loop, { ...fields, harness: 'codex' }).loop).toEqual({
			max_iterations: 5,
			harness: 'codex'
		});
	});

	it('leaves loop settings out for any other launch', () => {
		expect(automationEdit({ operation: 'tackle', issue_id: 'bw-1' }, fields).loop).toBeUndefined();
	});
});
