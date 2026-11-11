import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '#lib/types.js';
import { RALPH_STEER_MAX_LENGTH } from '#lib/ralph.js';
import { POST } from './+server.js';

const mocks = vi.hoisted(() => ({
	resolveProject: vi.fn<(id: string) => Promise<Project | undefined>>(),
	steerDispatch: vi.fn()
}));

vi.mock('#lib/server/discovery.js', () => ({
	resolveProject: mocks.resolveProject
}));

vi.mock('#lib/server/dispatch/service.js', () => ({
	steerDispatch: mocks.steerDispatch
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

async function post(body: unknown, request_id = REQUEST_ID): Promise<Response> {
	return POST({
		params: { id: 'd_beads_web', requestId: request_id },
		request: new Request(`http://localhost/api/projects/d_beads_web/dispatch/${request_id}/steer`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		})
	} as unknown as Parameters<typeof POST>[0]);
}

beforeEach(() => {
	mocks.resolveProject.mockReset();
	mocks.steerDispatch.mockReset();
	mocks.resolveProject.mockResolvedValue(PROJECT);
});

describe('POST /api/projects/:id/dispatch/:requestId/steer', () => {
	it('takes only the note: extra fields, empty and oversized notes are refused', async () => {
		expect((await post({ text: 'Skip the docs.', path: '/v1/runs' })).status).toBe(400);
		expect((await post({ text: '   ' })).status).toBe(400);
		expect((await post({ text: 'x'.repeat(RALPH_STEER_MAX_LENGTH + 1) })).status).toBe(400);
		expect(mocks.steerDispatch).not.toHaveBeenCalled();
	});

	it('forwards the trimmed note', async () => {
		mocks.steerDispatch.mockResolvedValue({
			id: REQUEST_ID,
			project_id: 'd_beads_web',
			operation: 'loop',
			status: 'running'
		});
		const response = await post({ text: '  Fix the flaky test first.  ' });
		expect(response.status).toBe(200);
		expect(mocks.steerDispatch).toHaveBeenCalledWith(
			'd_beads_web',
			REQUEST_ID,
			'Fix the flaky test first.'
		);
	});

	it('returns 404 when the project or mission is missing', async () => {
		mocks.steerDispatch.mockResolvedValue(undefined);
		expect((await post({ text: 'Hi.' })).status).toBe(404);
		mocks.resolveProject.mockResolvedValue(undefined);
		expect((await post({ text: 'Hi.' })).status).toBe(404);
	});
});
