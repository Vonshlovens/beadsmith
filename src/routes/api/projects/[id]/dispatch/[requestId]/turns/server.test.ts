import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '$lib/types.js';
import { GET } from './+server.js';

const mocks = vi.hoisted(() => ({
	resolveProject: vi.fn<(id: string) => Promise<Project | undefined>>(),
	listDispatchTurns: vi.fn()
}));

vi.mock('$lib/server/discovery.js', () => ({
	resolveProject: mocks.resolveProject
}));

vi.mock('$lib/server/dispatch/service.js', () => ({
	listDispatchTurns: mocks.listDispatchTurns
}));

const PROJECT: Project = {
	id: 'd_beads_web',
	name: 'beads_web',
	state: 'remote',
	dolt_database: 'beads_web',
	backend: 'server-sql',
	readonly: true
};

const REQUEST_ID = 'dq_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

async function get(request_id = REQUEST_ID, project_id = 'd_beads_web'): Promise<Response> {
	return GET({
		params: { id: project_id, requestId: request_id }
	} as unknown as Parameters<typeof GET>[0]);
}

beforeEach(() => {
	mocks.resolveProject.mockReset();
	mocks.listDispatchTurns.mockReset();
	mocks.resolveProject.mockResolvedValue(PROJECT);
});

describe('GET /api/projects/:id/dispatch/:requestId/turns', () => {
	it('returns the conversation for a mission in this project', async () => {
		const turns = [
			{ seq: 1, role: 'operator', text: 'Discuss this issue.', created_at: '2026-10-17T00:00:00Z' }
		];
		mocks.listDispatchTurns.mockResolvedValue(turns);
		const response = await get();
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ turns });
		expect(mocks.listDispatchTurns).toHaveBeenCalledWith('d_beads_web', REQUEST_ID);
	});

	it('404s for an unknown mission or project, and 400s for a malformed id', async () => {
		mocks.listDispatchTurns.mockResolvedValue(undefined);
		expect((await get()).status).toBe(404);

		mocks.resolveProject.mockResolvedValue(undefined);
		expect((await get()).status).toBe(404);

		expect((await get('dq_not-an-id')).status).toBe(400);
		expect(mocks.listDispatchTurns).toHaveBeenCalledTimes(1);
	});
});
