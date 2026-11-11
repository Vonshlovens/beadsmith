import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '#lib/types.js';
import { DispatchError } from '#lib/server/dispatch/types.js';
import { POST } from './+server.js';

const mocks = vi.hoisted(() => ({
	resolveProject: vi.fn<(id: string) => Promise<Project | undefined>>(),
	stopDispatchAfterIteration: vi.fn()
}));

vi.mock('#lib/server/discovery.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/discovery.js')>()),
	resolveProject: mocks.resolveProject
}));

vi.mock('#lib/server/dispatch/service.js', () => ({
	stopDispatchAfterIteration: mocks.stopDispatchAfterIteration
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
			`http://localhost/api/projects/d_beads_web/dispatch/${request_id}/stop-after-iteration`,
			{ method: 'POST' }
		)
	} as unknown as Parameters<typeof POST>[0]);
}

beforeEach(() => {
	mocks.resolveProject.mockReset();
	mocks.stopDispatchAfterIteration.mockReset();
	mocks.resolveProject.mockResolvedValue(PROJECT);
});

describe('POST /api/projects/:id/dispatch/:requestId/stop-after-iteration', () => {
	it('refuses a malformed request id before touching the service', async () => {
		const response = await post('dq_nope');
		expect(response.status).toBe(400);
		expect(mocks.stopDispatchAfterIteration).not.toHaveBeenCalled();
	});

	it('returns 404 when the dispatch row is missing', async () => {
		mocks.stopDispatchAfterIteration.mockResolvedValue(undefined);
		expect((await post()).status).toBe(404);
	});

	it('returns the loop with its stop on the way', async () => {
		mocks.stopDispatchAfterIteration.mockResolvedValue({
			id: REQUEST_ID,
			project_id: 'd_beads_web',
			operation: 'loop',
			status: 'running',
			loop: { mode: 'build', stop_requested: true }
		});
		const response = await post();
		expect(response.status).toBe(200);
		const body = (await response.json()) as { request: { loop: { stop_requested: boolean } } };
		expect(body.request.loop.stop_requested).toBe(true);
		expect(mocks.stopDispatchAfterIteration).toHaveBeenCalledWith('d_beads_web', REQUEST_ID);
	});

	it('answers 409 when the loop is not running', async () => {
		mocks.stopDispatchAfterIteration.mockRejectedValue(
			new DispatchError('conflict', 'The loop is not running.')
		);
		expect((await post()).status).toBe(409);
	});
});
