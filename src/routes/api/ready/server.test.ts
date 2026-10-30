import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, ReadyListResponse } from '$lib/types.js';
import { GET } from './+server.js';

const mocks = vi.hoisted(() => ({
	discoverProjects: vi.fn<() => Promise<Project[]>>(),
	getMergedReadyIssues: vi.fn<(projects: Project[], limit: number) => Promise<ReadyListResponse>>()
}));

vi.mock('$lib/server/discovery.js', () => ({
	discoverProjects: mocks.discoverProjects
}));

vi.mock('$lib/server/read-model.js', () => ({
	getMergedReadyIssues: mocks.getMergedReadyIssues
}));

const PROJECTS: Project[] = [
	{
		id: 'd_beads_web',
		name: 'beads_web',
		state: 'remote',
		dolt_database: 'beads_web',
		backend: 'server-sql',
		readonly: true
	}
];

const READY: ReadyListResponse = {
	issues: [
		{
			id: 'beads-web-s42.4',
			title: 'Cross-project Ready deck',
			status: 'open',
			priority: 2,
			issue_type: 'feature',
			labels: [],
			created_at: '2026-08-19T09:01:06Z',
			updated_at: '2026-08-25T02:40:04Z',
			dependency_count: 0,
			dependent_count: 0,
			comment_count: 0,
			project_id: 'd_beads_web',
			project_name: 'beads_web'
		}
	],
	source: 'sql',
	readonly: true
};

beforeEach(() => {
	mocks.discoverProjects.mockReset();
	mocks.getMergedReadyIssues.mockReset();
});

describe('GET /api/ready', () => {
	it('returns the merged Ready deck for discovered catalog projects', async () => {
		mocks.discoverProjects.mockResolvedValue(PROJECTS);
		mocks.getMergedReadyIssues.mockResolvedValue(READY);

		const response = await GET({
			locals: {},
			url: new URL('http://localhost/api/ready?limit=25'),
			request: new Request('http://localhost/api/ready?limit=25')
		} as unknown as Parameters<typeof GET>[0]);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(READY);
		expect(mocks.getMergedReadyIssues).toHaveBeenCalledWith(PROJECTS, 25);
	});

	it('rejects an oversize limit', async () => {
		const response = await GET({
			locals: {},
			url: new URL('http://localhost/api/ready?limit=100000'),
			request: new Request('http://localhost/api/ready?limit=100000')
		} as unknown as Parameters<typeof GET>[0]);

		expect(response.status).toBe(400);
		expect(mocks.discoverProjects).not.toHaveBeenCalled();
	});
});
