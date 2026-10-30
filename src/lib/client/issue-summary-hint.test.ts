import { afterEach, describe, expect, it } from 'vitest';
import type { IssueSummary } from '$lib/types.js';
import {
	clearIssueSummaryHints,
	peekIssueSummaryHint,
	rememberHintIfListed,
	rememberIssueSummaryHint,
	takeIssueSummaryHint
} from './issue-summary-hint.js';

function summary(overrides: Partial<IssueSummary> & { id: string }): IssueSummary {
	return {
		title: 'Row title',
		status: 'open',
		priority: 2,
		issue_type: 'task',
		labels: ['nav'],
		created_at: '2026-08-01T00:00:00.000Z',
		updated_at: '2026-08-01T00:00:00.000Z',
		dependency_count: 0,
		dependent_count: 1,
		comment_count: 2,
		...overrides
	};
}

afterEach(() => {
	clearIssueSummaryHints();
});

describe('issue summary paint hints', () => {
	it('returns a cloned row for the matching id and consumes it', () => {
		const row = summary({ id: 'beads-web-8u7', labels: ['nav'] });
		rememberIssueSummaryHint(row);
		row.labels.push('mutated');

		const hint = takeIssueSummaryHint('beads-web-8u7');
		expect(hint).toMatchObject({
			id: 'beads-web-8u7',
			title: 'Row title',
			status: 'open',
			priority: 2,
			labels: ['nav']
		});
		expect(takeIssueSummaryHint('beads-web-8u7')).toBeUndefined();
	});

	it('peek does not consume the hint', () => {
		rememberIssueSummaryHint(summary({ id: 'beads-web-1' }));
		expect(peekIssueSummaryHint('beads-web-1')?.id).toBe('beads-web-1');
		expect(takeIssueSummaryHint('beads-web-1')?.id).toBe('beads-web-1');
	});

	it('does not invent a hint for a direct URL with no prior row', () => {
		expect(takeIssueSummaryHint('beads-web-missing')).toBeUndefined();
	});

	it('stashes a listed issue when navigating to its detail path', () => {
		rememberHintIfListed('/p/d_beads_web/i/beads-web-8u7', 'd_beads_web', [
			summary({ id: 'beads-web-8u7', title: 'From list' })
		]);
		expect(takeIssueSummaryHint('beads-web-8u7')?.title).toBe('From list');
	});

	it('ignores a path that is not this project detail', () => {
		rememberHintIfListed('/p/d_other/i/beads-web-8u7', 'd_beads_web', [
			summary({ id: 'beads-web-8u7' })
		]);
		expect(takeIssueSummaryHint('beads-web-8u7')).toBeUndefined();
	});

	it('replaces a previous hint for the same id', () => {
		rememberIssueSummaryHint(summary({ id: 'beads-web-8u7', title: 'Old' }));
		rememberIssueSummaryHint(summary({ id: 'beads-web-8u7', title: 'New' }));
		expect(takeIssueSummaryHint('beads-web-8u7')?.title).toBe('New');
	});

	it('keeps a hint for a different id', () => {
		rememberIssueSummaryHint(summary({ id: 'beads-web-a', title: 'A' }));
		rememberIssueSummaryHint(summary({ id: 'beads-web-b', title: 'B' }));
		expect(takeIssueSummaryHint('beads-web-b')?.title).toBe('B');
		expect(takeIssueSummaryHint('beads-web-a')?.title).toBe('A');
	});
});
