import { describe, expect, it } from 'vitest';
import {
	canUseSql,
	getMergedEvents,
	getMergedReadyIssues,
	getProjectEvents,
	getProjectIssue,
	listProjectIssues,
	resolveDependents
} from './read-model.js';
import type { DoltClient } from './dolt/client.js';
import { UnsupportedSchemaError } from './dolt/schema.js';
import type { IssueSummary, Project } from '$lib/types.js';

/** Build a complete read-only Dolt client stub. */
function fakeDolt(overrides: Partial<DoltClient> = {}): DoltClient {
	return {
		listDatabases: async () => {
			return [];
		},
		issueCounts: async () => {
			return { open: 0, in_progress: 0, blocked: 0, closed: 0, total: 0 };
		},
		lastActivity: async () => {
			return undefined;
		},
		browseIssues: async () => {
			return [];
		},
		listReadyIssues: async () => {
			return [];
		},
		issueDetail: async () => {
			return undefined;
		},
		dependents: async () => {
			return [];
		},
		recentEvents: async () => {
			return [];
		},
		issueEvents: async () => {
			return [];
		},
		ping: async () => {
			return 1;
		},
		...overrides
	};
}

function summary(id: string, updated_at = '2026-07-30T05:00:00Z'): IssueSummary {
	return {
		id,
		title: `Issue ${id}`,
		status: 'open',
		priority: 2,
		issue_type: 'task',
		labels: [],
		created_at: updated_at,
		updated_at,
		dependency_count: 0,
		dependent_count: 0,
		comment_count: 0
	};
}

const REMOTE: Project = {
	id: 'd_acme_platform',
	name: 'ACME',
	state: 'remote',
	dolt_database: 'acme_platform',
	backend: 'server-sql',
	readonly: true
};

describe('canUseSql', () => {
	it('allows only configured remote projects', () => {
		expect(canUseSql(REMOTE, true)).toBe(true);
		expect(canUseSql(REMOTE, false)).toBe(false);
	});
});

describe('listProjectIssues', () => {
	it('reads issues from SQL and is always read-only', async () => {
		const result = await listProjectIssues(
			REMOTE,
			{ limit: 10, include_closed: false },
			{
				dolt: fakeDolt({
					browseIssues: async () => {
						return [summary('bd-1')];
					}
				}),
				dolt_configured: true
			}
		);

		expect(result).toMatchObject({ source: 'sql', readonly: true });
		expect(result.issues[0].id).toBe('bd-1');
	});

	it('does not silently fall back when remote SQL is unavailable', async () => {
		await expect(
			listProjectIssues(REMOTE, { limit: 10, include_closed: false }, { dolt_configured: false })
		).rejects.toThrow('remote Dolt is not configured');
	});

	it('refuses an unsupported Beads schema before querying issues', async () => {
		let browsed = false;
		const dolt = fakeDolt({
			browseIssues: async () => {
				browsed = true;
				return [];
			},
			schema: async () => ({
				status: 'unsupported',
				bd_version: '9.0.0',
				missing: ['issues.owner']
			})
		});
		await expect(
			listProjectIssues(
				REMOTE,
				{ limit: 10, include_closed: false },
				{ dolt, dolt_configured: true }
			)
		).rejects.toBeInstanceOf(UnsupportedSchemaError);
		expect(browsed).toBe(false);
	});

	it('reads untested schemas and ignores inspection failures', async () => {
		for (const schema of [
			async () => ({ status: 'untested' as const, missing: [] }),
			async () => {
				throw new Error('information_schema denied');
			}
		]) {
			const result = await listProjectIssues(
				REMOTE,
				{ limit: 10, include_closed: false },
				{
					dolt: fakeDolt({ browseIssues: async () => [summary('bd-1')], schema }),
					dolt_configured: true
				}
			);
			expect(result.issues).toHaveLength(1);
		}
	});
});

describe('unsupported schema in merged Ready', () => {
	it('drops only the unsupported project', async () => {
		const dolt = fakeDolt({
			listReadyIssues: async (database) => [summary(`${database}-1`)],
			schema: async (database) =>
				database === 'old_db'
					? { status: 'unsupported', missing: ['issues.owner'] }
					: { status: 'supported', missing: [] }
		});
		const projects = [
			{ ...REMOTE, id: 'd_old_db', name: 'old_db', dolt_database: 'old_db' },
			{ ...REMOTE, id: 'd_new_db', name: 'new_db', dolt_database: 'new_db' }
		];
		const result = await getMergedReadyIssues(projects, 10, { dolt, dolt_configured: true });
		expect(result.issues.map((issue) => issue.id)).toEqual(['new_db-1']);
	});
});

