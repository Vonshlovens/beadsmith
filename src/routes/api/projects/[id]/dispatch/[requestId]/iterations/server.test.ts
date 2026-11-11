import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '#lib/types.js';
import { GET } from './+server.js';

const mocks = vi.hoisted(() => ({
	resolveProject: vi.fn<(id: string) => Promise<Project | undefined>>(),
	listLoopIterations: vi.fn()
}));

vi.mock('#lib/server/discovery.js', () => ({
	resolveProject: mocks.resolveProject
}));

vi.mock('#lib/server/dispatch/service.js', () => ({
	listLoopIterations: mocks.listLoopIterations
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
	mocks.listLoopIterations.mockReset();
	mocks.resolveProject.mockResolvedValue(PROJECT);
});

describe('GET /api/projects/:id/dispatch/:requestId/iterations', () => {
	it("returns a loop mission's iterations in this project", async () => {
		const iterations = [
			{
				run_id: 'loop-1',
				iteration: 1,
				outcome: 'completed',
				started_at: '2026-11-11T10:00:00.000Z',
				finished_at: '2026-11-11T10:05:00.000Z',
				duration_ms: 300_000,
				head_before: 'aaaaaaa',
				head_after: 'bbbbbbb',
				input_tokens: 1200,
				output_tokens: 300,
				cost_usd: 0.42,
				validate_ok: true,
				plan_open: 3
			}
		];
		mocks.listLoopIterations.mockResolvedValue(iterations);
		const response = await get();
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ iterations });
		expect(mocks.listLoopIterations).toHaveBeenCalledWith('d_beads_web', REQUEST_ID);
	});

	it('404s for an unknown mission or project, and 400s for a malformed id', async () => {
		mocks.listLoopIterations.mockResolvedValue(undefined);
		expect((await get()).status).toBe(404);

		mocks.resolveProject.mockResolvedValue(undefined);
		expect((await get()).status).toBe(404);

		expect((await get('dq_not-an-id')).status).toBe(400);
		expect(mocks.listLoopIterations).toHaveBeenCalledTimes(1);
	});
});
