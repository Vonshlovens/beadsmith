import { describe, expect, it } from 'vitest';
import { parseRecent, pushRecent, type RecentIssue } from './recent-issues';

const visit = (issue_id: string, at: number): RecentIssue => ({
	project_id: 'd_lh',
	issue_id,
	title: `Title ${issue_id}`,
	at
});

describe('pushRecent', () => {
	it('moves a revisited issue to the front without duplicating it', () => {
		const list = pushRecent([visit('lh-1', 1), visit('lh-2', 2)], visit('lh-2', 3));
		expect(list.map((item) => item.issue_id)).toEqual(['lh-2', 'lh-1']);
	});

	it('keeps at most max entries', () => {
		const list = pushRecent([visit('a-1', 1), visit('a-2', 2)], visit('a-3', 3), 2);
		expect(list.map((item) => item.issue_id)).toEqual(['a-3', 'a-1']);
	});
});

describe('parseRecent', () => {
	it('drops malformed entries and bad JSON', () => {
		expect(parseRecent('not json')).toEqual([]);
		expect(parseRecent(null)).toEqual([]);
		expect(parseRecent(JSON.stringify([visit('lh-1', 1), { issue_id: 3 }]))).toEqual([
			visit('lh-1', 1)
		]);
	});
});
