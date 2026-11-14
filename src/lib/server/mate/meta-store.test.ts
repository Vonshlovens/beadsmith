import { createClient, type Client } from '@libsql/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { initStateSchema } from '../state/db.js';
import {
	createMetaStore,
	META_CHARS_PER_OWNER,
	META_FILE_MAX,
	META_FILES_PER_OWNER,
	MetaLimitError,
	metaPathProblem,
	type MetaStore
} from './meta-store.js';

let client: Client;
let store: MetaStore;

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	await initStateSchema(client);
	store = createMetaStore(client);
});

function write(path: string, content: string, append = false, owner = 'u_a') {
	return store.write(owner, { path, content, append, source_chat_id: 'mc_one' });
}

describe('meta store', () => {
	it('creates, replaces and appends', async () => {
		expect((await write('notes/deploys.md', 'Tuesdays.')).created).toBe(true);
		expect((await write('notes/deploys.md', 'Thursdays.')).created).toBe(false);
		await write('notes/deploys.md', ' Not Fridays.', true);
		expect((await store.read('u_a', 'notes/deploys.md'))?.content).toBe('Thursdays. Not Fridays.');
		const created = await write('log.md', 'first', true);
		expect(created.created).toBe(true);
		expect(created.file.chars).toBe(5);
	});

	it('lists by folder, with wildcards taken literally', async () => {
		await write('notes/a.md', 'a');
		await write('notes/sub/b.md', 'b');
		await write('notesx/c.md', 'c');
		await write('n_tes/d.md', 'd');
		await write('top.md', 't');
		expect((await store.list('u_a')).map((f) => f.path)).toEqual([
			'n_tes/d.md',
			'notes/a.md',
			'notes/sub/b.md',
			'notesx/c.md',
			'top.md'
		]);
		expect((await store.list('u_a', 'notes/')).map((f) => f.path)).toEqual([
			'notes/a.md',
			'notes/sub/b.md'
		]);
		expect((await store.list('u_a', 'n_tes')).map((f) => f.path)).toEqual(['n_tes/d.md']);
	});

	it('keeps owners apart', async () => {
		await write('secret.md', 'mine');
		expect(await store.read('u_b', 'secret.md')).toBeUndefined();
		expect(await store.list('u_b')).toEqual([]);
		expect(await store.remove('u_b', 'secret.md')).toBe(false);
		expect(await store.move('u_b', 'secret.md', 'taken.md')).toBeUndefined();
		await write('secret.md', 'theirs', false, 'u_b');
		expect((await store.read('u_a', 'secret.md'))?.content).toBe('mine');
	});

	it('refuses bad paths', async () => {
		for (const path of ['', '/abs.md', '../up.md', 'a/../b', '.hidden', 'a//b', 'a b.md', 'a/']) {
			expect(metaPathProblem(path), path).toBeDefined();
			await expect(write(path, 'x')).rejects.toBeInstanceOf(MetaLimitError);
		}
		expect(metaPathProblem('a/b/c/d/e/f/g/h.md')).toBeUndefined();
		expect(metaPathProblem('a/b/c/d/e/f/g/h/i.md')).toBeDefined();
		expect(metaPathProblem('notes/v1.2_draft-x.md')).toBeUndefined();
	});

	it('caps file size, on replace and on append', async () => {
		await expect(write('big.md', 'x'.repeat(META_FILE_MAX + 1))).rejects.toThrow(/at most/);
		await write('big.md', 'x'.repeat(META_FILE_MAX - 1));
		await expect(write('big.md', 'yy', true)).rejects.toThrow(/would make it 20001/);
		await write('big.md', 'y', true);
		expect((await store.read('u_a', 'big.md'))?.chars).toBe(META_FILE_MAX);
	});

	it('caps the number of files but still lets one be rewritten', async () => {
		for (let i = 0; i < META_FILES_PER_OWNER; i++) {
			await client.execute({
				sql: `INSERT INTO mate_meta_files (owner_id, path, content, created_at, updated_at)
					VALUES ('u_a', ?, 'x', 't', 't')`,
				args: [`f${i}.md`]
			});
		}
		await expect(write('new.md', 'x')).rejects.toThrow(/full \(200 files\)/);
		await expect(write('f1.md', 'changed')).resolves.toMatchObject({ created: false });
	});

	it('caps the characters per owner', async () => {
		const per = META_FILE_MAX;
		for (let i = 0; i < META_CHARS_PER_OWNER / per; i++) {
			await client.execute({
				sql: `INSERT INTO mate_meta_files (owner_id, path, content, created_at, updated_at)
					VALUES ('u_a', ?, ?, 't', 't')`,
				args: [`f${i}.md`, 'x'.repeat(per)]
			});
		}
		await expect(write('one-more.md', 'x')).rejects.toThrow(/characters in all/);
		// Replacing a file with a shorter one frees room.
		await write('f0.md', 'short');
		await expect(write('one-more.md', 'x')).resolves.toMatchObject({ created: true });
	});

	it('moves and deletes', async () => {
		await write('draft.md', 'd');
		await write('other.md', 'o');
		await expect(store.move('u_a', 'draft.md', 'other.md')).rejects.toThrow(/already exists/);
		await expect(store.move('u_a', 'draft.md', '../x')).rejects.toBeInstanceOf(MetaLimitError);
		expect((await store.move('u_a', 'draft.md', 'done/draft.md'))?.path).toBe('done/draft.md');
		expect(await store.read('u_a', 'draft.md')).toBeUndefined();
		expect(await store.move('u_a', 'missing.md', 'x.md')).toBeUndefined();
		expect(await store.remove('u_a', 'done/draft.md')).toBe(true);
		expect(await store.remove('u_a', 'done/draft.md')).toBe(false);
		expect(await store.usage('u_a')).toEqual({ files: 1, chars: 1 });
	});
});
