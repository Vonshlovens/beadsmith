import { beforeEach, describe, expect, it } from 'vitest';
import {
	AGENT_WINDOW_MS,
	DOLT_PROBE_TTL_MS,
	findAgentActivity,
	getStatus,
	isAgentActor,
	resetStatusCache,
	statusForViewer
} from './status.js';
import { readEnv } from './env.js';
import type { DoltClient } from './dolt/client.js';
import { DoltCredentialError } from './dolt-password.js';
import type { ActivityEvent, Project, StatusSnapshot } from '$lib/types.js';

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
			return 3;
		},
		...overrides
	};
}

function event(
	actor: string,
	created_at: string
): Omit<ActivityEvent, 'project_id' | 'project_name'> {
	return { issue_id: 'bd-1', event_type: 'updated', actor, created_at };
}

const REMOTE_PROJECT: Project = {
	id: 'd_acme_platform',
	name: 'ACME',
	state: 'remote',
	dolt_database: 'acme_platform',
	backend: 'server-sql',
	readonly: true
};

beforeEach(() => {
	resetStatusCache();
});

describe('isAgentActor', () => {
	it('matches case-insensitively as a substring', () => {
		expect(isAgentActor('Claude-Agent', ['agent'])).toBe(true);
	});

	it('does not match an unrelated actor', () => {
		expect(isAgentActor('Eric', ['agent'])).toBe(false);
	});
});

describe('findAgentActivity', () => {
	it('reports active for a recent remote agent event', async () => {
		const now = Date.parse('2026-07-30T12:00:00Z');
		const activity = await findAgentActivity(
			fakeDolt({
				recentEvents: async () => {
					return [event('agent', '2026-07-30T11:55:00Z')];
				}
			}),
			[REMOTE_PROJECT],
			['agent'],
			() => now
		);

		expect(activity).toMatchObject({ active: true, count: 1, last_actor: 'agent' });
	});

	it('reports inactive for stale events', async () => {
		const now = Date.parse('2026-07-30T12:00:00Z');
		const activity = await findAgentActivity(
			fakeDolt({
				recentEvents: async () => {
					return [event('agent', new Date(now - AGENT_WINDOW_MS - 60_000).toISOString())];
				}
			}),
			[REMOTE_PROJECT],
			['agent'],
			() => now
		);

		expect(activity.active).toBe(false);
		expect(activity.last_seen).toBeDefined();
	});
});

