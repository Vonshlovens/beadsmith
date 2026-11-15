import { createClient } from '@libsql/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initStateSchema } from '../state/db.js';
import { createGrownStore, type GrownStore } from '../grown/store.js';
import { runView, view_spec_schema } from '../grown/view-spec.js';
import type { DoltClient } from '../dolt/client.js';
import type { IssueSummary, Project } from '#lib/types.js';
import { CREW_TOOLS, createCrewMcpHandler, type JsonRpcResponse } from './mcp.js';
import type { CrewContext, CrewDeps } from './registry.js';

const ADMIN: CrewContext = {
	account_id: 'u_admin',
	actor: 'admin@example.test',
	role: 'admin',
	chat_id: 'mc_one',
	scope: 'd_alpha'
};
const OTHER_ADMIN: CrewContext = { ...ADMIN, account_id: 'u_other', chat_id: 'mc_other' };
const MEMBER: CrewContext = { ...ADMIN, account_id: 'u_member', role: 'member' };

const PROJECTS: Project[] = ['alpha', 'beta'].map((name) => ({
	id: `d_${name}`,
	name,
	state: 'remote',
	dolt_database: name,
	backend: 'server-sql',
	readonly: true,
	counts: { open: 1, in_progress: 0, blocked: 0, closed: 0, total: 1 }
}));

function summary(id: string, overrides: Partial<IssueSummary> = {}): IssueSummary {
	return {
		id,
		title: `Issue ${id}`,
		status: 'open',
		priority: 2,
		issue_type: 'task',
		labels: [],
		created_at: '2026-11-01T00:00:00Z',
		updated_at: '2026-11-01T00:00:00Z',
		dependency_count: 0,
		dependent_count: 0,
		comment_count: 0,
		...overrides
	};
}

const browseIssues = vi.fn<DoltClient['browseIssues']>();

/** Only what a view run touches; the rest of the client is never called. */
function fakeDolt(): DoltClient {
	return { browseIssues } as unknown as DoltClient;
}

let store: GrownStore;
let deps: CrewDeps;

beforeEach(async () => {
	browseIssues.mockReset();
	browseIssues.mockImplementation(async (database) => [
		summary(`${database}-1`, { priority: 3, updated_at: '2026-11-03T00:00:00Z' }),
		summary(`${database}-2`, { priority: 0, updated_at: '2026-11-02T00:00:00Z' })
	]);
	const client = createClient({ url: ':memory:' });
	await initStateSchema(client);
	store = createGrownStore(client);
	deps = {
		projects: async () => PROJECTS,
		read: { dolt: fakeDolt(), dolt_configured: true },
		grown: async () => store
	};
});

let next_id = 1;
async function rpc(name: string, args: Record<string, unknown>, ctx: CrewContext = ADMIN) {
	const handler = createCrewMcpHandler({ deps, log: () => {} });
	const response = (await handler.handle(ctx, {
		jsonrpc: '2.0',
		id: next_id++,
		method: 'tools/call',
		params: { name, arguments: args }
	})) as JsonRpcResponse;
	return response;
}

async function ok(name: string, args: Record<string, unknown>, ctx?: CrewContext) {
	const response = await rpc(name, args, ctx);
	if (!('result' in response)) throw new Error(JSON.stringify(response.error));
	const result = response.result as { content: { text: string }[]; isError?: boolean };
	expect(result.isError, result.content[0].text).toBeUndefined();
	return JSON.parse(result.content[0].text);
}

async function refused(name: string, args: Record<string, unknown>, ctx?: CrewContext) {
	const response = await rpc(name, args, ctx);
	if (!('result' in response)) throw new Error(JSON.stringify(response.error));
	const result = response.result as { content: { text: string }[]; isError?: boolean };
	expect(result.isError, result.content[0].text).toBe(true);
	return result.content[0].text;
}

const urgent = {
	slug: 'urgent',
	name: 'Urgent',
	filters: { priority: [0, 1] },
	sort: 'priority'
};

