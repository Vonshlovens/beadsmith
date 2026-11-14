import { createClient } from '@libsql/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { initStateSchema } from '../state/db.js';
import { createMetaStore, META_FILE_MAX, type MetaStore } from '../mate/meta-store.js';
import { createCrewMcpHandler, type JsonRpcResponse } from './mcp.js';
import { FIELD_MAX_CHARS, type CrewContext, type CrewDeps } from './registry.js';

const ADMIN: CrewContext = {
	account_id: 'u_admin',
	actor: 'admin@example.test',
	role: 'admin',
	chat_id: 'mc_one',
	scope: null
};
const NEXT_CHAT: CrewContext = { ...ADMIN, chat_id: 'mc_two' };
const OTHER_ADMIN: CrewContext = { ...ADMIN, account_id: 'u_other' };
const MEMBER: CrewContext = { ...ADMIN, role: 'member' };

let store: MetaStore;
let deps: CrewDeps;

beforeEach(async () => {
	const client = createClient({ url: ':memory:' });
	await initStateSchema(client);
	store = createMetaStore(client);
	deps = { meta: async () => store };
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
	return result.text;
}

async function refused(name: string, args: Record<string, unknown>, ctx?: CrewContext) {
	const result = await rpc(name, args, ctx);
	expect(result.isError, result.text).toBe(true);
	return result.text;
}

describe('meta folder tools', () => {
	it('writes in one chat and reads back, whole, in the next', async () => {
		const long = 'line of notes\n'.repeat(1000).slice(0, META_FILE_MAX);
		expect(long.length).toBeGreaterThan(FIELD_MAX_CHARS);
		expect(
			JSON.parse(await ok('meta_write', { path: 'notes/plan.md', content: long }))
		).toMatchObject({
			written: 'created',
			file: { path: 'notes/plan.md', chars: long.length }
		});
		const read = await ok('meta_read', { path: 'notes/plan.md' }, NEXT_CHAT);
		expect(read.startsWith(`notes/plan.md (${long.length} chars, updated `)).toBe(true);
		expect(read.endsWith(long)).toBe(true);
		expect((await store.read('u_admin', 'notes/plan.md'))?.source_chat_id).toBe('mc_one');
	});

	it('appends, lists, moves and deletes', async () => {
		await ok('meta_write', { path: 'todo.md', content: '- one\n' });
		expect(
			JSON.parse(await ok('meta_write', { path: 'todo.md', content: '- two\n', append: true }))
				.written
		).toBe('appended');
		await ok('meta_write', { path: 'notes/a.md', content: 'a' });

		const listed = JSON.parse(await ok('meta_list', {}));
		expect(listed.files.map((f: { path: string }) => f.path)).toEqual(['notes/a.md', 'todo.md']);
		expect(listed.usage).toMatchObject({ files: 2, chars: 13, files_max: 200 });
		expect(
			JSON.parse(await ok('meta_list', { folder: 'notes' })).files.map(
				(f: { path: string }) => f.path
			)
		).toEqual(['notes/a.md']);

		await ok('meta_move', { from: 'todo.md', to: 'done/todo.md' });
		expect(await refused('meta_move', { from: 'todo.md', to: 'x.md' })).toMatch(/No file/);
		expect(await refused('meta_move', { from: 'notes/a.md', to: 'done/todo.md' })).toMatch(
			/already exists/
		);
		expect((await store.read('u_admin', 'done/todo.md'))?.content).toBe('- one\n- two\n');

		expect(JSON.parse(await ok('meta_delete', { path: 'done/todo.md' }))).toEqual({
			deleted: 'done/todo.md'
		});
		expect(await refused('meta_delete', { path: 'done/todo.md' })).toMatch(/No file/);
		expect(await refused('meta_read', { path: 'done/todo.md' })).toMatch(/No file/);
	});

	it('refuses bad paths and oversized appends', async () => {
		await expect(rpc('meta_write', { path: '../etc/passwd', content: 'x' })).rejects.toThrow(
			/Invalid arguments for meta_write: path/
		);
		await ok('meta_write', { path: 'big.md', content: 'x'.repeat(META_FILE_MAX) });
		expect(await refused('meta_write', { path: 'big.md', content: 'y', append: true })).toMatch(
			/at most/
		);
	});

	it('never shows one owner’s folder to another, nor to a member', async () => {
		await ok('meta_write', { path: 'mine.md', content: 'private' });
		expect(JSON.parse(await ok('meta_list', {}, OTHER_ADMIN)).files).toEqual([]);
		expect(await refused('meta_read', { path: 'mine.md' }, OTHER_ADMIN)).toMatch(/No file/);
		expect(await refused('meta_list', {}, MEMBER)).toMatch(/admin/);
	});
});
