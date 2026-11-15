import { createClient } from '@libsql/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { initStateSchema } from '../state/db.js';
import { createGrownStore, type GrownStore } from '../grown/store.js';
import { SURFACE_COMPONENTS } from '../grown/surface-spec.js';
import { CREW_TOOLS, createCrewMcpHandler, toolInputSchema, type JsonRpcResponse } from './mcp.js';
import type { CrewContext, CrewDeps } from './registry.js';
import { surfaceCatalogGuide } from './surface-tools.js';

const ADMIN: CrewContext = {
	account_id: 'u_admin',
	actor: 'admin@example.test',
	role: 'admin',
	chat_id: 'mc_one',
	scope: 'd_alpha'
};
const OTHER_ADMIN: CrewContext = { ...ADMIN, account_id: 'u_other', chat_id: 'mc_other' };
const MEMBER: CrewContext = { ...ADMIN, account_id: 'u_member', role: 'member' };
const OWNER_VIEWER = { account_id: 'u_admin', role: 'admin' } as const;

let store: GrownStore;
let deps: CrewDeps;

beforeEach(async () => {
	const client = createClient({ url: ':memory:' });
	await initStateSchema(client);
	store = createGrownStore(client);
	// Defining a surface never reads issues: bindings run when it is opened.
	deps = { grown: async () => store };
});

let next_id = 1;
async function rpc(name: string, args: Record<string, unknown>, ctx: CrewContext = ADMIN) {
	const handler = createCrewMcpHandler({ deps, log: () => {} });
	return (await handler.handle(ctx, {
		jsonrpc: '2.0',
		id: next_id++,
		method: 'tools/call',
		params: { name, arguments: args }
	})) as JsonRpcResponse;
}

async function result(name: string, args: Record<string, unknown>, ctx?: CrewContext) {
	const response = await rpc(name, args, ctx);
	if (!('result' in response)) throw new Error(JSON.stringify(response.error));
	return response.result as { content: { text: string }[]; isError?: boolean };
}

async function ok(name: string, args: Record<string, unknown>, ctx?: CrewContext) {
	const outcome = await result(name, args, ctx);
	expect(outcome.isError, outcome.content[0].text).toBeUndefined();
	return JSON.parse(outcome.content[0].text);
}

async function refused(name: string, args: Record<string, unknown>, ctx?: CrewContext) {
	const outcome = await result(name, args, ctx);
	expect(outcome.isError, outcome.content[0].text).toBe(true);
	return outcome.content[0].text;
}

/** A dashboard: a heading, a count and a list of ready work, and a todo button. */
function dashboard(title = 'Ready work') {
	return {
		root: 'main',
		components: [
			{ id: 'main', component: 'Stack', children: ['title', 'ready_count', 'ready_list', 'nudge'] },
			{ id: 'title', component: 'Heading', text: title },
			{ id: 'ready_count', component: 'StatTile', label: 'Ready', count: 'ready' },
			{ id: 'ready_list', component: 'IssueList', data: 'ready', limit: 10 },
			{ id: 'nudge', component: 'Button', label: 'Remind me', action: 'remind' }
		],
		data: { ready: { tool: 'ready_work', input: { limit: 50 } } },
		actions: { remind: { tool: 'create_todo', input: { title: 'Look at ready work' } } }
	};
}

const READY = { slug: 'ready-dash', name: 'Ready dashboard', spec: dashboard() };

