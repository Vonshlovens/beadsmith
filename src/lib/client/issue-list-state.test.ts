import { describe, expect, it } from 'vitest';
import { describeIssueListVacancy } from './issue-list-state.js';

const EMPTY_COUNTS = { open: 0, in_progress: 0, blocked: 0, closed: 0, total: 0 };
const CLOSED_ONLY = { open: 0, in_progress: 0, blocked: 0, closed: 4, total: 4 };
const MIXED = { open: 2, in_progress: 0, blocked: 0, closed: 3, total: 5 };

describe('describeIssueListVacancy', () => {
	it('returns null when rows are visible', () => {
		expect(
			describeIssueListVacancy({
				issues_loaded: 3,
				visible: 3,
				include_closed: false,
				has_filters: false,
				counts: MIXED
			})
		).toBeNull();
	});

	it('names a project with zero issues as empty', () => {
		expect(
			describeIssueListVacancy({
				issues_loaded: 0,
				visible: 0,
				include_closed: false,
				has_filters: false,
				counts: EMPTY_COUNTS
			})
		).toMatchObject({
			kind: 'empty',
			title: 'This project is empty'
		});
	});

	it('distinguishes closed-and-hidden from genuinely empty', () => {
		expect(
			describeIssueListVacancy({
				issues_loaded: 0,
				visible: 0,
				include_closed: false,
				has_filters: false,
				counts: CLOSED_ONLY
			})
		).toMatchObject({
			kind: 'closed_hidden',
			title: 'No open issues',
			action: 'include_closed'
		});
	});

	it('does not claim empty when counts are missing and closed issues may be hidden', () => {
		expect(
			describeIssueListVacancy({
				issues_loaded: 0,
				visible: 0,
				include_closed: false,
				has_filters: false
			})
		).toMatchObject({
			kind: 'closed_hidden',
			action: 'include_closed'
		});
	});

	it('treats a filter that hid every loaded row as filtered-to-empty', () => {
		expect(
			describeIssueListVacancy({
				issues_loaded: 5,
				visible: 0,
				include_closed: false,
				has_filters: true,
				counts: MIXED
			})
		).toMatchObject({
			kind: 'filtered',
			action: 'clear_filters'
		});
	});

	it('flags a partial load when counts report issues but the list returned none', () => {
		expect(
			describeIssueListVacancy({
				issues_loaded: 0,
				visible: 0,
				include_closed: true,
				has_filters: false,
				counts: MIXED
			})
		).toMatchObject({
			kind: 'partial',
			action: 'retry'
		});
	});
});