describe('crew view tools', () => {
	it('define_view creates a private view in the chat project, by First Mate, with its URL', async () => {
		const created = await ok('define_view', urgent);
		expect(created).toMatchObject({
			written: 'created',
			view: {
				slug: 'urgent',
				name: 'Urgent',
				revision: 1,
				author_kind: 'first_mate',
				mine: true,
				published: false,
				url: '/views/urgent',
				spec: { scope: { project: 'd_alpha' }, filters: { priority: [0, 1] }, sort: 'priority' }
			}
		});
		const [revision] = await store.history({ account_id: 'u_admin', role: 'admin' }, 'urgent');
		expect(revision).toMatchObject({
			author_kind: 'first_mate',
			author_account_id: 'u_admin',
			author_chat_id: 'mc_one'
		});
		// Owner-private (ADR-0025 rule 7): another admin and a member see nothing.
		expect(await store.read({ account_id: 'u_other', role: 'admin' }, 'urgent')).toBeUndefined();
		expect((await ok('list_views', {}, MEMBER)).views).toEqual([]);
	});

	it('resolves a project by name, takes "all", and refuses an unknown project', async () => {
		expect(
			(await ok('define_view', { ...urgent, slug: 'beta-urgent', project: 'beta' })).view.spec.scope
		).toEqual({ project: 'd_beta' });
		expect(
			(await ok('define_view', { ...urgent, slug: 'all-urgent', project: 'all' })).view.spec.scope
		).toBe('all');
		expect(await refused('define_view', { ...urgent, slug: 'x', project: 'gamma' })).toMatch(
			/No project "gamma"/
		);
	});

	it('refuses filters that are not plain values before saving', async () => {
		const response = await rpc('define_view', {
			...urgent,
			filters: { status: ["open') OR 1=1 --"] }
		});
		expect(response).toMatchObject({ error: { message: /filters\.status/ } });
		const extra = await rpc('define_view', { ...urgent, filters: { sql: 'DROP TABLE issues' } });
		expect(extra).toMatchObject({ error: { message: /filters/ } });
		expect(await store.list({ account_id: 'u_admin', role: 'admin' })).toEqual([]);
	});

	it('revises under the same slug, keeping the description, and reverts to a prior revision', async () => {
		await ok('define_view', { ...urgent, description: 'P0 and P1' });
		const revised = await ok('define_view', {
			...urgent,
			name: 'Urgent bugs',
			filters: { priority: [0, 1], type: ['bug'] }
		});
		expect(revised).toMatchObject({
			written: 'revised',
			view: { revision: 2, name: 'Urgent bugs', description: 'P0 and P1' }
		});
		const history = await ok('view_history', { slug: 'urgent' });
		expect(history.revisions.map((revision: { number: number }) => revision.number)).toEqual([
			2, 1
		]);
		const reverted = await ok('revert_view', { slug: 'urgent', number: 1 });
		expect(reverted).toMatchObject({
			reverted_to: 1,
			view: { revision: 3, name: 'Urgent', spec: { filters: { priority: [0, 1] } } }
		});
		expect(reverted.view.spec.filters.type).toBeUndefined();
		expect(await refused('revert_view', { slug: 'urgent', number: 9 })).toMatch(/no revision 9/);
	});

	it('run_view returns the rows the page shows, in the view’s order, naming each project', async () => {
		await ok('define_view', { ...urgent, project: 'all', filters: {} });
		const run = await ok('run_view', { slug: 'urgent' });
		const thing = await store.read({ account_id: 'u_admin', role: 'admin' }, 'urgent');
		const page = await runView(view_spec_schema.parse(thing?.revision.spec), {
			read: deps.read,
			projects: async () => PROJECTS
		});
		expect(run.issues.map((issue: { id: string }) => issue.id)).toEqual(
			page.issues.map((issue) => issue.id)
		);
		expect(run.issues[0]).toMatchObject({
			id: 'alpha-2',
			priority: 0,
			project_id: 'd_alpha',
			project_name: 'alpha'
		});
		expect(run.view).toEqual({ slug: 'urgent', name: 'Urgent', revision: 1, url: '/views/urgent' });
		expect(run.note).toBeUndefined();
	});

	it('runs as the viewer: a member runs only published revisions and changes nothing', async () => {
		await ok('define_view', urgent);
		expect(await refused('run_view', { slug: 'urgent' }, MEMBER)).toMatch(/no view called/);
		const admin = { account_id: 'u_admin', role: 'admin' } as const;
		await store.publish(admin, 'urgent');
		await ok('define_view', { ...urgent, name: 'Unpublished rename' });
		const listed = await ok('list_views', {}, MEMBER);
		expect(listed.views).toMatchObject([{ slug: 'urgent', name: 'Urgent', mine: false }]);
		expect((await ok('run_view', { slug: 'urgent' }, MEMBER)).view.name).toBe('Urgent');
		// Write tools are admin-only, as the /api/views writes are.
		const writes: [string, Record<string, unknown>][] = [
			['define_view', urgent],
			['revert_view', { slug: 'urgent', number: 1 }],
			['view_history', { slug: 'urgent' }]
		];
		for (const [name, args] of writes) {
			expect(await refused(name, args, MEMBER)).toMatch(/needs an admin/);
		}
	});

	it('never lets another admin revise or revert a view they do not own', async () => {
		await ok('define_view', urgent);
		await store.publish({ account_id: 'u_admin', role: 'admin' }, 'urgent');
		expect(await refused('define_view', { ...urgent, name: 'Mine now' }, OTHER_ADMIN)).toMatch(
			/Only its owner/
		);
		expect(await refused('revert_view', { slug: 'urgent', number: 1 }, OTHER_ADMIN)).toMatch(
			/Only its owner/
		);
	});

	it('has no tool that publishes or shares (ADR-0025 rule 7)', () => {
		const names = CREW_TOOLS.map((tool) => tool.name);
		expect(names).toEqual(
			expect.arrayContaining([
				'define_view',
				'list_views',
				'run_view',
				'view_history',
				'revert_view'
			])
		);
		expect(names.filter((name) => /publish|share/.test(name))).toEqual([]);
	});
});
