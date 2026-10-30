import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '$lib/types.js';
import { GET } from './+server.js';

const mocks = vi.hoisted(() => ({
	resolveProject: vi.fn<(id: string) => Promise<Project | undefined>>(),
	dispatchExists: vi.fn(),
	streamDispatchMissionEvents: vi.fn()
}));

vi.mock('$lib/server/discovery.js', () => ({
	resolveProject: mocks.resolveProject
}));

vi.mock('$lib/server/dispatch/service.js', () => ({
	dispatchExists: mocks.dispatchExists,
	streamDispatchMissionEvents: mocks.streamDispatchMissionEvents
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

async function get(request_id = REQUEST_ID, headers: HeadersInit = {}): Promise<Response> {
	return GET({
		params: { id: 'd_beads_web', requestId: request_id },
		request: new Request(
			`http://localhost/api/projects/d_beads_web/dispatch/${request_id}/stream`,
			{ headers }
		)
	} as unknown as Parameters<typeof GET>[0]);
}

beforeEach(() => {
	mocks.resolveProject.mockReset();
	mocks.dispatchExists.mockReset();
	mocks.streamDispatchMissionEvents.mockReset();
	mocks.resolveProject.mockResolvedValue(PROJECT);
	mocks.dispatchExists.mockResolvedValue(true);
});

describe('GET /api/projects/:id/dispatch/:requestId/stream', () => {
	it('returns 404 when the dispatch row is missing', async () => {
		mocks.dispatchExists.mockResolvedValue(false);
		const response = await get();
		expect(response.status).toBe(404);
		expect(mocks.streamDispatchMissionEvents).not.toHaveBeenCalled();
	});

	it('streams canonical mission events and a done frame', async () => {
		mocks.streamDispatchMissionEvents.mockImplementation(
			async (
				_project: string,
				_id: string,
				on_event: (event: { type: string; id: string; text?: string }) => Promise<void>
			) => {
				await on_event({ type: 'assistant', id: 'a1', text: 'Hello' });
				return 'terminal';
			}
		);

		const response = await get();
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/event-stream');
		const body = await response.text();
		expect(body).toContain('event: assistant');
		expect(body).toContain('"type":"assistant"');
		expect(body).toContain('Hello');
		expect(body).toContain('event: done');
		expect(body).not.toContain('runner-secret');
		expect(mocks.streamDispatchMissionEvents).toHaveBeenCalledWith(
			'd_beads_web',
			REQUEST_ID,
			expect.any(Function),
			expect.objectContaining({ last_event_id: undefined })
		);
	});

	it('forwards Last-Event-ID for resume', async () => {
		mocks.streamDispatchMissionEvents.mockResolvedValue('disconnected');
		await get(REQUEST_ID, { 'Last-Event-ID': '1713033006000-3' });
		expect(mocks.streamDispatchMissionEvents).toHaveBeenCalledWith(
			'd_beads_web',
			REQUEST_ID,
			expect.any(Function),
			expect.objectContaining({ last_event_id: '1713033006000-3' })
		);
	});

	it('emits an error event instead of aborting the SSE body when streaming throws', async () => {
		mocks.streamDispatchMissionEvents.mockRejectedValue(new Error('no key'));
		const response = await get();
		expect(response.status).toBe(200);
		const body = await response.text();
		expect(body).toContain('event: error');
		expect(body).toContain('temporarily unavailable');
		expect(body).toContain('event: done');
	});
});
