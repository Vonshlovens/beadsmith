import { createClient } from '@libsql/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { initStateSchema } from '../state/db.js';
import { createGrownStore, type GrownStore } from '../grown/store.js';
import { APP_LIBRARY_NAMES } from '../grown/app-libraries.js';
import { BRIDGE_READ_NAMES } from '../grown/bridge.js';
import { CREW_TOOLS, createCrewMcpHandler, toolInputSchema, type JsonRpcResponse } from './mcp.js';
import type { CrewContext, CrewDeps } from './registry.js';
import { APP_DOCUMENT_PAGE_CHARS } from './app-tools.js';

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
	deps = { grown: async () => store };
});

let next_id = 1;
async function result(name: string, args: Record<string, unknown>, ctx: CrewContext = ADMIN) {
	const handler = createCrewMcpHandler({ deps, log: () => {} });
	const response = (await handler.handle(ctx, {
		jsonrpc: '2.0',
		id: next_id++,
		method: 'tools/call',
		params: { name, arguments: args }
	})) as JsonRpcResponse;
	if (!('result' in response)) throw new Error(JSON.stringify(response.error));
	return response.result as { content: { text: string }[]; isError?: boolean };
}

async function text(name: string, args: Record<string, unknown>, ctx?: CrewContext) {
	const outcome = await result(name, args, ctx);
	expect(outcome.isError, outcome.content[0].text).toBeUndefined();
	return outcome.content[0].text;
}

async function ok(name: string, args: Record<string, unknown>, ctx?: CrewContext) {
	return JSON.parse(await text(name, args, ctx));
}

async function refused(name: string, args: Record<string, unknown>, ctx?: CrewContext) {
	const outcome = await result(name, args, ctx);
	expect(outcome.isError, outcome.content[0].text).toBe(true);
	return outcome.content[0].text;
}

/** A document's header line and body, as `app_history` with a number returns them. */
async function page(args: Record<string, unknown>, ctx?: CrewContext) {
	const body = await text('app_history', args, ctx);
	const newline = body.indexOf('\n');
	return { header: JSON.parse(body.slice(0, newline)), html: body.slice(newline + 1) };
}

const HTML = '<h1>Burndown</h1><script>parent.postMessage({ jsonrpc: "2.0" }, "*")</script>';
const BURNDOWN = { slug: 'burndown', name: 'Burndown', spec: { html: HTML } };

