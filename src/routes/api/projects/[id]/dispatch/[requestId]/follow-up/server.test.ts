import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '$lib/types.js';
import { POST } from './+server.js';

const mocks = vi.hoisted(() => ({
	resolveProject: vi.fn<(id: string) => Promise<Project | undefined>>(),
	followUpDispatch: vi.fn()
}));

vi.mock('$lib/server/discovery.js', () => ({
	resolveProject: mocks.resolveProject
}));

vi.mock('$lib/server/dispatch/service.js', () => ({
	followUpDispatch: mocks.followUpDispatch
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
		request: new Request(
			`http://localhost/api/projects/d_beads_web/dispatch/${request_id}/follow-up`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			}
		)
	} as unknown as Parameters<typeof POST>[0]);
}

beforeEach(() => {
	mocks.resolveProject.mockReset();
	mocks.followUpDispatch.mockReset();
	mocks.resolveProject.mockResolvedValue(PROJECT);
});

describe('POST /api/projects/:id/dispatch/:requestId/follow-up', () => {
	it('rejects extra fields and model/repo choices', async () => {
		const response = await post({
			text: 'Also add tests.',
			model: 'composer',
			repository: 'https://github.com/evil/repo'
		});
		expect(response.status).toBe(400);
		expect(mocks.followUpDispatch).not.toHaveBeenCalled();
	});

	it('rejects an empty follow-up', async () => {
		const response = await post({ text: '   ' });
		expect(response.status).toBe(400);
		expect(mocks.followUpDispatch).not.toHaveBeenCalled();
	});

	it('forwards only the validated text', async () => {
		mocks.followUpDispatch.mockResolvedValue({
			id: REQUEST_ID,
			project_id: 'd_beads_web',
			operation: 'file',
			status: 'launched'
		});
		const response = await post({ text: 'Also add troubleshooting steps.' });
		expect(response.status).toBe(200);
		expect(mocks.followUpDispatch).toHaveBeenCalledWith(
			'd_beads_web',
			REQUEST_ID,
			'Also add troubleshooting steps.'
		);
	});
});
