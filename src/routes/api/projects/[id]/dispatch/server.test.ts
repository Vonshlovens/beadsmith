import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '$lib/types.js';
import { POST } from './+server.js';

const mocks = vi.hoisted(() => ({
	resolveProject: vi.fn<(id: string) => Promise<Project | undefined>>(),
	enqueueDispatch: vi.fn(),
	getProjectIssue: vi.fn()
}));

vi.mock('$lib/server/discovery.js', () => ({
	resolveProject: mocks.resolveProject
}));

vi.mock('$lib/server/dispatch/service.js', () => ({
	enqueueDispatch: mocks.enqueueDispatch
}));

vi.mock('$lib/server/read-model.js', () => ({
	getProjectIssue: mocks.getProjectIssue
}));

const PROJECT: Project = {
	id: 'd_beads_web',
	name: 'beads_web',
	state: 'remote',
	dolt_database: 'beads_web',
	backend: 'server-sql',
	readonly: true
};

async function post(body: unknown): Promise<Response> {
	return POST({
		params: { id: 'd_beads_web' },
		locals: {},
		request: new Request('http://localhost/api/projects/d_beads_web/dispatch', {
			method: 'POST',
			body: JSON.stringify(body)
		})
	} as unknown as Parameters<typeof POST>[0]);
}

beforeEach(() => {
	mocks.resolveProject.mockReset();
	mocks.enqueueDispatch.mockReset();
	mocks.getProjectIssue.mockReset();
});

