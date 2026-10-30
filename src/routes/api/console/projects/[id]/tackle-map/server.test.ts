import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '$lib/types.js';
import type { TackleMapStore } from '$lib/server/dispatch/tackle-maps.js';
import { ENV_LOCKED_TACKLE_MAP_MESSAGE } from '$lib/server/dispatch/tackle-maps.js';
import { setTackleMapStore } from '$lib/server/state/db.js';
import { DELETE, PUT } from './+server.js';

const mocks = vi.hoisted(() => ({
	resolveProject: vi.fn<(id: string) => Promise<Project | undefined>>(),
	loadTackleRepositoriesFromEnv: vi.fn()
}));

vi.mock('$lib/server/discovery.js', () => ({
	resolveProject: mocks.resolveProject
}));

vi.mock('$lib/server/dispatch/repositories.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/dispatch/repositories.js')>();
	return {
		...actual,
		loadTackleRepositoriesFromEnv: mocks.loadTackleRepositoriesFromEnv
	};
});

const PROJECT: Project = {
	id: 'd_beads_web',
	name: 'beads_web',
	state: 'remote',
	dolt_database: 'beads_web',
	backend: 'server-sql',
	readonly: true
};

const VALID_BODY = {
	url: 'https://github.com/example-org/beads-web',
	ref: 'main',
	auto_create_pr: true
};

let maps: Map<string, { url: string; ref: string; auto_create_pr: boolean }>;

function fakeStore(): TackleMapStore {
	return {
		async list() {
			return Object.fromEntries(maps);
		},
		async get(project_id) {
			return maps.get(project_id);
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
		request: new Request(`http://localhost/api/console/projects/${id}/tackle-map`, {
			method: 'PUT',
			body: JSON.stringify(body)
		})
	} as unknown as Parameters<typeof PUT>[0];
}

function deleteRequest(id: string): Parameters<typeof DELETE>[0] {
	return {
		params: { id },
		request: new Request(`http://localhost/api/console/projects/${id}/tackle-map`, {
			method: 'DELETE'
		})
	} as unknown as Parameters<typeof DELETE>[0];
}

beforeEach(() => {
	maps = new Map();
	setTackleMapStore(fakeStore());
	mocks.resolveProject.mockReset();
	mocks.loadTackleRepositoriesFromEnv.mockReset();
	mocks.loadTackleRepositoriesFromEnv.mockReturnValue({ mappings: {} });
});

afterEach(() => {
	setTackleMapStore(undefined);
});

describe('PUT /api/console/projects/:id/tackle-map', () => {
	it('stores a validated map and returns the sqlite-sourced row', async () => {
		mocks.resolveProject.mockResolvedValue(PROJECT);

		const response = await PUT(putRequest('d_beads_web', VALID_BODY));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			project_id: 'd_beads_web',
			tackle: {
				mapped: true,
				url: 'https://github.com/example-org/beads-web',
				ref: 'main',
				auto_create_pr: true,
				source: 'sqlite'
			}
		});
		expect(maps.get('d_beads_web')).toEqual(VALID_BODY);
	});

	it('rejects extra keys and invalid URLs without writing', async () => {
		mocks.resolveProject.mockResolvedValue(PROJECT);

		const extra = await PUT(putRequest('d_beads_web', { ...VALID_BODY, token: 'x' }));
		const bad_url = await PUT(putRequest('d_beads_web', { url: 'https://evil.example/repo' }));

		expect(extra.status).toBe(400);
		expect(bad_url.status).toBe(400);
		expect(maps.size).toBe(0);
	});

	it('refuses to overwrite an env/file map', async () => {
		mocks.resolveProject.mockResolvedValue(PROJECT);
		mocks.loadTackleRepositoriesFromEnv.mockReturnValue({
			mappings: { d_beads_web: VALID_BODY }
		});

		const response = await PUT(putRequest('d_beads_web', VALID_BODY));

		expect(response.status).toBe(409);
		expect(((await response.json()) as { error: { message: string } }).error.message).toBe(
			ENV_LOCKED_TACKLE_MAP_MESSAGE
		);
		expect(maps.size).toBe(0);
	});
});

describe('DELETE /api/console/projects/:id/tackle-map', () => {
	it('clears the sqlite map', async () => {
		mocks.resolveProject.mockResolvedValue(PROJECT);
		maps.set('d_beads_web', VALID_BODY);

		const response = await DELETE(deleteRequest('d_beads_web'));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			project_id: 'd_beads_web',
			tackle: { mapped: false }
		});
		expect(maps.size).toBe(0);
	});
});