describe('crew surface tools', () => {
	it('define_surface creates a private surface, by First Mate, with its URL', async () => {
		const created = await ok('define_surface', READY);
		expect(created).toMatchObject({
			written: 'created',
			surface: {
				slug: 'ready-dash',
				name: 'Ready dashboard',
				revision: 1,
				author_kind: 'first_mate',
				mine: true,
				published: false,
				url: '/views/ready-dash'
			}
		});
		// The store's canonical spec, defaults filled in.
		expect(created.surface.spec.components[0]).toMatchObject({ gap: 'md' });
		const [revision] = await store.history(OWNER_VIEWER, 'ready-dash');
		expect(revision).toMatchObject({
			author_kind: 'first_mate',
			author_account_id: 'u_admin',
			author_chat_id: 'mc_one'
		});
		// Owner-private (ADR-0025 rule 7).
		expect(
			await store.read({ account_id: 'u_other', role: 'admin' }, 'ready-dash')
		).toBeUndefined();
		expect((await ok('list_surfaces', {}, MEMBER)).surfaces).toEqual([]);
	});

	it('returns the store’s message for an invalid tree and saves nothing', async () => {
		const unknown_component = {
			...dashboard(),
			components: [...dashboard().components, { id: 'x', component: 'Iframe', src: 'https://e' }]
		};
		expect(await refused('define_surface', { ...READY, spec: unknown_component })).toMatch(
			/^The surface spec is invalid: components\.5/
		);

		const orphan = {
			...dashboard(),
			components: [...dashboard().components, { id: 'lost', component: 'Text', text: 'hi' }]
		};
		expect(await refused('define_surface', { ...READY, spec: orphan })).toMatch(
			/"lost" is not reachable from the root/
		);

		const unlisted = { ...dashboard(), data: { ready: { tool: 'meta_read', input: {} } } };
		expect(await refused('define_surface', { ...READY, spec: unlisted })).toMatch(/data\.ready/);

		// The crew tool's own schema checks a binding's input when saved.
		const no_project = {
			...dashboard(),
			components: [
				{ id: 'main', component: 'Stack', children: ['list'] },
				{ id: 'list', component: 'IssueList', data: 'issues' }
			],
			data: { issues: { tool: 'list_issues', input: {} } },
			actions: {}
		};
		expect(await refused('define_surface', { ...READY, spec: no_project })).toMatch(
			/data\.issues\.input: project/
		);

		expect(await store.list(OWNER_VIEWER)).toEqual([]);
	});

	it('revises under the same slug, keeping the description, and reverts', async () => {
		await ok('define_surface', { ...READY, description: 'What to pick up' });
		const revised = await ok('define_surface', { ...READY, spec: dashboard('Pick up next') });
		expect(revised).toMatchObject({
			written: 'revised',
			surface: { revision: 2, description: 'What to pick up' }
		});
		expect(revised.surface.spec.components[1].text).toBe('Pick up next');

		const history = await ok('surface_history', { slug: 'ready-dash' });
		expect(history.url).toBe('/views/ready-dash');
		expect(history.revisions.map((revision: { number: number }) => revision.number)).toEqual([
			2, 1
		]);
		const latest = await ok('surface_history', { slug: 'ready-dash', limit: 1 });
		expect(latest.revisions[0].spec.components[1].text).toBe('Pick up next');
		expect(latest.note).toMatch(/1 older revisions/);

		const reverted = await ok('revert_surface', { slug: 'ready-dash', number: 1 });
		expect(reverted).toMatchObject({ reverted_to: 1, surface: { revision: 3 } });
		expect(reverted.surface.spec.components[1].text).toBe('Ready work');
		expect(await refused('revert_surface', { slug: 'ready-dash', number: 9 })).toMatch(
			/no revision 9/
		);
	});

	it('list_surfaces summarizes without the tree', async () => {
		await ok('define_surface', READY);
		const { surfaces } = await ok('list_surfaces', {});
		expect(surfaces).toEqual([
			expect.objectContaining({
				slug: 'ready-dash',
				url: '/views/ready-dash',
				components: 5,
				data: ['ready'],
				actions: ['remind']
			})
		]);
		expect(surfaces[0]).not.toHaveProperty('spec');
	});

	it('keeps views and surfaces apart: a view’s slug is taken, and view tools never see a surface', async () => {
		await ok('define_view', {
			slug: 'urgent',
			name: 'Urgent',
			project: 'all',
			filters: {}
		});
		expect(await refused('define_surface', { ...READY, slug: 'urgent' })).toMatch(/is taken/);
		await ok('define_surface', READY);
		expect(
			await refused('define_view', { slug: 'ready-dash', name: 'x', project: 'all', filters: {} })
		).toMatch(/is taken/);
		expect(await refused('view_history', { slug: 'ready-dash' })).toMatch(/no view called/);
		expect(await refused('revert_view', { slug: 'ready-dash', number: 1 })).toMatch(
			/no view called/
		);
		expect(await refused('surface_history', { slug: 'urgent' })).toMatch(/no surface called/);
		expect((await ok('list_surfaces', {})).surfaces.map((s: { slug: string }) => s.slug)).toEqual([
			'ready-dash'
		]);
	});

	it('as a member: lists only published revisions and can change nothing', async () => {
		await ok('define_surface', READY);
		await store.publish(OWNER_VIEWER, 'ready-dash');
		await ok('define_surface', { ...READY, name: 'Unpublished rename' });
		expect((await ok('list_surfaces', {}, MEMBER)).surfaces).toMatchObject([
			{ slug: 'ready-dash', name: 'Ready dashboard', mine: false }
		]);
		const writes: [string, Record<string, unknown>][] = [
			['define_surface', { ...READY, slug: 'mine' }],
			['revert_surface', { slug: 'ready-dash', number: 1 }],
			['surface_history', { slug: 'ready-dash' }]
		];
		for (const [name, args] of writes) {
			expect(await refused(name, args, MEMBER)).toMatch(/needs an admin/);
		}
	});

	it('never lets another admin revise or revert a surface they do not own', async () => {
		await ok('define_surface', READY);
		await store.publish(OWNER_VIEWER, 'ready-dash');
		expect(await refused('define_surface', { ...READY, name: 'Mine now' }, OTHER_ADMIN)).toMatch(
			/Only its owner/
		);
		expect(await refused('revert_surface', { slug: 'ready-dash', number: 1 }, OTHER_ADMIN)).toMatch(
			/Only its owner/
		);
		expect(await refused('surface_history', { slug: 'ready-dash' }, OTHER_ADMIN)).toMatch(
			/Only its owner/
		);
	});

	it('teaches the whole catalog, generated from its schema', () => {
		const guide = surfaceCatalogGuide();
		for (const name of SURFACE_COMPONENTS) expect(guide).toContain(`- ${name} {`);
		expect(guide).toContain('- Heading { text: text, level?: 2|3|4 = 2 }');
		expect(guide).toContain('gap?: sm|md|lg = "md"');
		const define = CREW_TOOLS.find((tool) => tool.name === 'define_surface');
		expect(define?.description).toContain(guide);
		expect(define?.description).toMatch(/list_issues.*must name `project`/);
		expect(toolInputSchema(define!)).toMatchObject({
			type: 'object',
			properties: { spec: { type: 'object' } },
			required: ['slug', 'name', 'spec']
		});
	});

	it('has no tool that publishes or shares (ADR-0025 rule 7)', () => {
		const names = CREW_TOOLS.map((tool) => tool.name);
		expect(names).toEqual(
			expect.arrayContaining([
				'define_surface',
				'list_surfaces',
				'surface_history',
				'revert_surface'
			])
		);
		expect(names.filter((name) => /publish|share/.test(name))).toEqual([]);
	});
});