describe('POST /api/projects/:id/dispatch', () => {
	it('rejects an unknown operation without launching', async () => {
		const response = await post({
			operation: 'close',
			idempotency_key: 'idem-aaaaaaaa',
			issue_id: 'beads-web-1'
		});

		expect(response.status).toBe(400);
		expect(mocks.enqueueDispatch).not.toHaveBeenCalled();
	});

	it('files by enqueueing an agent', async () => {
		mocks.resolveProject.mockResolvedValue(PROJECT);
		mocks.enqueueDispatch.mockResolvedValue({
			created: true,
			request: {
				id: 'dq_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				project_id: 'd_beads_web',
				operation: 'file',
				status: 'launched',
				agent_url: 'https://runner.example.com/agents/bc-1',
				created_at: '2026-08-16T00:00:00.000Z',
				updated_at: '2026-08-16T00:00:00.000Z'
			}
		});

		const response = await post({
			operation: 'file',
			idempotency_key: 'idem-aaaaaaaa',
			notes: 'Users cannot sign in.'
		});

		expect(response.status).toBe(201);
		expect(mocks.enqueueDispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				project: PROJECT,
				payload: expect.objectContaining({ operation: 'file', notes: 'Users cannot sign in.' })
			})
		);
	});

	it('forwards a non-open File status and omits open', async () => {
		mocks.resolveProject.mockResolvedValue(PROJECT);
		mocks.enqueueDispatch.mockResolvedValue({
			created: true,
			request: {
				id: 'dq_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				project_id: 'd_beads_web',
				operation: 'file',
				status: 'launched',
				created_at: '2026-08-16T00:00:00.000Z',
				updated_at: '2026-08-16T00:00:00.000Z'
			}
		});

		const into_progress = await post({
			operation: 'file',
			idempotency_key: 'idem-aaaaaaaa',
			notes: 'Start this.',
			status: 'in_progress'
		});
		expect(into_progress.status).toBe(201);
		expect(mocks.enqueueDispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				payload: expect.objectContaining({
					operation: 'file',
					notes: 'Start this.',
					status: 'in_progress'
				})
			})
		);

		mocks.enqueueDispatch.mockClear();
		const into_open = await post({
			operation: 'file',
			idempotency_key: 'idem-bbbbbbbb',
			notes: 'Leave this open.',
			status: 'open'
		});
		expect(into_open.status).toBe(201);
		expect(mocks.enqueueDispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				payload: {
					operation: 'file',
					notes: 'Leave this open.',
					title: undefined,
					issue_type: undefined,
					priority: undefined,
					labels: undefined
				}
			})
		);
	});

	it('tackles only after the issue exists', async () => {
		mocks.resolveProject.mockResolvedValue(PROJECT);
		mocks.getProjectIssue.mockResolvedValue(undefined);

		const response = await post({
			operation: 'tackle',
			idempotency_key: 'idem-aaaaaaaa',
			issue_id: 'beads-web-99'
		});

		expect(response.status).toBe(404);
		expect(mocks.enqueueDispatch).not.toHaveBeenCalled();
	});

	it('comments only after the issue exists', async () => {
		mocks.resolveProject.mockResolvedValue(PROJECT);
		mocks.getProjectIssue.mockResolvedValue(undefined);

		const response = await post({
			operation: 'comment',
			idempotency_key: 'idem-aaaaaaaa',
			issue_id: 'beads-web-99',
			text: 'Hello from the browser.'
		});

		expect(response.status).toBe(404);
		expect(mocks.enqueueDispatch).not.toHaveBeenCalled();
	});

	it('comments by enqueueing an agent', async () => {
		mocks.resolveProject.mockResolvedValue(PROJECT);
		mocks.getProjectIssue.mockResolvedValue({
			issue: {
				id: 'beads-web-1',
				title: 'Let humans add comments',
				status: 'open',
				priority: 2,
				issue_type: 'feature',
				labels: [],
				created_at: '2026-08-16T00:00:00.000Z',
				updated_at: '2026-08-16T00:00:00.000Z',
				dependency_count: 0,
				dependent_count: 0,
				comment_count: 0,
				dependencies: [],
				dependents: [],
				comments: []
			},
			readonly: true
		});
		mocks.enqueueDispatch.mockResolvedValue({
			created: true,
			request: {
				id: 'dq_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				project_id: 'd_beads_web',
				operation: 'comment',
				status: 'launched',
				issue_id: 'beads-web-1',
				agent_url: 'https://runner.example.com/agents/bc-2',
				created_at: '2026-08-16T00:00:00.000Z',
				updated_at: '2026-08-16T00:00:00.000Z'
			}
		});

		const response = await post({
			operation: 'comment',
			idempotency_key: 'idem-aaaaaaaa',
			issue_id: 'beads-web-1',
			text: 'Hello from the browser.'
		});

		expect(response.status).toBe(201);
		expect(mocks.enqueueDispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				project: PROJECT,
				actor: 'web',
				payload: expect.objectContaining({
					operation: 'comment',
					issue_id: 'beads-web-1',
					text: 'Hello from the browser.',
					author: 'web'
				})
			})
		);
	});

	it('sets the comment author from the Access session, not the body', async () => {
		mocks.resolveProject.mockResolvedValue(PROJECT);
		mocks.getProjectIssue.mockResolvedValue({
			issue: {
				id: 'beads-web-1',
				title: 'Let humans add comments',
				status: 'open',
				priority: 2,
				issue_type: 'feature',
				labels: [],
				created_at: '2026-08-16T00:00:00.000Z',
				updated_at: '2026-08-16T00:00:00.000Z',
				dependency_count: 0,
				dependent_count: 0,
				comment_count: 0,
				dependencies: [],
				dependents: [],
				comments: []
			},
			readonly: true
		});
		mocks.enqueueDispatch.mockResolvedValue({
			created: true,
			request: {
				id: 'dq_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				project_id: 'd_beads_web',
				operation: 'comment',
				status: 'launched',
				issue_id: 'beads-web-1',
				created_at: '2026-08-16T00:00:00.000Z',
				updated_at: '2026-08-16T00:00:00.000Z'
			}
		});

		const response = await POST({
			params: { id: 'd_beads_web' },
			locals: {
				session_id: 'sess',
				cloudflare_access: {
					kind: 'human',
					subject: 'eric@example.com',
					email: 'eric@example.com'
				}
			},
			request: new Request('http://localhost/api/projects/d_beads_web/dispatch', {
				method: 'POST',
				body: JSON.stringify({
					operation: 'comment',
					idempotency_key: 'idem-aaaaaaaa',
					issue_id: 'beads-web-1',
					text: 'From a signed-in operator.'
				})
			})
		} as unknown as Parameters<typeof POST>[0]);

		expect(response.status).toBe(201);
		expect(mocks.enqueueDispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				actor: 'eric@example.com',
				payload: expect.objectContaining({
					operation: 'comment',
					author: 'eric@example.com'
				})
			})
		);
	});

	it('passes a board destination through on Tackle', async () => {
		mocks.resolveProject.mockResolvedValue(PROJECT);
		mocks.getProjectIssue.mockResolvedValue({ issue: { id: 'beads-web-1', title: 'T' } });
		mocks.enqueueDispatch.mockResolvedValue({
			created: true,
			request: {
				id: 'dq_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
				project_id: 'd_beads_web',
				operation: 'tackle',
				status: 'launched',
				issue_id: 'beads-web-1',
				created_at: '2026-08-16T00:00:00.000Z',
				updated_at: '2026-08-16T00:00:00.000Z'
			}
		});

		const response = await post({
			operation: 'tackle',
			idempotency_key: 'idem-aaaaaaaa',
			issue_id: 'beads-web-1',
			destination_status: 'closed'
		});

		expect(response.status).toBe(201);
		expect(mocks.enqueueDispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				payload: {
					operation: 'tackle',
					issue_id: 'beads-web-1',
					destination_status: 'closed'
				}
			})
		);
	});

	it('rejects pinned as a board destination', async () => {
		const response = await post({
			operation: 'tackle',
			idempotency_key: 'idem-aaaaaaaa',
			issue_id: 'beads-web-1',
			destination_status: 'pinned'
		});

		expect(response.status).toBe(400);
		expect(mocks.enqueueDispatch).not.toHaveBeenCalled();
	});

	it('enqueues a discussion with the issue for context', async () => {
		mocks.resolveProject.mockResolvedValue(PROJECT);
		mocks.getProjectIssue.mockResolvedValue({
			issue: { id: 'beads-web-1', title: 'Map repos', description: 'Use the map.' }
		});
		mocks.enqueueDispatch.mockResolvedValue({
			created: true,
			request: {
				id: 'dq_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				project_id: 'd_beads_web',
				operation: 'discuss',
				intent: 'elaborate',
				status: 'launched',
				created_at: '2026-10-17T00:00:00.000Z',
				updated_at: '2026-10-17T00:00:00.000Z'
			}
		});

		const response = await post({
			operation: 'discuss',
			idempotency_key: 'idem-aaaaaaaa',
			issue_id: 'beads-web-1',
			intent: 'elaborate',
			message: 'Add the console steps.'
		});

		expect(response.status).toBe(201);
		expect(mocks.enqueueDispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				actor: 'web',
				payload: {
					operation: 'discuss',
					issue_id: 'beads-web-1',
					intent: 'elaborate',
					message: 'Add the console steps.'
				},
				issue: expect.objectContaining({ id: 'beads-web-1' })
			})
		);
	});

	it('refuses a discussion about an issue that does not exist', async () => {
		mocks.resolveProject.mockResolvedValue(PROJECT);
		mocks.getProjectIssue.mockResolvedValue(undefined);
		const response = await post({
			operation: 'discuss',
			idempotency_key: 'idem-aaaaaaaa',
			issue_id: 'beads-web-404',
			intent: 'discuss'
		});
		expect(response.status).toBe(404);
		expect(mocks.enqueueDispatch).not.toHaveBeenCalled();
	});
});
