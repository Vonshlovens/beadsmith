import { describe, expect, it } from 'vitest';
import {
	boardNavActive,
	DEFAULT_ISSUE_VIEW,
	hasExplicitIssueView,
	issueViewStorageKey,
	issuesNavActive,
	parseIssueView,
	parseStoredIssueView,
	issueDetailHref,
	projectIssuesHref,
	resolveIssueView
} from './issue-view.js';

describe('parseIssueView', () => {
	it('defaults to the parade when the param is missing', () => {
		expect(DEFAULT_ISSUE_VIEW).toBe('parade');
		expect(parseIssueView(null)).toBe('parade');
		expect(parseIssueView(undefined)).toBe('parade');
		expect(parseIssueView('')).toBe('parade');
	});

	it('accepts the three views and treats anything else as the default', () => {
		expect(parseIssueView('board')).toBe('board');
		expect(parseIssueView('list')).toBe('list');
		expect(parseIssueView('parade')).toBe('parade');
		expect(parseIssueView('kanban')).toBe('parade');
		expect(parseIssueView('BOARD')).toBe('parade');
	});
});

describe('parseStoredIssueView', () => {
	it('accepts parade, list and board only', () => {
		expect(parseStoredIssueView('list')).toBe('list');
		expect(parseStoredIssueView('board')).toBe('board');
		expect(parseStoredIssueView('parade')).toBe('parade');
	});

	it('treats missing or unknown values as no preference', () => {
		expect(parseStoredIssueView(null)).toBeNull();
		expect(parseStoredIssueView(undefined)).toBeNull();
		expect(parseStoredIssueView('')).toBeNull();
		expect(parseStoredIssueView('kanban')).toBeNull();
	});
});

describe('resolveIssueView', () => {
	it('lets an explicit view param win over a remembered preference', () => {
		expect(resolveIssueView(new URLSearchParams('view=list'), 'board')).toBe('list');
		expect(resolveIssueView(new URLSearchParams('view=board'), 'list')).toBe('board');
		expect(resolveIssueView(new URLSearchParams('view=kanban'), 'board')).toBe('parade');
	});

	it('restores the remembered view when the URL omits view', () => {
		expect(resolveIssueView(new URLSearchParams(), 'board')).toBe('board');
		expect(resolveIssueView(new URLSearchParams('status=open'), 'board')).toBe('board');
		expect(resolveIssueView(new URLSearchParams(), 'list')).toBe('list');
		expect(resolveIssueView(new URLSearchParams(), null)).toBe('parade');
	});

	it('treats a present empty view key as an explicit default', () => {
		expect(hasExplicitIssueView(new URLSearchParams('view='))).toBe(true);
		expect(resolveIssueView(new URLSearchParams('view='), 'board')).toBe('parade');
		expect(hasExplicitIssueView(new URLSearchParams('status=open'))).toBe(false);
	});
});

describe('issueDetailHref', () => {
	it('matches the table row and cell anchor path', () => {
		expect(issueDetailHref('d_beads_web', 'beads-web-6bz')).toBe('/p/d_beads_web/i/beads-web-6bz');
	});
});

describe('projectIssuesHref', () => {
	it('writes view=list so Issues is an explicit destination', () => {
		expect(projectIssuesHref('demo', 'list')).toBe('/p/demo?view=list');
		expect(issueViewStorageKey('demo')).toBe('bdui:issue-view:demo');
	});

	it('writes view=board and keeps other filters', () => {
		const current = new URLSearchParams('status=open&q=auth&include_closed=1');
		expect(projectIssuesHref('demo', 'board', current)).toBe(
			'/p/demo?status=open&q=auth&include_closed=1&view=board'
		);
	});

	it('replaces view=board when switching back to list without losing filters', () => {
		const current = new URLSearchParams('view=board&type=bug&priority=0');
		expect(projectIssuesHref('demo', 'list', current)).toBe(
			'/p/demo?view=list&type=bug&priority=0'
		);
	});
});

describe('nav active states', () => {
	it('keeps Issues current on the list and on issue detail', () => {
		expect(issuesNavActive('/p/demo', 'demo', 'list')).toBe(true);
		expect(issuesNavActive('/p/demo', 'demo', 'parade')).toBe(true);
		expect(issuesNavActive('/p/demo/i/demo-1', 'demo', 'list')).toBe(true);
		expect(issuesNavActive('/p/demo/i/demo-1', 'demo', 'board')).toBe(true);
		expect(issuesNavActive('/p/demo', 'demo', 'board')).toBe(false);
		expect(issuesNavActive('/p/other', 'demo', 'list')).toBe(false);
	});

	it('marks Board current only on the project issues route with view=board', () => {
		expect(boardNavActive('/p/demo', 'demo', 'board')).toBe(true);
		expect(boardNavActive('/p/demo', 'demo', 'list')).toBe(false);
		expect(boardNavActive('/p/demo/i/demo-1', 'demo', 'board')).toBe(false);
	});
});
