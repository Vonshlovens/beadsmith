import { afterEach, describe, expect, it } from 'vitest';
import type { IssueSummary } from '$lib/types.js';
import {
	ISSUE_LIST_CACHE_TTL_MS,
	clearIssueListCache,
	dropIssueListCacheForProject,
	getIssueList,
	issueListCacheKey,
	peekFreshIssueList,
	pendingIssueListRevalidation,
	readListFilters,
	rememberIssueList,
	resolveIssueListPayload,
	subscribeIssueListCache,
	type IssueListPayload,
	type ListFilters
} from './issue-list-cache.js';

const EMPTY_FILTERS: ListFilters = {
	status: [],
	type: [],
	priority: [],
	q: '',
	include_closed: false
};

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

function payload(issues: IssueSummary[], rest: Partial<IssueListPayload> = {}): IssueListPayload {
	return {
		issues,
		source: 'sql',
		readonly: true,
		error: null,
		...rest
	};
}

afterEach(() => {
	clearIssueListCache();
});

describe('readListFilters', () => {
	it('reads comma-separated filters and include_closed', () => {
		expect(
			readListFilters(new URLSearchParams('status=open,blocked&priority=0,2&include_closed=1'))
		).toEqual({
			status: ['open', 'blocked'],
			type: [],
			priority: [0, 2],
			q: '',
			include_closed: true
		});
	});

	it('ignores view and drops blank tokens', () => {
		expect(readListFilters(new URLSearchParams('view=board&status=open,&q=drain'))).toEqual({
			status: ['open'],
			type: [],
			priority: [],
			q: 'drain',
			include_closed: false
		});
	});
});

describe('issueListCacheKey', () => {
	it('is the project id when no filters are set', () => {
		expect(issueListCacheKey('d_beads_web', EMPTY_FILTERS)).toBe('d_beads_web');
	});

	it('is stable across filter order and ignores view', () => {
		const a = issueListCacheKey('d_beads_web', {
			status: ['blocked', 'open'],
			type: ['task', 'bug'],
			priority: [2, 0],
			q: ' drain ',
			include_closed: true
		});
		const b = issueListCacheKey('d_beads_web', {
			status: ['open', 'blocked'],
			type: ['bug', 'task'],
			priority: [0, 2],
			q: 'drain',
			include_closed: true
		});
		expect(a).toBe(b);
		expect(a).toContain('d_beads_web?');
		expect(a).not.toContain('view=');
	});

	it('does not collide across projects', () => {
		const filters = { ...EMPTY_FILTERS, status: ['open'] };
		expect(issueListCacheKey('d_a', filters)).not.toBe(issueListCacheKey('d_b', filters));
	});
});

describe('issue list cache', () => {
	it('returns a cloned payload and ignores error writes', () => {
		const row = summary({ id: 'beads-web-0ef', labels: ['nav'] });
		rememberIssueList('d_beads_web', {
			project_id: 'd_beads_web',
			...payload([row])
		});
		row.labels.push('mutated');

		const hit = getIssueList('d_beads_web');
		expect(hit?.issues[0]?.labels).toEqual(['nav']);

		rememberIssueList('d_beads_web', {
			project_id: 'd_beads_web',
			...payload([], { error: 'nope' })
		});
		expect(getIssueList('d_beads_web')?.issues[0]?.id).toBe('beads-web-0ef');
	});

	it('stops serving a payload after the TTL', () => {
		rememberIssueList(
			'd_beads_web',
			{ project_id: 'd_beads_web', ...payload([summary({ id: 'a' })]) },
			1_000
		);
		expect(
			peekFreshIssueList('d_beads_web', 1_000 + ISSUE_LIST_CACHE_TTL_MS - 1)?.issues[0]?.id
		).toBe('a');
		expect(peekFreshIssueList('d_beads_web', 1_000 + ISSUE_LIST_CACHE_TTL_MS)).toBeUndefined();
		expect(getIssueList('d_beads_web')?.issues[0]?.id).toBe('a');
	});

	it('drops every key for one project and notifies listeners', () => {
		let ticks = 0;
		const stop = subscribeIssueListCache(() => {
			ticks += 1;
		});
		rememberIssueList('d_a', { project_id: 'd_a', ...payload([summary({ id: 'a' })]) });
		rememberIssueList('d_a?q=x', { project_id: 'd_a', ...payload([summary({ id: 'ax' })]) });
		rememberIssueList('d_b', { project_id: 'd_b', ...payload([summary({ id: 'b' })]) });
		dropIssueListCacheForProject('d_a');
		expect(getIssueList('d_a')).toBeUndefined();
		expect(getIssueList('d_a?q=x')).toBeUndefined();
		expect(getIssueList('d_b')?.issues[0]?.id).toBe('b');
		expect(ticks).toBeGreaterThanOrEqual(4);
		stop();
	});
});