describe('issue detail and dependencies', () => {
	it('loads a remote detail as read-only', async () => {
		const result = await getProjectIssue(REMOTE, 'bd-1', {
			dolt: fakeDolt({
				issueDetail: async () => {
					return { ...summary('bd-1'), dependencies: [], dependents: [], comments: [] };
				}
			}),
			dolt_configured: true
		});

		expect(result?.readonly).toBe(true);
		expect(result?.issue.id).toBe('bd-1');
	});

	it('reads dependent edges from remote Dolt', async () => {
		const refs = await resolveDependents(REMOTE, 'bd-1', {
			dolt: fakeDolt({
				dependents: async () => {
					return [{ id: 'bd-2', dep_type: 'blocks' }];
				}
			}),
			dolt_configured: true
		});

		expect(refs).toEqual([{ id: 'bd-2', dep_type: 'blocks' }]);
	});
});

describe('remote activity', () => {
	it('uses the SQL events table when available', async () => {
		const events = await getProjectEvents(REMOTE, 10, {
			dolt: fakeDolt({
				recentEvents: async () => {
					return [
						{
							issue_id: 'bd-1',
							event_type: 'created',
							actor: 'agent',
							created_at: '2026-07-30T05:00:00Z'
						}
					];
				}
			}),
			dolt_configured: true
		});

		expect(events[0]).toMatchObject({ project_id: REMOTE.id, event_type: 'created' });
	});

	it('returns no supplemental activity from an unreachable remote project', async () => {
		const events = await getProjectEvents(REMOTE, 10, {
			dolt: fakeDolt({
				recentEvents: async () => {
					throw new Error('unreachable');
				}
			}),
			dolt_configured: true
		});

		expect(events).toEqual([]);
	});

	it('sorts activity across remote projects', async () => {
		const other = { ...REMOTE, id: 'd_other', name: 'Other', dolt_database: 'other' };
		const events = await getMergedEvents([REMOTE, other], 1, {
			dolt: fakeDolt({
				recentEvents: async (database: string) => {
					return [
						{
							issue_id: database,
							event_type: 'updated',
							actor: 'agent',
							created_at: database === 'other' ? '2026-07-30T06:00:00Z' : '2026-07-30T05:00:00Z'
						}
					];
				}
			}),
			dolt_configured: true
		});

		expect(events).toHaveLength(1);
		expect(events[0].issue_id).toBe('other');
	});
});

describe('ready deck', () => {
	it('merges unblocked issues across projects by priority then recency', async () => {
		const other = { ...REMOTE, id: 'd_other', name: 'Other', dolt_database: 'other' };
		const result = await getMergedReadyIssues([REMOTE, other], 10, {
			dolt: fakeDolt({
				listReadyIssues: async (database: string) => {
					if (database === 'other') {
						return [
							{ ...summary('other-p1', '2026-07-30T06:00:00Z'), priority: 1 },
							{ ...summary('other-p2', '2026-07-30T09:00:00Z'), priority: 2 }
						];
					}
					return [{ ...summary('acme-p2', '2026-07-30T08:00:00Z'), priority: 2 }];
				}
			}),
			dolt_configured: true
		});

		expect(result).toMatchObject({ source: 'sql', readonly: true });
		expect(result.issues.map((issue) => issue.id)).toEqual(['other-p1', 'other-p2', 'acme-p2']);
		expect(result.issues[0].project_id).toBe('d_other');
		expect(result.issues[2].project_name).toBe('ACME');
	});

	it('skips an unreachable project instead of hiding the rest of the deck', async () => {
		const other = { ...REMOTE, id: 'd_other', name: 'Other', dolt_database: 'other' };
		const result = await getMergedReadyIssues([REMOTE, other], 10, {
			dolt: fakeDolt({
				listReadyIssues: async (database: string) => {
					if (database === 'acme_platform') {
						throw new Error('unreachable');
					}
					return [summary('other-1')];
				}
			}),
			dolt_configured: true
		});

		expect(result.issues).toHaveLength(1);
		expect(result.issues[0].id).toBe('other-1');
	});

	it('caps the merged deck at the requested limit', async () => {
		const result = await getMergedReadyIssues([REMOTE], 1, {
			dolt: fakeDolt({
				listReadyIssues: async () => {
					return [
						{ ...summary('p0', '2026-07-30T01:00:00Z'), priority: 0 },
						{ ...summary('p1', '2026-07-30T02:00:00Z'), priority: 1 }
					];
				}
			}),
			dolt_configured: true
		});

		expect(result.issues.map((issue) => issue.id)).toEqual(['p0']);
	});
});
