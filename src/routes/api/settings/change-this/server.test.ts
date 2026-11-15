import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requiredPermission, roleCan } from '#lib/server/auth/roles.js';
import { setStateStore, type StateStore } from '#lib/server/state/db.js';
import type { Project } from '#lib/types.js';
import { GET, PUT } from './+server.js';

const mocks = vi.hoisted(() => ({
	resolveProject: vi.fn<(id: string) => Promise<Project | undefined>>()
}));

vi.mock('#lib/server/discovery.js', () => ({ resolveProject: mocks.resolveProject }));

let settings: Map<string, string>;

function fakeStore(): StateStore {
	return {
		getSetting: async (key: string) => settings.get(key),
		setSetting: async (key: string, value: string) => {
			settings.set(key, value);
		}
	};
}

async function put(body: unknown): Promise<Response> {
	const request = new Request('http://localhost/api/settings/change-this', {
		method: 'PUT',
		body: JSON.stringify(body)
	});
	return PUT({ request } as unknown as Parameters<typeof PUT>[0]) as Promise<Response>;
}

async function get(): Promise<{ project_id: string | null }> {
	const response = await (GET({} as Parameters<typeof GET>[0]) as Promise<Response>);
	return (await response.json()) as { project_id: string | null };
}

beforeEach(() => {
	settings = new Map();
	setStateStore(fakeStore());
	mocks.resolveProject.mockReset();
	mocks.resolveProject.mockImplementation(async (id) =>
		id === 'd_beadsmith' ? ({ id } as Project) : undefined
	);
});

afterEach(() => {
	setStateStore(undefined);
});

describe('/api/settings/change-this', () => {
	it('lets only an admin change it; anyone signed in may read it', () => {
		const permission = requiredPermission('PUT', '/api/settings/change-this');
		expect(permission).toEqual({ console: ['manage'] });
		expect(roleCan('member', permission!)).toBe(false);
		expect(roleCan('admin', permission!)).toBe(true);
		expect(requiredPermission('GET', '/api/settings/change-this')).toBeUndefined();
	});

	it('the launch it feeds is a dispatch, refused to a member', () => {
		const permission = requiredPermission('POST', '/api/projects/d_beadsmith/dispatch');
		expect(permission).toEqual({ dispatch: ['launch'] });
		expect(roleCan('member', permission!)).toBe(false);
		expect(roleCan('admin', permission!)).toBe(true);
	});

	it('is unset until chosen, then remembers and forgets the project', async () => {
		expect(await get()).toEqual({ project_id: null });
		expect((await put({ project_id: 'd_beadsmith' })).status).toBe(200);
		expect(await get()).toEqual({ project_id: 'd_beadsmith' });
		expect((await put({ project_id: null })).status).toBe(200);
		expect(await get()).toEqual({ project_id: null });
	});

	it('refuses an unknown project, a malformed id and extra keys without writing', async () => {
		expect((await put({ project_id: 'd_nope' })).status).toBe(404);
		expect((await put({ project_id: '../etc' })).status).toBe(400);
		expect((await put({ project_id: 'd_beadsmith', repository: 'x' })).status).toBe(400);
		expect(settings.size).toBe(0);
	});
});