describe('resolveIssueListPayload', () => {
	it('awaits the network on a miss and remembers the result', async () => {
		const fresh = payload([summary({ id: 'beads-web-0ef' })]);
		const result = await resolveIssueListPayload({
			cache: true,
			now: 5_000,
			project_id: 'd_beads_web',
			filters: EMPTY_FILTERS,
			fetchPayload: async () => fresh
		});
		expect(result.issues[0]?.id).toBe('beads-web-0ef');
		expect(peekFreshIssueList('d_beads_web', 5_000)?.issues[0]?.id).toBe('beads-web-0ef');
	});

	it('returns the cached list immediately and refreshes behind it', async () => {
		await resolveIssueListPayload({
			cache: true,
			now: 1_000,
			project_id: 'd_beads_web',
			filters: EMPTY_FILTERS,
			fetchPayload: async () => payload([summary({ id: 'old' })])
		});

		let fetches = 0;
		let release: (value: IssueListPayload) => void = () => {};
		const held = new Promise<IssueListPayload>((resolve) => {
			release = resolve;
		});
		const served = await resolveIssueListPayload({
			cache: true,
			now: 2_000,
			project_id: 'd_beads_web',
			filters: EMPTY_FILTERS,
			fetchPayload: () => {
				fetches += 1;
				return held;
			}
		});

		expect(served.issues[0]?.id).toBe('old');
		expect(fetches).toBe(1);
		expect(getIssueList('d_beads_web')?.issues[0]?.id).toBe('old');
		release(payload([summary({ id: 'new' })]));
		await pendingIssueListRevalidation(issueListCacheKey('d_beads_web', EMPTY_FILTERS));
		expect(getIssueList('d_beads_web')?.issues[0]?.id).toBe('new');
	});

	it('does not serve cache when disabled (SSR) or after the TTL', async () => {
		await resolveIssueListPayload({
			cache: true,
			now: 1_000,
			project_id: 'd_beads_web',
			filters: EMPTY_FILTERS,
			fetchPayload: async () => payload([summary({ id: 'old' })])
		});

		const ssr = await resolveIssueListPayload({
			cache: false,
			now: 2_000,
			project_id: 'd_beads_web',
			filters: EMPTY_FILTERS,
			fetchPayload: async () => payload([summary({ id: 'ssr' })])
		});
		expect(ssr.issues[0]?.id).toBe('ssr');

		const expired = await resolveIssueListPayload({
			cache: true,
			now: 1_000 + ISSUE_LIST_CACHE_TTL_MS,
			project_id: 'd_beads_web',
			filters: EMPTY_FILTERS,
			fetchPayload: async () => payload([summary({ id: 'late' })])
		});
		expect(expired.issues[0]?.id).toBe('late');
	});

	it('coalesces in-flight revalidation for the same key', async () => {
		await resolveIssueListPayload({
			cache: true,
			now: 1_000,
			project_id: 'd_beads_web',
			filters: EMPTY_FILTERS,
			fetchPayload: async () => payload([summary({ id: 'old' })])
		});

		let fetches = 0;
		const fetchPayload = () => {
			fetches += 1;
			return new Promise<IssueListPayload>((resolve) => {
				setTimeout(() => resolve(payload([summary({ id: 'new' })])), 20);
			});
		};

		await Promise.all([
			resolveIssueListPayload({
				cache: true,
				now: 2_000,
				project_id: 'd_beads_web',
				filters: EMPTY_FILTERS,
				fetchPayload
			}),
			resolveIssueListPayload({
				cache: true,
				now: 2_000,
				project_id: 'd_beads_web',
				filters: EMPTY_FILTERS,
				fetchPayload
			})
		]);

		expect(fetches).toBe(1);
		await pendingIssueListRevalidation(issueListCacheKey('d_beads_web', EMPTY_FILTERS));
	});
});
