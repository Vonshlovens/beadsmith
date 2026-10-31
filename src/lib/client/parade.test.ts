import { describe, expect, it } from 'vitest';
import {
	DEFAULT_COLLAPSED,
	groupParade,
	paradeOrder,
	paradeSectionOf,
	parseCollapsed,
	stepSelection
} from './parade.js';
import type { IssueSummary } from '$lib/types';

function issue(
	id: string,
	status: string,
	priority = 2,
	updated_at = '2026-10-01T00:00:00Z'
): IssueSummary {
	return {
		id,
		title: id,
		status,
		priority,
		issue_type: 'task',
		labels: [],
		created_at: '2026-09-01T00:00:00Z',
		updated_at,
		dependency_count: 0,
		dependent_count: 0,
		comment_count: 0
	};
}

describe('paradeSectionOf', () => {
	it('maps every status onto the route', () => {
		expect(paradeSectionOf('in_progress')).toBe('rolling');
		expect(paradeSectionOf('hooked')).toBe('rolling');
		expect(paradeSectionOf('open')).toBe('lined_up');
		expect(paradeSectionOf('pinned')).toBe('lined_up');
		expect(paradeSectionOf('blocked')).toBe('stalled');
		expect(paradeSectionOf('deferred')).toBe('deferred');
		expect(paradeSectionOf('closed')).toBe('past');
		expect(paradeSectionOf('weird')).toBe('lined_up');
	});
});

describe('groupParade', () => {
	it('orders sections along the route and drops empty ones', () => {
		const sections = groupParade([
			issue('a-1', 'closed'),
			issue('a-2', 'open'),
			issue('a-3', 'in_progress')
		]);
		expect(sections.map((section) => section.id)).toEqual(['rolling', 'lined_up', 'past']);
	});

	it('sorts rows by priority, then recency', () => {
		const [lined_up] = groupParade([
			issue('a-1', 'open', 2, '2026-10-01T00:00:00Z'),
			issue('a-2', 'open', 0, '2026-09-01T00:00:00Z'),
			issue('a-3', 'open', 2, '2026-10-05T00:00:00Z')
		]);
		expect(lined_up.issues.map((row) => row.id)).toEqual(['a-2', 'a-3', 'a-1']);
	});
});

describe('keyboard order', () => {
	const sections = groupParade([
		issue('a-1', 'in_progress'),
		issue('a-2', 'open'),
		issue('a-3', 'closed')
	]);

	it('skips collapsed sections', () => {
		const order = paradeOrder(sections, new Set(['past']));
		expect(order.map((row) => row.id)).toEqual(['a-1', 'a-2']);
	});

	it('steps without wrapping and starts from the top', () => {
		const order = paradeOrder(sections, new Set());
		expect(stepSelection(order, null, 1)).toBe('a-1');
		expect(stepSelection(order, 'missing', -1)).toBe('a-1');
		expect(stepSelection(order, 'a-1', 1)).toBe('a-2');
		expect(stepSelection(order, 'a-3', 1)).toBe('a-3');
		expect(stepSelection(order, 'a-1', -1)).toBe('a-1');
		expect(stepSelection([], 'a-1', 1)).toBeNull();
	});
});

describe('parseCollapsed', () => {
	it('defaults to folding the closed section', () => {
		expect([...parseCollapsed(null)]).toEqual([...DEFAULT_COLLAPSED]);
		expect([...parseCollapsed('not json')]).toEqual([...DEFAULT_COLLAPSED]);
	});

	it('keeps known sections only', () => {
		expect([...parseCollapsed('["stalled","bogus"]')]).toEqual(['stalled']);
		expect([...parseCollapsed('[]')]).toEqual([]);
	});
});
