import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '$lib/types.js';
import type { DispatchPolicyStore } from '$lib/server/dispatch/policy.js';
import { setDispatchPolicyStore } from '$lib/server/state/db.js';
import { PUT } from './+server.js';

const mocks = vi.hoisted(() => ({
	resolveProject: vi.fn<(id: string) => Promise<Project | undefined>>()
}));

vi.mock('$lib/server/discovery.js', () => ({
	resolveProject: mocks.resolveProject
}));

const PROJECT: Project = {
	id: 'd_beads_web',
	name: 'beads_web',
	state: 'remote',
	dolt_database: 'beads_web',
	backend: 'server-sql',
	readonly: true
};

let allows: Map<string, { file: boolean; tackle: boolean }>;

function fakeStore(): DispatchPolicyStore {
	return {
		async getArmed() {
			return true;
		},
		async setArmed() {
			return;
		},
		async getAllow(project_id) {
			return allows.get(project_id) ?? { file: true, tackle: true };
		},
		async listAllows() {
			return Object.fromEntries(allows);
		},
		async putAllow(project_id, allow) {
			allows.set(project_id, allow);
		}
	};
}

function putRequest(id: string, body: unknown): Parameters<typeof PUT>[0] {
	return {
		params: { id },
		request: new Request(`http://localhost/api/console/projects/${id}/allow`, {
			method: 'PUT',
			body: JSON.stringify(body)
		})
	} as unknown as Parameters<typeof PUT>[0];
}

beforeEach(() => {
	allows = new Map();
	setDispatchPolicyStore(fakeStore());
	mocks.resolveProject.mockReset();
	mocks.resolveProject.mockResolvedValue(PROJECT);
});

afterEach(() => {
	setDispatchPolicyStore(undefined);
});

describe('PUT /api/console/projects/:id/allow', () => {
	it('persists File vs Tackle allow for a discovered project', async () => {
		const response = await PUT(putRequest('d_beads_web', { file: true, tackle: false }));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			project_id: 'd_beads_web',
			allow: { file: true, tackle: false }
		});
		expect(allows.get('d_beads_web')).toEqual({ file: true, tackle: false });
	});

	it('rejects extra keys and unknown projects without writing', async () => {
		const extra = await PUT(putRequest('d_beads_web', { file: false, tackle: false, secret: 'x' }));
		expect(extra.status).toBe(400);
		expect(allows.size).toBe(0);

		mocks.resolveProject.mockResolvedValue(undefined);
		const missing = await PUT(putRequest('d_missing_proj', { file: false, tackle: false }));
		expect(missing.status).toBe(404);
	});
});
