import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '$lib/types.js';
import type { FileMapStore } from '$lib/server/dispatch/file-maps.js';
import { setFileMapStore } from '$lib/server/state/db.js';
import { DELETE, PUT } from './+server.js';

const mocks = vi.hoisted(() => ({
	resolveProject: vi.fn<(id: string) => Promise<Project | undefined>>()
}));

vi.mock('$lib/server/discovery.js', () => ({
	resolveProject: mocks.resolveProject
}));

const PROJECT: Project = {
	id: 'd_other',
	name: 'other',
	state: 'remote',
	dolt_database: 'other',
	backend: 'server-sql',
	readonly: true
};

const VALID_BODY = {
	url: 'https://github.com/example-org/other',
	ref: 'develop'
};

let maps: Map<string, { url: string; ref: string }>;

function fakeStore(): FileMapStore {
	return {
		async list() {
			return Object.fromEntries(maps);
		},
		async inspect(project_id) {
			const mapping = maps.get(project_id);
			return mapping === undefined ? { kind: 'none' } : { kind: 'valid', mapping };
		},
		async put(project_id, mapping) {
			maps.set(project_id, mapping);
		},
		async delete(project_id) {
			return maps.delete(project_id);
		}
	};
}

function putRequest(id: string, body: unknown): Parameters<typeof PUT>[0] {
	return {
		params: { id },
		request: new Request(`http://localhost/api/console/projects/${id}/file-map`, {
			method: 'PUT',
			body: JSON.stringify(body)
		})
	} as unknown as Parameters<typeof PUT>[0];
}

function deleteRequest(id: string): Parameters<typeof DELETE>[0] {
	return {
		params: { id },
		request: new Request(`http://localhost/api/console/projects/${id}/file-map`, {
			method: 'DELETE'
		})
	} as unknown as Parameters<typeof DELETE>[0];
}

beforeEach(() => {
	maps = new Map();
	setFileMapStore(fakeStore());
	mocks.resolveProject.mockReset();
});

afterEach(() => {
	setFileMapStore(undefined);
});

describe('PUT /api/console/projects/:id/file-map', () => {
	it('stores a validated File checkout and returns the mapped row', async () => {
		mocks.resolveProject.mockResolvedValue(PROJECT);

		const response = await PUT(putRequest('d_other', VALID_BODY));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			project_id: 'd_other',
			file: {
				mapped: true,
				url: 'https://github.com/example-org/other',
				ref: 'develop'
			}
		});
		expect(maps.get('d_other')).toEqual(VALID_BODY);
	});

	it('rejects extra keys, a PR flag, and invalid URLs without writing', async () => {
		mocks.resolveProject.mockResolvedValue(PROJECT);

		const extra = await PUT(putRequest('d_other', { ...VALID_BODY, token: 'x' }));
		const pr_flag = await PUT(putRequest('d_other', { ...VALID_BODY, auto_create_pr: false }));
		const bad_url = await PUT(putRequest('d_other', { url: 'https://evil.example/repo' }));

		expect(extra.status).toBe(400);
		expect(pr_flag.status).toBe(400);
		expect(bad_url.status).toBe(400);
		expect(maps.size).toBe(0);
	});
});

describe('DELETE /api/console/projects/:id/file-map', () => {
	it('clears the sqlite File checkout', async () => {
		mocks.resolveProject.mockResolvedValue(PROJECT);
		maps.set('d_other', VALID_BODY);

		const response = await DELETE(deleteRequest('d_other'));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			project_id: 'd_other',
			file: { mapped: false }
		});
		expect(maps.size).toBe(0);
	});
});