describe('crew app tools', () => {
	it('define_app creates a private app, by First Mate, with its URL and no document', async () => {
		const created = await ok('define_app', BURNDOWN);
		expect(created).toEqual({
			written: 'created',
			app: expect.objectContaining({
				slug: 'burndown',
				name: 'Burndown',
				revision: 1,
				author_kind: 'first_mate',
				mine: true,
				published: false,
				url: '/views/burndown',
				// The store's default library.
				libraries: ['beadsmith-tokens'],
				document_bytes: Buffer.byteLength(HTML),
				document_chars: HTML.length
			})
		});
		expect(created.app).not.toHaveProperty('spec');
		const [revision] = await store.history(OWNER_VIEWER, 'burndown');
		expect(revision).toMatchObject({
			author_kind: 'first_mate',
			author_account_id: 'u_admin',
			author_chat_id: 'mc_one',
			spec: { html: HTML }
		});
		// Owner-private (ADR-0025 rule 7).
		expect(await store.read({ account_id: 'u_other', role: 'admin' }, 'burndown')).toBeUndefined();
		expect((await ok('list_apps', {}, MEMBER)).apps).toEqual([]);
	});

	it('returns the store’s message for an invalid spec and saves nothing', async () => {
		expect(
			await refused('define_app', { ...BURNDOWN, spec: { html: HTML, libraries: ['jquery'] } })
		).toMatch(/^The app spec is invalid: libraries\.0/);
		expect(
			await refused('define_app', {
				...BURNDOWN,
				spec: { html: HTML, libraries: ['beadsmith-tokens', 'beadsmith-tokens'] }
			})
		).toMatch(/libraries/);
		expect(await refused('define_app', { ...BURNDOWN, spec: { html: '' } })).toMatch(/html/);
		expect(
			await refused('define_app', { ...BURNDOWN, spec: { html: HTML, sql: 'select 1' } })
		).toMatch(/sql/);
		expect(await store.list(OWNER_VIEWER)).toEqual([]);
	});

	it('revises under the same slug, reads the document back in pages, and reverts', async () => {
		await ok('define_app', { ...BURNDOWN, description: 'Closed per day' });
		// Longer than one page, so reading it back takes two calls.
		const long = `<main>${'<p>day</p>'.repeat(APP_DOCUMENT_PAGE_CHARS / 10 + 50)}</main>`;
		const revised = await ok('define_app', {
			...BURNDOWN,
			spec: { html: long, libraries: [] }
		});
		expect(revised).toMatchObject({
			written: 'revised',
			app: {
				revision: 2,
				description: 'Closed per day',
				libraries: [],
				document_chars: long.length
			}
		});

		const history = await ok('app_history', { slug: 'burndown' });
		expect(history.url).toBe('/views/burndown');
		expect(history.revisions.map((revision: { number: number }) => revision.number)).toEqual([
			2, 1
		]);
		expect(history.revisions[0]).not.toHaveProperty('spec');
		expect(history.revisions[0]).toMatchObject({ document_chars: long.length, published: false });

		const first = await page({ slug: 'burndown', number: 2 });
		expect(first.header).toMatchObject({
			revision: 2,
			chars: [0, APP_DOCUMENT_PAGE_CHARS],
			total_chars: long.length,
			next_offset: APP_DOCUMENT_PAGE_CHARS
		});
		const second = await page({ slug: 'burndown', number: 2, offset: first.header.next_offset });
		expect(second.header).not.toHaveProperty('next_offset');
		// Whole and unescaped: nothing was cut by the result bound.
		expect(first.html + second.html).toBe(long);
		expect((await page({ slug: 'burndown', number: 1 })).html).toBe(HTML);
		expect(await refused('app_history', { slug: 'burndown', number: 9 })).toMatch(/no revision 9/);
		expect(
			await refused('app_history', { slug: 'burndown', number: 1, offset: HTML.length })
		).toMatch(/past its end/);

		const reverted = await ok('revert_app', { slug: 'burndown', number: 1 });
		expect(reverted).toMatchObject({
			reverted_to: 1,
			app: { revision: 3, document_chars: HTML.length, libraries: ['beadsmith-tokens'] }
		});
		expect(reverted.app).not.toHaveProperty('spec');
		expect(await refused('revert_app', { slug: 'burndown', number: 9 })).toMatch(/no revision 9/);
	});

	it('list_apps summarizes without the document', async () => {
		await ok('define_app', BURNDOWN);
		const { apps } = await ok('list_apps', {});
		expect(apps).toEqual([
			expect.objectContaining({
				slug: 'burndown',
				url: '/views/burndown',
				libraries: ['beadsmith-tokens'],
				document_chars: HTML.length
			})
		]);
		expect(apps[0]).not.toHaveProperty('spec');
	});

	it('keeps apps apart from other kinds: a surface’s slug is taken, and no other tool sees an app', async () => {
		await ok('define_view', { slug: 'urgent', name: 'Urgent', project: 'all', filters: {} });
		expect(await refused('define_app', { ...BURNDOWN, slug: 'urgent' })).toMatch(/is taken/);
		await ok('define_app', BURNDOWN);
		expect(
			await refused('define_surface', {
				slug: 'burndown',
				name: 'x',
				spec: { root: 'h', components: [{ id: 'h', component: 'Heading', text: 'x' }] }
			})
		).toMatch(/is taken/);
		expect(await refused('surface_history', { slug: 'burndown' })).toMatch(/no surface called/);
		expect(await refused('revert_view', { slug: 'burndown', number: 1 })).toMatch(/no view called/);
		expect(await refused('app_history', { slug: 'urgent' })).toMatch(/no app called/);
		expect(await refused('revert_app', { slug: 'urgent', number: 1 })).toMatch(/no app called/);
		expect((await ok('list_surfaces', {})).surfaces).toEqual([]);
		expect((await ok('list_apps', {})).apps.map((app: { slug: string }) => app.slug)).toEqual([
			'burndown'
		]);
	});

	it('as a member: lists only published revisions and can change or read back nothing', async () => {
		await ok('define_app', BURNDOWN);
		await store.publish(OWNER_VIEWER, 'burndown');
		await ok('define_app', { ...BURNDOWN, name: 'Unpublished rename' });
		expect((await ok('list_apps', {}, MEMBER)).apps).toMatchObject([
			{ slug: 'burndown', name: 'Burndown', mine: false }
		]);
		const writes: [string, Record<string, unknown>][] = [
			['define_app', { ...BURNDOWN, slug: 'mine' }],
			['revert_app', { slug: 'burndown', number: 1 }],
			['app_history', { slug: 'burndown' }],
			['app_history', { slug: 'burndown', number: 1 }]
		];
		for (const [name, args] of writes) {
			expect(await refused(name, args, MEMBER)).toMatch(/needs an admin/);
		}
	});

	it('never lets another admin revise, revert or read the history of an app they do not own', async () => {
		await ok('define_app', BURNDOWN);
		await store.publish(OWNER_VIEWER, 'burndown');
		expect(await refused('define_app', { ...BURNDOWN, name: 'Mine now' }, OTHER_ADMIN)).toMatch(
			/Only its owner/
		);
		expect(await refused('revert_app', { slug: 'burndown', number: 1 }, OTHER_ADMIN)).toMatch(
			/Only its owner/
		);
		expect(await refused('app_history', { slug: 'burndown', number: 1 }, OTHER_ADMIN)).toMatch(
			/Only its owner/
		);
	});

	it('teaches the bridge, its reads and the library allowlist', () => {
		const define = CREW_TOOLS.find((tool) => tool.name === 'define_app');
		const description = define?.description ?? '';
		for (const name of [...BRIDGE_READ_NAMES, 'run_view']) expect(description).toContain(name);
		for (const name of APP_LIBRARY_NAMES) expect(description).toContain(`- ${name} (`);
		for (const method of ['ui/initialize', 'tools/call', 'ui/notifications/size-changed']) {
			expect(description).toContain(method);
		}
		expect(description).toMatch(/list_issues.*must name `project`/s);
		expect(description).toMatch(/no network/);
		expect(toolInputSchema(define!)).toMatchObject({
			type: 'object',
			properties: { spec: { type: 'object' } },
			required: ['slug', 'name', 'spec']
		});
	});

	it('has no tool that publishes or shares (ADR-0025 rule 7)', () => {
		const names = CREW_TOOLS.map((tool) => tool.name);
		expect(names).toEqual(
			expect.arrayContaining(['define_app', 'list_apps', 'app_history', 'revert_app'])
		);
		expect(names.filter((name) => /publish|share/.test(name))).toEqual([]);
	});
});
