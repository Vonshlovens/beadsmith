import { describe, expect, it } from 'vitest';
import { createDoltClient, poolQuery } from './dolt/client.js';
import { getEnv } from './env.js';
import { remoteProjects } from './discovery.js';

/**
 * Live, read-only sanity check against the configured remote Dolt service.
 * Skipped unless `BDX_LIVE=1`; it performs no `bd` calls and no writes.
 */
const LIVE = process.env.BDX_LIVE === '1';

describe.runIf(LIVE)('live discovery', () => {
	it('finds remote projects without inspecting local workspaces', async () => {
		const client = createDoltClient(poolQuery);
		const projects = remoteProjects(await client.listDatabases());

		expect(projects.length).toBeGreaterThanOrEqual(1);
		expect(projects.every((project) => project.state === 'remote' && project.readonly)).toBe(true);
	});

	it('never serialises the Dolt password', async () => {
		const password = process.env.BEADS_DOLT_PASSWORD;
		const client = createDoltClient(poolQuery);
		const serialised = JSON.stringify({
			projects: remoteProjects(await client.listDatabases()),
			env: getEnv()
		});

		expect(serialised).not.toContain('password');
		if (password !== undefined && password.length > 0) {
			expect(serialised).not.toContain(password);
		}
	});
});

describe.runIf(!LIVE)('live discovery', () => {
	it('is skipped without BDX_LIVE=1', () => {
		expect(LIVE).toBe(false);
	});
});
