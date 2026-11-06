import { describe, expect, it } from 'vitest';
import type { ActivityEvent } from '#lib/types.js';
import { dayLabel, eventVerb, groupActivity, newestStamp } from './activity-groups';

function event(
	issue_id: string,
	event_type: string,
	actor: string,
	created_at: string
): ActivityEvent {
	return {
		project_id: 'd_lh',
		project_name: 'lighthouse',
		issue_id,
		issue_title: `Title of ${issue_id}`,
		event_type,
		actor,
		created_at
	};
}

const NOW = new Date(2026, 10, 6, 12, 0, 0);
const at = (day: number, hour: number) => new Date(2026, 10, day, hour).toISOString();

describe('groupActivity', () => {
	it('folds one issue into one line per day, newest first', () => {
		const days = groupActivity(
			[
				event('lh-3', 'claimed', 'coding-agent', at(6, 9)),
				event('lh-3', 'commented', 'coding-agent', at(6, 10)),
				event('lh-1', 'label_added', 'kim', at(6, 8)),
				event('lh-3', 'created', 'sam', at(5, 9))
			],
			NOW
		);
		expect(days.map((day) => day.label)).toEqual(['Today', 'Yesterday']);
		const today = days[0]!.groups;
		expect(today.map((group) => group.issue_id)).toEqual(['lh-3', 'lh-1']);
		expect(today[0]).toMatchObject({
			verbs: ['commented', 'claimed'],
			actors: ['coding-agent'],
			count: 2
		});
		expect(today[1]!.verbs).toEqual(['label added']);
		expect(days[1]!.groups[0]).toMatchObject({ issue_id: 'lh-3', actors: ['sam'], count: 1 });
	});

	it('keeps undated events instead of dropping them', () => {
		const days = groupActivity([event('lh-9', 'created', 'kim', 'not a date')], NOW);
		expect(days[0]!.label).toBe('Undated');
	});
});

describe('helpers', () => {
	it('reads event types as verbs', () => {
		expect(eventVerb('status.changed')).toBe('status changed');
	});

	it('labels older days with a date', () => {
		expect(dayLabel('2026-11-02', NOW)).not.toMatch(/Today|Yesterday/);
	});

	it('finds the newest stamp and ignores missing ones', () => {
		expect(newestStamp([undefined, '2026-11-01T00:00:00Z', 'junk'])).toBe(
			Date.parse('2026-11-01T00:00:00Z')
		);
		expect(newestStamp([])).toBe(0);
	});
});
