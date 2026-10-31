import { beforeEach, describe, expect, it } from 'vitest';
import {
	DISCOVERY_TTL_MS,
	PROJECT_ID_PATTERN,
	ProjectDiscoveryError,
	discoverProjects,
	invalidateDiscovery,
	isValidDatabaseName,
	remoteProjects,
	serverProjectId
} from './discovery.js';
import type { DoltClient } from './dolt/client.js';
import { DoltCredentialError } from './dolt-password.js';

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

beforeEach(() => {
	invalidateDiscovery();
});

describe('remote project ids', () => {
	it('uses a stable d_ prefix and only accepts remote ids', () => {
		expect(serverProjectId('acme_platform')).toBe('d_acme_platform');
		expect(PROJECT_ID_PATTERN.test('d_acme_platform')).toBe(true);
		expect(PROJECT_ID_PATTERN.test('w_0123456789abcdef')).toBe(false);
		expect(PROJECT_ID_PATTERN.test('../etc/passwd')).toBe(false);
	});

	it('uses the same validation as the SQL client for database names', () => {
		expect(isValidDatabaseName('acme_platform')).toBe(true);
		expect(isValidDatabaseName('ACME')).toBe(false);
		expect(isValidDatabaseName('acme-platform')).toBe(false);
	});
});

describe('remoteProjects', () => {
	it('creates sorted, read-only remote projects and ignores invalid names', () => {
		const projects = remoteProjects(['zebra', 'acme_platform', 'not-valid', 'ACME']);

		expect(projects).toEqual([
			expect.objectContaining({
				id: 'd_acme_platform',
				name: 'acme_platform',
				state: 'remote',
				backend: 'server-sql',
				readonly: true
			}),
			expect.objectContaining({ id: 'd_zebra', state: 'remote', readonly: true })
		]);
		expect(Object.keys(projects[0])).toEqual([
			'id',
			'name',
			'state',
			'dolt_database',
			'backend',
			'readonly'
		]);
	});
});

describe('discoverProjects', () => {
	it('discovers and enriches remote projects through the read-only SQL client', async () => {
		const projects = await discoverProjects(
			{ force: true },
			{
				configured: true,
				dolt: fakeDolt({
					listDatabases: async () => {
						return ['acme_platform'];
					},
					issueCounts: async () => {
						return { open: 2, in_progress: 1, blocked: 0, closed: 4, total: 7 };
					},
					lastActivity: async () => {
						return '2026-08-11T20:00:00.000Z';
					}
				})
			}
		);

		expect(projects).toEqual([
			expect.objectContaining({
				id: 'd_acme_platform',
				state: 'remote',
				readonly: true,
				counts: { open: 2, in_progress: 1, blocked: 0, closed: 4, total: 7 },
				last_activity: '2026-08-11T20:00:00.000Z'
			})
		]);
	});

	it('retains a project when optional summary reads fail', async () => {
		const projects = await discoverProjects(
			{ force: true },
			{
				configured: true,
				dolt: fakeDolt({
					listDatabases: async () => {
						return ['acme_platform'];
					},
					issueCounts: async () => {
						throw new Error('summary unavailable');
					}
				})
			}
		);

		expect(projects).toEqual([expect.objectContaining({ id: 'd_acme_platform' })]);
		expect(projects[0].counts).toBeUndefined();
	});

	it('reports an unconfigured service instead of claiming there are no projects', async () => {
		await expect(discoverProjects({ force: true }, { configured: false })).rejects.toEqual(
			expect.objectContaining({
				name: 'ProjectDiscoveryError',
				message: 'Remote Dolt is not configured. Check the service connection configuration.',
				failure_kind: undefined
			})
		);
	});

	it.each([
		[
			new DoltCredentialError('credential /run/private/password missing'),
			'credential_unavailable',
			'Remote project discovery is unavailable because protected Dolt authentication is unavailable.'
		],
		[
			Object.assign(new Error('Access denied for sql-user at private-host'), {
				code: 'ER_ACCESS_DENIED_ERROR'
			}),
			'authentication_rejected',
			'Remote project discovery is unavailable because Dolt authentication was rejected.'
		],
		[
			Object.assign(new Error('connect private-host:3306'), { code: 'ECONNREFUSED' }),
			'unreachable',
			'Remote project discovery is unavailable because the Dolt server cannot be reached.'
		],
		[
			new Error('mysql://sql-user:password@private-host:3306/beads_web'),
			'unknown',
			'Remote project discovery is unavailable because the Dolt connection failed.'
		]
	])('turns a failed listing into a safe $1 discovery error', async (source, kind, message) => {
		let received: unknown;
		try {
			await discoverProjects(
				{ force: true },
				{
					configured: true,
					dolt: fakeDolt({
						listDatabases: async () => {
							throw source;
						}
					})
				}
			);
		} catch (error) {
			received = error;
		}

		expect(received).toEqual(
			expect.objectContaining({
				name: 'ProjectDiscoveryError',
				message,
				failure_kind: kind
			})
		);
		const serialized = JSON.stringify(received);
		expect(serialized).not.toContain('private-host');
		expect(serialized).not.toContain('sql-user');
		expect(serialized).not.toContain('beads_web');
	});

	it('reuses a fresh successful discovery result', async () => {
		let calls = 0;
		let current = 1_000;
		const deps = {
			configured: true,
			now: () => {
				return current;
			},
			dolt: fakeDolt({
				listDatabases: async () => {
					calls += 1;
					return ['acme_platform'];
				}
			})
		};

		await discoverProjects({}, deps);
		current += DISCOVERY_TTL_MS - 1;
		await discoverProjects({}, deps);

		expect(calls).toBe(1);
	});

	it('exports the dedicated safe error type', () => {
		const error = new ProjectDiscoveryError('unknown');
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe('ProjectDiscoveryError');
		expect(error.failure_kind).toBe('unknown');
		expect(error.message).toBe(
			'Remote project discovery is unavailable because the Dolt connection failed.'
		);
	});
});
