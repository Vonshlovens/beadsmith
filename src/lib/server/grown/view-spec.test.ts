import { describe, expect, it } from 'vitest';
import { createDoltClient, type DoltClient, type SqlRow } from '../dolt/client.js';
import {
	compileViewFilters,
	runView,
	VIEW_DEFAULT_LIMIT,
	view_spec_schema,
	type ViewSpec
} from './view-spec.js';
import { GrownError } from './errors.js';
import { MAX_LIST_LIMIT } from '../validation.js';
import type { IssueSummary, Project } from '#lib/types.js';
import { VIEW_LIMIT_MAX } from '#lib/views.js';

function project(id: string): Project {
	return {
		id: `d_${id}`,
		name: id,
		state: 'remote',
		dolt_database: id,
		backend: 'server-sql',
		readonly: true
	};
}

function issue(id: string, overrides: Partial<IssueSummary> = {}): IssueSummary {
	return {
		id,
		title: id,
		status: 'open',
		priority: 2,
		issue_type: 'task',
		labels: [],
		created_at: '2026-11-01T00:00:00.000Z',
		updated_at: '2026-11-01T00:00:00.000Z',
		dependency_count: 0,
		dependent_count: 0,
		comment_count: 0,
		...overrides
	};
}

function spec(value: unknown): ViewSpec {
	return view_spec_schema.parse(value);
}

describe('view spec', () => {
	it('keeps the row limit within the read plane list limit it compiles onto', () => {
		expect(VIEW_LIMIT_MAX).toBeLessThanOrEqual(MAX_LIST_LIMIT);
		expect(spec({ scope: 'all', filters: { limit: VIEW_LIMIT_MAX } }).filters.limit).toBe(
			VIEW_LIMIT_MAX
		);
		expect(
			view_spec_schema.safeParse({ scope: 'all', filters: { limit: VIEW_LIMIT_MAX + 1 } }).success
		).toBe(false);
	});

	it('fills defaults', () => {
		expect(spec({ scope: 'all' })).toEqual({
			scope: 'all',
			filters: {},
			sort: 'updated',
			presentation: 'list'
		});
	});

	it('refuses unknown keys at every level', () => {
		expect(view_spec_schema.safeParse({ scope: 'all', sql: 'SELECT 1' }).success).toBe(false);
		expect(
			view_spec_schema.safeParse({ scope: 'all', filters: { where: 'status = open' } }).success
		).toBe(false);
		expect(
			view_spec_schema.safeParse({ scope: { project: 'd_a', database: 'mysql' } }).success
		).toBe(false);
	});

	it('refuses SQL-ish values in list filters, sort and grouping', () => {
		for (const bad of [
			{ scope: 'all', filters: { status: ["open') OR 1=1 --"] } },
			{ scope: 'all', filters: { status: ['open,closed'] } },
			{ scope: 'all', filters: { type: ['task; DROP TABLE issues'] } },
			{ scope: 'all', filters: { priority: [5] } },
			{ scope: 'all', filters: { label: "x' OR '1'='1" } },
			{ scope: 'all', filters: { assignee: 'a\u0000b' } },
			{ scope: 'all', filters: { q: 'x'.repeat(201) } },
			{ scope: 'all', filters: { limit: 1001 } },
			{ scope: 'all', sort: 'i.priority DESC' },
			{ scope: 'all', group_by: 'title' },
			{ scope: { project: 'beads_web; --' } },
			{ scope: 'everything' }
		]) {
			expect(view_spec_schema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
		}
	});

	it('compiles onto the read plane filters', () => {
		expect(
			compileViewFilters(
				spec({
					scope: 'all',
					filters: { status: ['open', 'in_progress'], priority: [0, 1], q: 'review' }
				}).filters
			)
		).toEqual({
			limit: VIEW_DEFAULT_LIMIT,
			include_closed: false,
			status: 'open,in_progress',
			type: undefined,
			priority: '0,1',
			q: 'review',
			label: undefined,
			assignee: undefined
		});
	});
});

describe('runView', () => {
	it('reaches Dolt with bound parameters only', async () => {
		const calls: { sql: string; params: unknown[] }[] = [];
		const dolt: DoltClient = {
			...createDoltClient(async (sql, params): Promise<SqlRow[]> => {
				calls.push({ sql, params });
				return [];
			}),
			// Schema inspection is the read plane's own concern; this test is about the browse.
			schema: undefined
		};
		const hostile = "'; DROP TABLE issues; --";
		await runView(
			spec({
				scope: { project: 'd_a' },
				filters: { q: hostile, assignee: hostile, status: ['blocked'] }
			}),
			{
				resolve: async () => project('a'),
				read: { dolt, dolt_configured: true }
			}
		);
		const browse = calls.find((call) => call.sql.includes('FROM `a`.issues'));
		expect(browse).toBeDefined();
		expect(calls.every((call) => !call.sql.includes('DROP TABLE'))).toBe(true);
		expect(browse?.params).toEqual(expect.arrayContaining(['blocked', hostile]));
		expect(browse?.params.some((p) => String(p).includes('DROP TABLE'))).toBe(true);
	});

	it('merges every project, sorts and cuts to the limit', async () => {
		const rows: Record<string, IssueSummary[]> = {
			a: [issue('a-1', { priority: 3 }), issue('a-2', { priority: 0 })],
			b: [issue('b-1', { priority: 1 })]
		};
		const dolt: Partial<DoltClient> = {
			browseIssues: async (database) => rows[database] ?? []
		};
		const result = await runView(spec({ scope: 'all', filters: { limit: 2 }, sort: 'priority' }), {
			projects: async () => [project('a'), project('b')],
			read: { dolt: dolt as DoltClient, dolt_configured: true }
		});
		expect(result.issues.map((row) => [row.id, row.project_id])).toEqual([
			['a-2', 'd_a'],
			['b-1', 'd_b']
		]);
		expect(result.limit_reached).toBe(true);
		expect(result.skipped).toEqual([]);
	});

	it('skips an unreadable project in an all-projects view', async () => {
		const dolt: Partial<DoltClient> = {
			browseIssues: async (database) => {
				if (database === 'b') throw new Error('driver detail that must not leak');
				return [issue('a-1')];
			}
		};
		const result = await runView(spec({ scope: 'all' }), {
			projects: async () => [project('a'), project('b')],
			read: { dolt: dolt as DoltClient, dolt_configured: true }
		});
		expect(result.issues.map((row) => row.id)).toEqual(['a-1']);
		expect(result.skipped).toHaveLength(1);
		expect(result.skipped[0].project_id).toBe('d_b');
		expect(result.skipped[0].message).not.toContain('driver detail');
	});

	it('reports a missing project', async () => {
		await expect(
			runView(spec({ scope: { project: 'd_gone' } }), { resolve: async () => undefined })
		).rejects.toBeInstanceOf(GrownError);
	});
});
