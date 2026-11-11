import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	AutomationDetailResponse,
	AutomationPreviewResponse,
	AutomationRunView,
	AutomationsResponse,
	AutomationView
} from '#lib/automations.js';
import { requiredPermission, roleCan } from '#lib/server/auth/roles.js';
import type { AutomationTickDeps } from '#lib/server/automations/scheduler.js';
import { createAutomationStore, type AutomationStore } from '#lib/server/automations/store.js';
import { initStateSchema, setAutomationStore } from '#lib/server/state/db.js';
import type { Project } from '#lib/types.js';
import { GET as LIST, POST as CREATE } from './+server.js';
import { DELETE, GET as GET_ONE, PATCH } from './[id]/+server.js';
import { POST as RUN } from './[id]/run/+server.js';
import { GET as PREVIEW } from './preview/+server.js';

const PROJECT = { id: 'd_beads_web', name: 'Beads web', dolt_database: 'beads_web' } as Project;

const mocks = vi.hoisted(() => ({
	deps: undefined as AutomationTickDeps | undefined
}));

vi.mock('#lib/server/discovery.js', () => ({
	resolveProject: async (id: string) => (id === 'd_beads_web' ? PROJECT : undefined)
}));
vi.mock('#lib/server/read-model.js', () => ({
	getProjectIssue: async (_project: Project, issue_id: string) =>
		issue_id === 'bw-1' ? { issue: { id: 'bw-1', title: 'Epic' } } : undefined
}));
vi.mock('#lib/server/mission-names.js', () => ({
	missionProjectNames: async () => new Map([['d_beads_web', 'Beads web']])
}));
vi.mock('#lib/server/automations/runtime.js', () => ({
	automationDeps: async () => mocks.deps
}));

const ADMIN = { id: 'acct_admin', email: 'admin@example.test', name: 'Admin', role: 'admin' };

let store: AutomationStore;

beforeEach(async () => {
	const client = createClient({ url: ':memory:' });
	await initStateSchema(client);
	store = createAutomationStore(client);
	setAutomationStore(store);
	mocks.deps = {
		store,
		dispatch: { get: async () => undefined, getByIdempotencyKey: async () => undefined },
		enqueue: async () => ({ request: { id: 'dq_launched' }, created: true }),
		resolveProject: async () => PROJECT,
		getIssue: async () => ({ id: 'bw-1' }) as never,
		creator: async () => ({ email: ADMIN.email, role: 'admin', banned: false }),
		now: () => new Date('2026-11-11T12:00:30.123Z')
	};
});

afterEach(() => setAutomationStore(undefined));

type Event<T extends (...args: never[]) => unknown> = Parameters<T>[0];

function event(
	method: string,
	path: string,
	options: { body?: unknown; params?: Record<string, string>; user?: typeof ADMIN | null } = {}
) {
	const url = new URL(`http://localhost${path}`);
	return {
		url,
		params: options.params ?? {},
		locals: options.user === null ? {} : { user: options.user ?? ADMIN },
		request: new Request(url, {
			method,
			...(options.body === undefined
				? {}
				: { body: JSON.stringify(options.body), headers: { 'content-type': 'application/json' } })
		})
	};
}

const NIGHTLY = {
	project_id: 'd_beads_web',
	name: 'Nightly build on the epic',
	cron: '0 2 * * *',
	time_zone: 'UTC',
	launch: { operation: 'loop', mode: 'build', issue_id: 'bw-1', max_iterations: 10 }
};

async function create(body: unknown = NIGHTLY, user: typeof ADMIN | null = ADMIN) {
	return CREATE(event('POST', '/api/automations', { body, user }) as Event<typeof CREATE>);
}

async function createdId(): Promise<string> {
	const response = await create();
	return ((await response.json()) as { automation: AutomationView }).automation.id;
}

