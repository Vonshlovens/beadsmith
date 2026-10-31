import { describe, expect, it } from 'vitest';
import { getConsoleSnapshot } from './console.js';
import { readEnv } from './env.js';
import type { Project, StatusSnapshot } from '$lib/types.js';

const HEALTH: StatusSnapshot = {
	mode: 'remote',
	dolt: { configured: true, reachable: true, latency_ms: 4 },
	state_db: { ok: true },
	agents: { active: false, count: 0 },
	dispatch: { enabled: true, key_configured: true, armed: true }
};

const BEADS_WEB: Project = {
	id: 'd_beads_web',
	name: 'beads_web',
	state: 'remote',
	dolt_database: 'beads_web',
	backend: 'server-sql',
	readonly: true,
	last_activity: '2026-08-24T12:00:00.000Z',
	counts: { open: 2, in_progress: 1, blocked: 0, closed: 3, total: 6 }
};

const OTHER: Project = {
	id: 'd_other',
	name: 'other',
	state: 'remote',
	dolt_database: 'other',
	backend: 'server-sql',
	readonly: true
};

describe('getConsoleSnapshot', () => {
	it('joins discovered projects with Tackle maps and counts coverage', async () => {
		const snapshot = await getConsoleSnapshot({
			env: readEnv({ HOME: '/home/tester' }),
			status: HEALTH,
			projects: [BEADS_WEB, OTHER],
			sqlite_maps: {},
			file_maps: {},
			allows: {},
			maps: {
				mappings: {
					d_beads_web: {
						url: 'https://github.com/example-org/beads-web',
						ref: 'main',
						auto_create_pr: true
					}
				}
			}
		});

		expect(snapshot.coverage).toEqual({
			project_count: 2,
			mapped_count: 1,
			unmapped_ids: ['d_other'],
			maps_invalid: false
		});
		expect(snapshot.projects[0]?.tackle).toEqual({
			mapped: true,
			url: 'https://github.com/example-org/beads-web',
			ref: 'main',
			auto_create_pr: true,
			source: 'env'
		});
		expect(snapshot.projects[1]?.tackle).toEqual({ mapped: false });
		expect(snapshot.projects[0]?.file).toEqual({ mapped: false });
		expect(snapshot.projects[1]?.file).toEqual({ mapped: false });
		expect(snapshot.projects[0]?.allow).toEqual({ file: true, tackle: true });
		expect(snapshot.projects[1]?.allow).toEqual({ file: true, tackle: true });
		expect(snapshot.health.dispatch.enabled).toBe(true);
		expect(snapshot.health.dolt.reachable).toBe(true);
	});

	it('treats every project as unmapped when the mapping config is invalid', async () => {
		const snapshot = await getConsoleSnapshot({
			status: HEALTH,
			projects: [BEADS_WEB],
			sqlite_maps: {},
			file_maps: {},
			allows: {},
			maps: {
				mappings: {
					d_beads_web: {
						url: 'https://github.com/example-org/beads-web',
						ref: 'main',
						auto_create_pr: true
					}
				},
				error: 'invalid'
			}
		});

		expect(snapshot.coverage.maps_invalid).toBe(true);
		expect(snapshot.coverage.mapped_count).toBe(0);
		expect(snapshot.coverage.unmapped_ids).toEqual(['d_beads_web']);
		expect(snapshot.projects[0]?.tackle.mapped).toBe(false);
	});

	it('omits hosts, credential paths, passwords, and keys from the payload', async () => {
		const snapshot = await getConsoleSnapshot({
			env: readEnv({
				HOME: '/home/tester',
				BEADS_DOLT_SERVER_HOST: '100.64.0.10',
				BEADS_DOLT_SERVER_USER: 'root',
				BEADS_DOLT_PASSWORD: 'hunter2',
				BDX_DISPATCH_PROVIDER: 'webhook',
				BDX_DISPATCH_WEBHOOK_URL: 'https://runner.example.com/beadsmith',
				BDX_DISPATCH_WEBHOOK_SECRET: 'runner-secret-value-'.repeat(2),
				BDX_DISPATCH_WEBHOOK_SECRET_FILE: '/run/secrets/runner-secret'
			}),
			status: HEALTH,
			projects: [BEADS_WEB],
			sqlite_maps: {},
			file_maps: {},
			allows: {},
			map_env: {
				BDX_TACKLE_REPOSITORIES_FILE: '/etc/beads-web/tackle-repositories.json'
			}
		});

		const serialized = JSON.stringify(snapshot);
		expect(serialized).not.toContain('hunter2');
		expect(serialized).not.toContain('runner-secret-value');
		expect(serialized).not.toContain('100.64.0.10');
		expect(serialized).not.toContain('/run/secrets/runner-secret');
		expect(serialized).not.toContain('/etc/beads-web/tackle-repositories.json');
		expect(serialized).not.toContain('root');
		expect(snapshot.health.dolt).not.toHaveProperty('host');
		expect(snapshot.health.dolt).not.toHaveProperty('port');
		expect(snapshot.health.dolt).not.toHaveProperty('user');
		expect(snapshot.health.state_db).not.toHaveProperty('path');
		expect(snapshot).not.toHaveProperty('bd');
	});

	it('uses SQLite maps when env has none, and env wins on the same project', async () => {
		const snapshot = await getConsoleSnapshot({
			status: HEALTH,
			projects: [BEADS_WEB, OTHER],
			maps: {
				mappings: {
					d_beads_web: {
						url: 'https://github.com/example-org/beads-web',
						ref: 'main',
						auto_create_pr: true
					}
				}
			},
			sqlite_maps: {
				d_beads_web: {
					url: 'https://github.com/example-org/ignored',
					ref: 'sqlite',
					auto_create_pr: false
				},
				d_other: {
					url: 'https://github.com/example-org/other',
					ref: 'develop',
					auto_create_pr: false
				}
			},
			file_maps: {},
			allows: {
				d_other: { file: true, tackle: false }
			}
		});

		expect(snapshot.projects[0]?.tackle).toEqual({
			mapped: true,
			url: 'https://github.com/example-org/beads-web',
			ref: 'main',
			auto_create_pr: true,
			source: 'env'
		});
		expect(snapshot.projects[1]?.tackle).toEqual({
			mapped: true,
			url: 'https://github.com/example-org/other',
			ref: 'develop',
			auto_create_pr: false,
			source: 'sqlite'
		});
		expect(snapshot.coverage.mapped_count).toBe(2);
		expect(snapshot.projects[1]?.allow).toEqual({ file: true, tackle: false });
	});

	it('joins File checkout maps without changing Tackle coverage', async () => {
		const snapshot = await getConsoleSnapshot({
			status: HEALTH,
			projects: [BEADS_WEB, OTHER],
			maps: { mappings: {} },
			sqlite_maps: {},
			file_maps: {
				d_other: {
					url: 'https://github.com/example-org/other',
					ref: 'develop'
				}
			},
			allows: {}
		});

		expect(snapshot.coverage.mapped_count).toBe(0);
		expect(snapshot.projects[0]?.file).toEqual({ mapped: false });
		expect(snapshot.projects[1]?.file).toEqual({
			mapped: true,
			url: 'https://github.com/example-org/other',
			ref: 'develop'
		});
		expect(snapshot.projects[1]?.tackle).toEqual({ mapped: false });
	});

	it('lists redacted Access config without audience tags or JWTs', async () => {
		const audience = 'aud-tag-must-never-leave-the-server';
		const snapshot = await getConsoleSnapshot({
			env: readEnv({
				HOME: '/home/tester',
				BEADS_DOLT_SERVER_HOST: 'dolt.internal',
				BDX_ALLOWED_HOSTS: 'beads.example.com',
				BDX_PUBLIC_ORIGIN: 'https://beads.example.com',
				BDX_CF_ACCESS_ISSUER: 'https://beads.cloudflareaccess.com',
				BDX_CF_ACCESS_AUDIENCE: audience,
				BDX_CF_ACCESS_ALLOWED_SERVICE_TOKEN_IDS: '0123456789abcdef0123456789abcdef'
			}),
			status: HEALTH,
			projects: [BEADS_WEB],
			sqlite_maps: {},
			file_maps: {},
			allows: {},
			maps: { mappings: {} }
		});

		expect(snapshot.access).toEqual({
			issuer_host: 'beads.cloudflareaccess.com',
			audience_configured: true,
			service_token_ids: ['0123456789abcdef0123456789abcdef'],
			allowed_hosts: ['beads.example.com'],
			public_origin: 'https://beads.example.com',
			policy: 'ok'
		});
		const serialized = JSON.stringify(snapshot);
		expect(serialized).not.toContain(audience);
		expect(serialized).not.toContain('cdn-cgi/access/certs');
	});

	it('omits a JWKS issuer URL and reports an incomplete Access configuration', async () => {
		const snapshot = await getConsoleSnapshot({
			env: readEnv({
				HOME: '/home/tester',
				BEADS_DOLT_SERVER_HOST: 'dolt.internal',
				BDX_CF_ACCESS_ISSUER: 'https://evil.example/cdn-cgi/access/certs',
				BDX_CF_ACCESS_ALLOWED_SERVICE_TOKEN_IDS: '0123456789abcdef0123456789abcdef'
			}),
			status: HEALTH,
			projects: [BEADS_WEB],
			sqlite_maps: {},
			file_maps: {},
			allows: {},
			maps: { mappings: {} }
		});

		expect(snapshot.access.issuer_host).toBeUndefined();
		expect(snapshot.access.audience_configured).toBe(false);
		expect(snapshot.access.policy).toBe('incomplete');
		const serialized = JSON.stringify(snapshot);
		expect(serialized).not.toContain('evil.example');
	});
});
