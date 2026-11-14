import { createClient } from '@libsql/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { initStateSchema } from '../state/db.js';
import { createMemoryStore, OWNER_SCOPED_MAX, type MemoryStore } from '../mate/memory-store.js';
import type { Project } from '#lib/types.js';
import { createCrewMcpHandler, type JsonRpcResponse } from './mcp.js';
import type { CrewContext, CrewDeps } from './registry.js';

const ADMIN: CrewContext = {
	account_id: 'u_admin',
	actor: 'admin@example.test',
	role: 'admin',
	chat_id: 'mc_one',
	scope: 'd_alpha'
};
const OTHER_ADMIN: CrewContext = { ...ADMIN, account_id: 'u_other', chat_id: 'mc_two' };
const MEMBER: CrewContext = { ...ADMIN, role: 'member' };

const PROJECTS: Project[] = ['alpha', 'beta'].map((name) => ({
	id: `d_${name}`,
	name,
	state: 'remote',
	dolt_database: name,
	backend: 'server-sql',
	readonly: true
}));

let store: MemoryStore;
let deps: CrewDeps;

beforeEach(async () => {
	const client = createClient({ url: ':memory:' });
	await initStateSchema(client);
	store = createMemoryStore(client);
	deps = { projects: async () => PROJECTS, memories: async () => store };
});

let next_id = 1;
async function rpc(
	name: string,
	args: Record<string, unknown>,
	ctx: CrewContext = ADMIN
): Promise<{ text: string; isError?: boolean }> {
	const handler = createCrewMcpHandler({ deps, log: () => {} });
	const response = (await handler.handle(ctx, {
		jsonrpc: '2.0',
		id: next_id++,
		method: 'tools/call',
		params: { name, arguments: args }
	})) as JsonRpcResponse;
	if (!('result' in response)) throw new Error(JSON.stringify(response.error));
	const result = response.result as { content: { text: string }[]; isError?: boolean };
	return { text: result.content[0].text, isError: result.isError };
}

async function ok(name: string, args: Record<string, unknown>, ctx?: CrewContext) {
	const result = await rpc(name, args, ctx);
	expect(result.isError, result.text).toBeUndefined();
	return JSON.parse(result.text);
}

async function refused(name: string, args: Record<string, unknown>, ctx?: CrewContext) {
	const result = await rpc(name, args, ctx);
	expect(result.isError, result.text).toBe(true);
	return result.text;
}

describe('memory tools', () => {
	it('remember, update, recall and forget as the owner', async () => {
		const created = await ok('remember', {
			key: 'deploy-window',
			body: 'Deploys happen on Tuesdays.',
			scope: 'owner'
		});
		expect(created).toMatchObject({
			remembered: 'created',
			memory: { key: 'deploy-window', scope: 'owner' },
			counts: { total: 1, owner_scoped: 1 }
		});
		expect((await store.get('u_admin', 'deploy-window'))?.source_chat_id).toBe('mc_one');

		const updated = await ok('remember', {
			key: 'deploy-window',
			body: 'Deploys happen on Thursdays.',
			scope: 'topic',
			topic: 'deploys'
		});
		expect(updated).toMatchObject({ remembered: 'updated', memory: { scope: 'topic:deploys' } });

		const found = await ok('recall', { query: 'thursday deploys' });
		expect(found.memories.map((m: { key: string }) => m.key)).toEqual(['deploy-window']);
		expect(found.total).toBe(1);

		expect(await ok('forget', { key: 'deploy-window' })).toEqual({ forgot: 'deploy-window' });
		expect(await refused('forget', { key: 'deploy-window' })).toMatch(/No memory/);
	});

	it('scopes project memories to the chat’s project or the one named', async () => {
		await ok('remember', { key: 'alpha-ci', body: 'Alpha CI is slow.', scope: 'project' });
		await ok('remember', {
			key: 'beta-ci',
			body: 'Beta CI is fast.',
			scope: 'project',
			project: 'beta'
		});
		expect((await store.get('u_admin', 'alpha-ci'))?.scope).toBe('project:d_alpha');
		expect((await store.get('u_admin', 'beta-ci'))?.scope).toBe('project:d_beta');

		const alpha = await ok('recall', { query: 'ci', scope: 'project' });
		expect(alpha.memories.map((m: { key: string }) => m.key)).toEqual(['alpha-ci']);

		expect(
			await refused('remember', { key: 'x', body: 'y', scope: 'project', project: 'nope' })
		).toMatch(/No project/);
		expect(await refused('remember', { key: 'x', body: 'y', scope: 'topic' })).toMatch(
			/needs topic/
		);
	});

	it('never shows one owner’s memory to another', async () => {
		await ok('remember', { key: 'editor', body: 'Uses Helix.', scope: 'owner' });
		const other = await ok('recall', { query: 'helix' }, OTHER_ADMIN);
		expect(other).toMatchObject({ memories: [], total: 0 });
		expect(await refused('forget', { key: 'editor' }, OTHER_ADMIN)).toMatch(/No memory/);
	});

	it('refuses invalid input and limits with a message the model can act on', async () => {
		// Malformed arguments are JSON-RPC errors naming the field, as for every crew tool.
		await expect(rpc('remember', { key: 'Bad Key', body: 'x', scope: 'owner' })).rejects.toThrow(
			/Invalid arguments for remember: key/
		);
		await expect(
			rpc('remember', { key: 'long', body: 'x'.repeat(501), scope: 'owner' })
		).rejects.toThrow(/Invalid arguments for remember: body/);
		for (let i = 0; i < OWNER_SCOPED_MAX; i++) {
			await store.remember('u_admin', {
				key: `pref-${i}`,
				body: 'x',
				scope: 'owner',
				source_chat_id: null
			});
		}
		expect(await refused('remember', { key: 'more', body: 'x', scope: 'owner' })).toMatch(
			/owner memories/
		);
	});

	it('says when more matched than were returned, and stamps what it returned', async () => {
		for (let i = 0; i < 3; i++) {
			await ok('remember', {
				key: `note-${i}`,
				body: `Note ${i}.`,
				scope: 'topic',
				topic: 'notes'
			});
		}
		const some = await ok('recall', { scope: 'topic', topic: 'notes', limit: 2 });
		expect(some.memories).toHaveLength(2);
		expect(some.total).toBe(3);
		expect(some.note).toMatch(/1 more/);
		expect((await store.get('u_admin', some.memories[0].key))?.last_recalled_at).not.toBeNull();
	});

	it('is not available to a member owner', async () => {
		expect(await refused('remember', { key: 'x', body: 'y', scope: 'owner' }, MEMBER)).toMatch(
			/admin/
		);
	});
});