describe('/api/automations', () => {
	it('needs dispatch:launch to change anything, and lets any signed-in role read', () => {
		for (const [method, path] of [
			['POST', '/api/automations'],
			['PATCH', '/api/automations/au_1'],
			['DELETE', '/api/automations/au_1'],
			['POST', '/api/automations/au_1/run']
		] as const) {
			const permission = requiredPermission(method, path);
			expect(permission, `${method} ${path}`).toEqual({ dispatch: ['launch'] });
			expect(roleCan('member', permission!)).toBe(false);
			expect(roleCan('admin', permission!)).toBe(true);
		}
		expect(requiredPermission('GET', '/api/automations')).toBeUndefined();
	});

	it('creates an automation and lists it with its next run', async () => {
		const response = await create();
		expect(response.status).toBe(201);
		const { automation } = (await response.json()) as { automation: AutomationView };
		expect(automation).toMatchObject({
			name: 'Nightly build on the epic',
			project_name: 'Beads web',
			enabled: true,
			overlap: 'skip',
			launch: { operation: 'loop', issue_id: 'bw-1', loop: { mode: 'build', max_iterations: 10 } }
		});
		expect(automation.next_run).toMatch(/T02:00:00\.000Z$/);
		expect((await store.get(automation.id))?.created_by).toBe('acct_admin');

		const listed = await LIST(event('GET', '/api/automations') as Event<typeof LIST>);
		const body = (await listed.json()) as AutomationsResponse;
		expect(body.automations.map((entry) => entry.id)).toEqual([automation.id]);

		const other = await LIST(
			event('GET', '/api/automations?project=d_other') as Event<typeof LIST>
		);
		expect(((await other.json()) as AutomationsResponse).automations).toEqual([]);
	});

	it('refuses a bad schedule, a missing bead, extra keys and a caller with no account', async () => {
		expect((await create({ ...NIGHTLY, cron: '0 0 30 2 *' })).status).toBe(400);
		expect((await create({ ...NIGHTLY, time_zone: 'Nowhere/Land' })).status).toBe(400);
		expect(
			(
				await create({
					...NIGHTLY,
					launch: { operation: 'tackle', issue_id: 'bw-404' }
				})
			).status
		).toBe(404);
		expect(
			(
				await create({
					...NIGHTLY,
					launch: { ...NIGHTLY.launch, idempotency_key: 'automation:x:y' }
				})
			).status
		).toBe(400);
		expect((await create(NIGHTLY, null)).status).toBe(403);
		expect(await store.list()).toEqual([]);
	});

	it('previews a schedule, or says why it would be refused', async () => {
		const ok = await PREVIEW(
			event('GET', '/api/automations/preview?cron=30+9+*+*+1-5&time_zone=UTC') as Event<
				typeof PREVIEW
			>
		);
		const body = (await ok.json()) as AutomationPreviewResponse;
		expect(body.upcoming).toHaveLength(5);
		expect(body.upcoming[0]).toMatch(/T09:30:00\.000Z$/);

		const bad = await PREVIEW(
			event('GET', '/api/automations/preview?cron=0+0+30+2+*&time_zone=UTC') as Event<
				typeof PREVIEW
			>
		);
		expect(bad.status).toBe(400);
	});
});

