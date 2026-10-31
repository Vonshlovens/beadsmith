import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mission } from '$lib/types.js';
import { GET } from './+server.js';

const mocks = vi.hoisted(() => ({
	discoverProjects: vi.fn(),
	listMissions: vi.fn()
}));

vi.mock('$lib/server/discovery.js', () => ({
	discoverProjects: mocks.discoverProjects
}));

vi.mock('$lib/server/dispatch/service.js', () => ({
	listMissions: mocks.listMissions
}));

const MISSION: Mission = {
	id: 'dq_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	project_id: 'd_beads_web',
	project_name: 'beads_web',
	operation: 'tackle',
	status: 'launched',
	issue_id: 'beads-web-s42.3',
	actor: 'owner@example.com',
	agent_url: 'https://runner.example.com/agents/bc-1',
	created_at: '2026-08-25T00:00:00.000Z',
	updated_at: '2026-08-25T00:00:00.000Z'
};

async function get(query = ''): Promise<Response> {
	return GET({
		url: new URL(`http://localhost/api/missions${query}`)
	} as unknown as Parameters<typeof GET>[0]);
}

beforeEach(() => {
	mocks.discoverProjects.mockReset();
	mocks.listMissions.mockReset();
	mocks.discoverProjects.mockResolvedValue([
		{
			id: 'd_beads_web',
			name: 'beads_web',
			state: 'remote',
			dolt_database: 'beads_web',
			backend: 'server-sql',
			readonly: true
		}
	]);
	mocks.listMissions.mockResolvedValue([MISSION]);
});

describe('GET /api/missions', () => {
	it('lists recent missions with project names', async () => {
		const response = await get();

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ missions: [MISSION] });
		expect(mocks.listMissions).toHaveBeenCalledWith(
			{ limit: 50 },
			{ project_names: new Map([['d_beads_web', 'beads_web']]) }
		);
	});

	it('filters by project and issue', async () => {
		const response = await get('?project_id=d_beads_web&issue_id=beads-web-s42.3&limit=20');

		expect(response.status).toBe(200);
		expect(mocks.listMissions).toHaveBeenCalledWith(
			{ limit: 20, project_id: 'd_beads_web', issue_id: 'beads-web-s42.3' },
			expect.anything()
		);
	});

	it('still lists when discovery is down', async () => {
		mocks.discoverProjects.mockRejectedValue(new Error('dolt down'));

		const response = await get();

		expect(response.status).toBe(200);
		expect(mocks.listMissions).toHaveBeenCalledWith({ limit: 50 }, { project_names: new Map() });
	});

	it('rejects an invalid project id', async () => {
		const response = await get('?project_id=not-a-project');

		expect(response.status).toBe(400);
		expect(mocks.listMissions).not.toHaveBeenCalled();
	});
});
