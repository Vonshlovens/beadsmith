import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '$lib/types.js';
import { POST } from './+server.js';

const mocks = vi.hoisted(() => ({
	resolveProject: vi.fn<(id: string) => Promise<Project | undefined>>(),
	cancelDispatch: vi.fn()
}));

vi.mock('$lib/server/discovery.js', () => ({
	resolveProject: mocks.resolveProject
}));

vi.mock('$lib/server/dispatch/service.js', () => ({
	cancelDispatch: mocks.cancelDispatch
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

async function post(request_id = REQUEST_ID): Promise<Response> {
	return POST({
		params: { id: 'd_beads_web', requestId: request_id },
		request: new Request(
			`http://localhost/api/projects/d_beads_web/dispatch/${request_id}/cancel`,
			{ method: 'POST' }
		)
	} as unknown as Parameters<typeof POST>[0]);
}

beforeEach(() => {
	mocks.resolveProject.mockReset();
	mocks.cancelDispatch.mockReset();
	mocks.resolveProject.mockResolvedValue(PROJECT);
});

describe('POST /api/projects/:id/dispatch/:requestId/cancel', () => {
	it('returns 404 when the dispatch row is missing', async () => {
		mocks.cancelDispatch.mockResolvedValue(undefined);
		const response = await post();
		expect(response.status).toBe(404);
	});

	it('cancels the matching mission', async () => {
		mocks.cancelDispatch.mockResolvedValue({
			id: REQUEST_ID,
			project_id: 'd_beads_web',
			operation: 'tackle',
			status: 'cancelled'
		});
		const response = await post();
		expect(response.status).toBe(200);
		const body = (await response.json()) as { request: { status: string } };
		expect(body.request.status).toBe('cancelled');
		expect(mocks.cancelDispatch).toHaveBeenCalledWith('d_beads_web', REQUEST_ID);
	});
});