describe('/api/automations/:id', () => {
	it('pauses and resumes, with no next run while paused', async () => {
		const id = await createdId();
		const paused = await PATCH(
			event('PATCH', `/api/automations/${id}`, {
				params: { id },
				body: { enabled: false }
			}) as Event<typeof PATCH>
		);
		const view = ((await paused.json()) as { automation: AutomationView }).automation;
		expect(view.enabled).toBe(false);
		expect(view.next_run).toBeUndefined();

		const detail = await GET_ONE(
			event('GET', `/api/automations/${id}`, { params: { id } }) as Event<typeof GET_ONE>
		);
		expect(((await detail.json()) as AutomationDetailResponse).upcoming).toEqual([]);

		const resumed = await PATCH(
			event('PATCH', `/api/automations/${id}`, {
				params: { id },
				body: { enabled: true }
			}) as Event<typeof PATCH>
		);
		expect(((await resumed.json()) as { automation: AutomationView }).automation.enabled).toBe(
			true
		);
	});

	it('edits the schedule and loop settings and keeps the history', async () => {
		const id = await createdId();
		await RUN(event('POST', `/api/automations/${id}/run`, { params: { id } }) as Event<typeof RUN>);
		const edit = {
			name: 'Weekday build',
			cron: '30 9 * * 1-5',
			time_zone: 'Europe/London',
			overlap: 'queue',
			loop: { max_iterations: 4, harness: 'codex' }
		};
		const response = await PATCH(
			event('PATCH', `/api/automations/${id}`, { params: { id }, body: edit }) as Event<
				typeof PATCH
			>
		);
		expect(response.status).toBe(200);
		const view = ((await response.json()) as { automation: AutomationView }).automation;
		expect(view).toMatchObject({
			name: 'Weekday build',
			cron: '30 9 * * 1-5',
			time_zone: 'Europe/London',
			overlap: 'queue',
			launch: {
				operation: 'loop',
				issue_id: 'bw-1',
				loop: { mode: 'build', max_iterations: 4, harness: 'codex' }
			}
		});
		const detail = (await (
			await GET_ONE(
				event('GET', `/api/automations/${id}`, { params: { id } }) as Event<typeof GET_ONE>
			)
		).json()) as AutomationDetailResponse;
		expect(detail.runs).toHaveLength(1);

		// No harness means ralph's default again.
		await PATCH(
			event('PATCH', `/api/automations/${id}`, {
				params: { id },
				body: { ...edit, loop: { max_iterations: 4 } }
			}) as Event<typeof PATCH>
		);
		expect((await store.get(id))?.payload).toEqual({
			operation: 'loop',
			mode: 'build',
			issue_id: 'bw-1',
			max_iterations: 4
		});
	});

	it('refuses an edit with a bad schedule, extra keys, or loop settings on a non-loop', async () => {
		const id = await createdId();
		const patch = (body: unknown, target = id) =>
			PATCH(
				event('PATCH', `/api/automations/${target}`, { params: { id: target }, body }) as Event<
					typeof PATCH
				>
			);
		const edit = { name: 'x', cron: '0 2 * * *', time_zone: 'UTC', overlap: 'skip' };
		expect((await patch({ ...edit, cron: '0 0 30 2 *' })).status).toBe(400);
		expect((await patch({ ...edit, time_zone: 'Nowhere/Land' })).status).toBe(400);
		expect((await patch({ ...edit, project_id: 'd_other' })).status).toBe(400);
		expect((await patch({ ...edit, enabled: false })).status).toBe(400);
		expect((await patch({ ...edit, loop: { max_iterations: 0 } })).status).toBe(400);
		expect((await store.get(id))?.name).toBe('Nightly build on the epic');

		const tackle = await create({
			...NIGHTLY,
			launch: { operation: 'tackle', issue_id: 'bw-1' }
		});
		const tackle_id = ((await tackle.json()) as { automation: AutomationView }).automation.id;
		expect((await patch({ ...edit, loop: { max_iterations: 3 } }, tackle_id)).status).toBe(400);
		expect((await patch(edit, tackle_id)).status).toBe(200);

		const missing = 'au_' + '0'.repeat(32);
		expect((await patch(edit, missing)).status).toBe(404);
	});

	it('runs now, records the run with its mission, and shows it in the history', async () => {
		const id = await createdId();
		const response = await RUN(
			event('POST', `/api/automations/${id}/run`, { params: { id } }) as Event<typeof RUN>
		);
		expect(response.status).toBe(201);
		const { run } = (await response.json()) as { run: AutomationRunView };
		expect(run).toMatchObject({ trigger: 'manual', outcome: 'fired', mission_id: 'dq_launched' });

		const again = await RUN(
			event('POST', `/api/automations/${id}/run`, { params: { id } }) as Event<typeof RUN>
		);
		expect(again.status).toBe(409);

		const detail = (await (
			await GET_ONE(
				event('GET', `/api/automations/${id}`, { params: { id } }) as Event<typeof GET_ONE>
			)
		).json()) as AutomationDetailResponse;
		expect(detail.runs).toEqual([run]);
		expect(detail.automation.last_run).toEqual(run);
		expect(detail.upcoming).toHaveLength(5);
	});

	it('deletes an automation, and answers 404 for one that does not exist', async () => {
		const id = await createdId();
		const removed = await DELETE(
			event('DELETE', `/api/automations/${id}`, { params: { id } }) as Event<typeof DELETE>
		);
		expect(removed.status).toBe(204);
		const missing = await GET_ONE(
			event('GET', `/api/automations/${id}`, { params: { id } }) as Event<typeof GET_ONE>
		);
		expect(missing.status).toBe(404);
		const bad = await GET_ONE(
			event('GET', '/api/automations/nope', { params: { id: 'nope' } }) as Event<typeof GET_ONE>
		);
		expect(bad.status).toBe(400);
	});
});
