/**
 * The catalog surfaces feature end to end (ADR-0025 tier 2): First Mate
 * defines a dashboard through its crew tools, the dashboard's data resolves
 * as whoever opens it, and a revert brings an earlier tree back. Each piece
 * has its own tests; this one checks they compose the way a conversation
 * uses them, through the same entry points (the crew MCP handler and the
 * bindings resolver the /views/<slug> page calls).
 */
import { createClient } from '@libsql/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { initStateSchema } from '../state/db.js';
import { createCrewMcpHandler, type JsonRpcResponse } from '../crew/mcp.js';
import type { CrewContext, CrewDeps } from '../crew/registry.js';
import type { DoltClient } from '../dolt/client.js';
import type { IssueSummary, Project } from '#lib/types.js';
import { createGrownStore, type GrownStore } from './store.js';
import { resolveSurfaceBindings, type BridgeViewer } from './bindings.js';

const FIRST_MATE: CrewContext = {
	account_id: 'u_admin',
	actor: 'admin@example.test',
	role: 'admin',
	chat_id: 'mc_one',
	scope: 'd_alpha'
};
const OWNER: BridgeViewer = { account_id: 'u_admin', role: 'admin', actor: 'admin@example.test' };
const MEMBER: BridgeViewer = { account_id: 'u_member', role: 'member', actor: 'm@example.test' };

const PROJECT: Project = {
	id: 'd_alpha',
	name: 'alpha',
	state: 'remote',
	dolt_database: 'alpha',
	backend: 'server-sql',
	readonly: true
};

function issue(id: string, status: string, priority: number): IssueSummary {
	return {
		id,
		title: `Issue ${id}`,
		status,
		priority,
		issue_type: 'task',
		labels: [],
		created_at: '2026-11-01T00:00:00Z',
		updated_at: '2026-11-01T00:00:00Z',
		dependency_count: 0,
		dependent_count: 0,
		comment_count: 0
	};
}

let store: GrownStore;
let crew: CrewDeps;

beforeEach(async () => {
	const client = createClient({ url: ':memory:' });
	await initStateSchema(client);
	store = createGrownStore(client);
	const rows = [issue('alpha-1', 'blocked', 1), issue('alpha-2', 'blocked', 2)];
	const dolt: Partial<DoltClient> = { browseIssues: async () => rows };
	crew = {
		grown: async () => store,
		projects: async () => [PROJECT],
		read: { dolt: dolt as DoltClient, dolt_configured: true }
	};
});

let next_id = 1;
/** One First Mate tool call, as the chat makes it; the parsed result. */
async function firstMate(name: string, args: Record<string, unknown>) {
	const handler = createCrewMcpHandler({ deps: crew, log: () => {} });
	const response = (await handler.handle(FIRST_MATE, {
		jsonrpc: '2.0',
		id: next_id++,
		method: 'tools/call',
		params: { name, arguments: args }
	})) as JsonRpcResponse;
	if (!('result' in response)) throw new Error(JSON.stringify(response.error));
	const result = response.result as { content: { text: string }[]; isError?: boolean };
	return { refused: result.isError === true, text: result.content[0].text };
}

/** Stats, a filtered list and a chart over one saved view, plus projects. */
function dashboard(title: string) {
	return {
		root: 'main',
		components: [
			{ id: 'main', component: 'Stack', children: ['title', 'stats', 'list', 'chart'] },
			{ id: 'title', component: 'Heading', text: title },
			{ id: 'stats', component: 'Row', children: ['blocked_count', 'project_count'] },
			{ id: 'blocked_count', component: 'StatTile', label: 'Blocked', count: 'blocked' },
			{ id: 'project_count', component: 'StatTile', label: 'Projects', count: 'projects' },
			{ id: 'list', component: 'IssueList', data: 'blocked', limit: 10 },
			{ id: 'chart', component: 'Chart', data: 'blocked', by: 'priority' }
		],
		data: {
			blocked: { view: 'blocked' },
			projects: { tool: 'list_projects', input: {} }
		}
	};
}

async function resolveAs(viewer: BridgeViewer, slug: string) {
	const thing = await store.read(viewer, slug);
	if (thing === undefined) return undefined;
	return { thing, data: await resolveSurfaceBindings(store, viewer, thing, undefined, { crew }) };
}

describe('catalog surfaces end to end', () => {
	it('First Mate builds a dashboard that reads as its viewer, and reverts it', async () => {
		// The conversation: a filtered view first, then the dashboard over it.
		const view = await firstMate('define_view', {
			slug: 'blocked',
			name: 'Blocked',
			project: 'd_alpha',
			filters: { status: ['blocked'] }
		});
		expect(view.refused, view.text).toBe(false);

		// A component outside the catalog is refused before anything is saved.
		const unknown = await firstMate('define_surface', {
			slug: 'review',
			name: 'Review',
			spec: {
				...dashboard('Review'),
				components: [
					...dashboard('Review').components,
					{ id: 'x', component: 'Script', code: 'alert(1)' }
				]
			}
		});
		expect(unknown.refused).toBe(true);
		expect(await store.read(OWNER, 'review')).toBeUndefined();

		const created = await firstMate('define_surface', {
			slug: 'review',
			name: 'Review',
			spec: dashboard('Review queue')
		});
		expect(created.refused, created.text).toBe(false);
		await firstMate('define_surface', {
			slug: 'review',
			name: 'Review',
			spec: dashboard('Renamed')
		});

		// The owner opens it: every binding resolves as the owner.
		const as_owner = await resolveAs(OWNER, 'review');
		expect(as_owner?.data.blocked).toMatchObject({
			ok: true,
			yields: 'issues',
			data: { issues: [expect.objectContaining({ id: 'alpha-1' }), expect.anything()] }
		});
		expect(as_owner?.data.projects).toMatchObject({ ok: true, yields: 'projects' });

		// Owner-private: a member sees nothing until an admin publishes.
		expect(await resolveAs(MEMBER, 'review')).toBeUndefined();
		await store.publish(OWNER, 'review');
		await store.publish(OWNER, 'blocked');
		const as_member = await resolveAs(MEMBER, 'review');
		expect(as_member?.data.blocked).toMatchObject({ ok: true, yields: 'issues' });
		expect(as_member?.data.projects).toMatchObject({ ok: true, yields: 'projects' });

		// Revert through First Mate brings the first tree back.
		const reverted = await firstMate('revert_surface', { slug: 'review', number: 1 });
		expect(reverted.refused, reverted.text).toBe(false);
		const after = await resolveAs(OWNER, 'review');
		expect(after?.thing.revision.spec).toMatchObject({
			components: expect.arrayContaining([
				expect.objectContaining({ id: 'title', text: 'Review queue' })
			])
		});
	});
});
