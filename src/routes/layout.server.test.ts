import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, StatusSnapshot } from '$lib/types.js';
import type { StatusDeps } from '$lib/server/status.js';

const mocks = vi.hoisted(() => ({
	discoverProjects: vi.fn<() => Promise<Project[]>>(),
	getStatus: vi.fn<(deps: StatusDeps) => Promise<StatusSnapshot>>(),
	getDispatchPolicyStore: vi.fn()
}));

vi.mock('$lib/server/discovery.js', () => ({
	discoverProjects: mocks.discoverProjects
}));

vi.mock('$lib/server/status.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/status.js')>();
	return { ...actual, getStatus: mocks.getStatus };
});

vi.mock('$lib/server/state/db.js', () => ({
	getDispatchPolicyStore: mocks.getDispatchPolicyStore
}));

import { load } from './+layout.server.js';

const projects: Project[] = [
	{
		id: 'd_project_one',
		name: 'Project one',
		state: 'remote',
		dolt_database: 'project_one',
		backend: 'server-sql',
		readonly: true
	}
];

const status: StatusSnapshot = {
	mode: 'remote',
	dolt: { configured: true, reachable: true },
	state_db: { ok: true },
	agents: { active: false, count: 0 },
	dispatch: { enabled: false, key_configured: false, armed: true }
};

/** What an admin's shell receives: the snapshot masked by `statusForViewer`. */
const admin_status: StatusSnapshot = {
	...status,
	dispatch: { ...status.dispatch, viewer_can_launch: true }
};

const projects_with_allow: Project[] = projects.map((project) => {
	return { ...project, allow: { file: true, tackle: true } };
});

async function runLoad(locals: App.Locals = { session_id: 's', role: 'admin' }) {
	return load({ locals } as unknown as Parameters<typeof load>[0]);
}

beforeEach(() => {
	mocks.discoverProjects.mockReset();
	mocks.getStatus.mockReset();
	mocks.getDispatchPolicyStore.mockReset();
	mocks.getDispatchPolicyStore.mockResolvedValue({
		listAllows: async () => {
			return {};
		}
	});
});

describe('layout server load', () => {
	it('starts status concurrently and shares the single discovery result', async () => {
		let status_projects: Project[] | undefined;
		let resolve_projects!: (value: Project[]) => void;
		const discovery = new Promise<Project[]>((resolve) => {
			resolve_projects = resolve;
		});
		mocks.discoverProjects.mockReturnValue(discovery);
		mocks.getStatus.mockImplementation(async (deps) => {
			status_projects = await deps.projects?.();
			return status;
		});

		const result_promise = runLoad();

		expect(mocks.discoverProjects).toHaveBeenCalledOnce();
		expect(mocks.getStatus).toHaveBeenCalledOnce();
		resolve_projects(projects);

		const result = await result_promise;

		expect(status_projects).toBe(projects);
		expect(result).toEqual({
			projects: projects_with_allow,
			projects_error: null,
			status: admin_status,
			viewer: { role: 'admin' }
		});
	});

	it('reveals no project or status to a signed-out visitor', async () => {
		const result = await runLoad({ session_id: '' });

		expect(mocks.discoverProjects).not.toHaveBeenCalled();
		expect(mocks.getStatus).not.toHaveBeenCalled();
		expect(result).toEqual({ projects: [], projects_error: null, status: null, viewer: null });
	});

	it('describes a signed-in account to the shell', async () => {
		mocks.discoverProjects.mockResolvedValue(projects);
		mocks.getStatus.mockResolvedValue(status);

		const result = await runLoad({
			session_id: 's',
			role: 'member',
			user: { id: 'u1', email: 'member@example.com', name: 'Member', role: 'member' }
		});

		expect(result?.viewer).toEqual({
			role: 'member',
			email: 'member@example.com',
			name: 'Member'
		});
	});

	it('keeps discovery failure non-fatal and scrubs secrets from its error', async () => {
		mocks.discoverProjects.mockRejectedValue(
			new Error('discovery unavailable\npassword=hunter2\nretry later')
		);
		mocks.getStatus.mockImplementation(async (deps) => {
			try {
				await deps.projects?.();
			} catch {
				/* getStatus keeps project discovery failure non-fatal */
			}
			return status;
		});

		const result = await runLoad();

		expect(result).toMatchObject({
			projects: [],
			projects_error: 'discovery unavailable\nretry later',
			status: admin_status
		});
		if (result === undefined) {
			throw new Error('layout returned no data');
		}
		expect(result.projects_error).not.toContain('hunter2');
	});

	it('masks dispatch for a member so the first render shows no agent controls', async () => {
		mocks.discoverProjects.mockResolvedValue(projects);
		mocks.getStatus.mockResolvedValue({
			...status,
			dispatch: { enabled: true, key_configured: true, armed: true }
		});

		const result = await runLoad({ session_id: 's', role: 'member' } as App.Locals);

		expect(result?.status?.dispatch).toMatchObject({
			enabled: false,
			key_configured: true,
			viewer_can_launch: false
		});
	});

	it('keeps status failure non-fatal without discarding projects', async () => {
		mocks.discoverProjects.mockResolvedValue(projects);
		mocks.getStatus.mockRejectedValue(new Error('status unavailable'));

		const result = await runLoad();

		expect(result).toMatchObject({
			projects: projects_with_allow,
			projects_error: null,
			status: null
		});
	});
});