describe('getStatus', () => {
	it('reports remote Dolt without serialising protected configuration', async () => {
		const env = readEnv({
			HOME: '/home/tester',
			BEADS_DOLT_SERVER_HOST: '100.64.0.10',
			BEADS_DOLT_SERVER_USER: 'root',
			BEADS_DOLT_PASSWORD: 'hunter2'
		});

		const snapshot = await getStatus({
			env,
			dolt: fakeDolt(),
			projects: async () => [],
			state_ok: true,
			armed: true
		});

		expect(snapshot).toMatchObject({
			mode: 'remote',
			dolt: { configured: true, reachable: true },
			dispatch: { enabled: false }
		});
		expect(JSON.stringify(snapshot)).not.toContain('hunter2');
		expect(JSON.stringify(snapshot)).not.toContain('100.64.0.10');
		expect(JSON.stringify(snapshot)).not.toContain('root');
		expect(snapshot.dolt).not.toHaveProperty('host');
		expect(snapshot.dolt).not.toHaveProperty('port');
		expect(snapshot.dolt).not.toHaveProperty('user');
		expect(snapshot.state_db).not.toHaveProperty('path');
		expect(snapshot).not.toHaveProperty('bd');
	});

	it('reports a transport failure and skips agent discovery when the probe fails', async () => {
		let project_calls = 0;
		const snapshot = await getStatus({
			env: readEnv({ HOME: '/home/tester', BEADS_DOLT_SERVER_HOST: 'dolt.internal' }),
			dolt: fakeDolt({
				ping: async () => {
					throw Object.assign(new Error('connect private-host:3306'), {
						code: 'ECONNREFUSED'
					});
				}
			}),
			projects: async () => {
				project_calls += 1;
				return [REMOTE_PROJECT];
			},
			state_ok: false,
			armed: true
		});

		expect(snapshot.dolt.reachable).toBe(false);
		expect(snapshot.dolt.failure_kind).toBe('unreachable');
		expect(snapshot.agents).toEqual({ active: false, count: 0 });
		expect(snapshot.dispatch).toEqual({
			enabled: false,
			key_configured: false,
			armed: true,
			provider: 'none'
		});
		expect(project_calls).toBe(0);
	});

	it.each([
		[
			new DoltCredentialError('credential /run/private/password unreadable'),
			'credential_unavailable'
		],
		[
			Object.assign(new Error('Access denied for sql-user at private-host'), {
				code: 'ER_ACCESS_DENIED_ERROR'
			}),
			'authentication_rejected'
		],
		[new Error('driver said password=not-safe at private-host'), 'unknown']
	])('reports only safe failure class %s', async (source, failure_kind) => {
		const snapshot = await getStatus({
			env: readEnv({ HOME: '/home/tester', BEADS_DOLT_SERVER_HOST: 'dolt.internal' }),
			dolt: fakeDolt({
				ping: async () => {
					throw source;
				}
			}),
			projects: async () => [],
			state_ok: true,
			armed: true
		});

		expect(snapshot.dolt).toMatchObject({ reachable: false, failure_kind });
		const serialized = JSON.stringify(snapshot);
		expect(serialized).not.toContain('private-host');
		expect(serialized).not.toContain('sql-user');
		expect(serialized).not.toContain('not-safe');
	});

	it('caches a recent Dolt probe', async () => {
		let current = 1_000;
		let calls = 0;
		const deps = {
			env: readEnv({ HOME: '/home/tester', BEADS_DOLT_SERVER_HOST: 'dolt.internal' }),
			dolt: fakeDolt({
				ping: async () => {
					calls += 1;
					return 1;
				}
			}),
			projects: async () => [],
			state_ok: true,
			armed: true,
			now: () => current
		};

		await getStatus(deps);
		current += DOLT_PROBE_TTL_MS - 1;
		await getStatus(deps);

		expect(calls).toBe(1);
	});

	it('treats dispatch.enabled as key configured and globally armed', async () => {
		const env = readEnv({
			HOME: '/home/tester',
			BDX_DISPATCH_PROVIDER: 'webhook',
			BDX_DISPATCH_WEBHOOK_URL: 'https://runner.example.com/beadsmith',
			BDX_DISPATCH_WEBHOOK_SECRET: 'not-a-real-secret-'.repeat(2)
		});
		const armed = await getStatus({
			env,
			dolt: fakeDolt(),
			projects: async () => [],
			state_ok: true,
			armed: true
		});
		const disarmed = await getStatus({
			env,
			dolt: fakeDolt(),
			projects: async () => [],
			state_ok: true,
			armed: false
		});

		const capabilities = { live_events: false, follow_up: true, cancel: true };
		expect(armed.dispatch).toEqual({
			enabled: true,
			key_configured: true,
			armed: true,
			provider: 'webhook',
			capabilities
		});
		expect(disarmed.dispatch).toEqual({
			enabled: false,
			key_configured: true,
			armed: false,
			provider: 'webhook',
			capabilities
		});
		expect(JSON.stringify(armed)).not.toContain('not-a-real-secret');
	});

	it('reports what a webhook runner can do, so the console polls instead of streaming', async () => {
		const status = await getStatus({
			env: readEnv({
				HOME: '/home/tester',
				BDX_DISPATCH_PROVIDER: 'webhook',
				BDX_DISPATCH_WEBHOOK_URL: 'https://runner.example.com/beadsmith',
				BDX_DISPATCH_WEBHOOK_SECRET: 'x'.repeat(40)
			}),
			dolt: fakeDolt(),
			projects: async () => [],
			state_ok: true,
			armed: true
		});
		expect(status.dispatch.provider).toBe('webhook');
		expect(status.dispatch.capabilities).toEqual({
			live_events: false,
			follow_up: true,
			cancel: true
		});
		expect(JSON.stringify(status)).not.toContain('x'.repeat(40));
	});
});

describe('statusForViewer', () => {
	const base = {
		mode: 'remote',
		dolt: { configured: true, reachable: true },
		state_db: { ok: true },
		agents: { active: false, count: 0 },
		dispatch: { enabled: true, key_configured: true, armed: true, provider: 'webhook' }
	} as StatusSnapshot;

	it('keeps dispatch for admins and marks they can launch', () => {
		expect(statusForViewer(base, 'admin').dispatch).toMatchObject({
			enabled: true,
			viewer_can_launch: true
		});
	});

	it('turns dispatch off for members and unknown viewers without touching the rest', () => {
		for (const role of ['member', undefined] as const) {
			const masked = statusForViewer(base, role);
			expect(masked.dispatch).toMatchObject({
				enabled: false,
				viewer_can_launch: false,
				key_configured: true,
				armed: true
			});
			expect(masked.dolt).toEqual(base.dolt);
		}
		expect(base.dispatch.enabled).toBe(true);
	});

	it('never turns a disabled dispatch on for an admin', () => {
		const off = { ...base, dispatch: { ...base.dispatch, enabled: false } };
		expect(statusForViewer(off, 'admin').dispatch.enabled).toBe(false);
	});
});
