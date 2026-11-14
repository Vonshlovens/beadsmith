import { createClient, type Client } from '@libsql/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { initStateSchema } from '../state/db.js';
import {
	createMemoryStore,
	ftsQuery,
	isMemoryScope,
	MEMORIES_PER_OWNER,
	MEMORY_BODY_MAX,
	MemoryLimitError,
	OWNER_SCOPED_MAX,
	type MemoryStore
} from './memory-store.js';

let client: Client;
let store: MemoryStore;
let tick = 0;

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	await initStateSchema(client);
	tick = 0;
	store = createMemoryStore(client, () => new Date(Date.UTC(2026, 10, 14, 0, 0, tick++)));
});

function fact(
	key: string,
	body: string,
	scope: Parameters<MemoryStore['remember']>[1]['scope'] = 'owner'
) {
	return { key, body, scope, source_chat_id: 'mc_one' };
}

describe('memory store', () => {
	it('creates, then replaces a memory under the same key', async () => {
		const first = await store.remember('u_a', fact('deploy-window', 'Deploys happen on Tuesdays.'));
		expect(first.created).toBe(true);
		const second = await store.remember(
			'u_a',
			fact('deploy-window', 'Deploys happen on Thursdays.', 'topic:deploys')
		);
		expect(second.created).toBe(false);
		expect(second.memory).toMatchObject({
			key: 'deploy-window',
			scope: 'topic:deploys',
			body: 'Deploys happen on Thursdays.',
			created_at: first.memory.created_at
		});
		expect(await store.counts('u_a')).toEqual({ total: 1, owner_scoped: 0 });
	});

	it('keeps owners apart', async () => {
		await store.remember('u_a', fact('editor', 'Uses Helix.'));
		expect(await store.get('u_b', 'editor')).toBeUndefined();
		expect((await store.recall('u_b', { text: 'helix', limit: 25 })).memories).toEqual([]);
		expect((await store.recall('u_b', { limit: 25 })).memories).toEqual([]);
		expect(await store.forget('u_b', 'editor')).toBe(false);
		expect(await store.get('u_a', 'editor')).toBeDefined();
	});

	it('refuses bad keys, scopes and bodies without writing', async () => {
		for (const input of [
			fact('Bad Key', 'x'),
			fact('a--b', 'x'),
			fact('x'.repeat(65), 'x'),
			fact('ok', '   '),
			fact('ok', 'x'.repeat(MEMORY_BODY_MAX + 1)),
			{ ...fact('ok', 'x'), scope: 'topic:Not_A_Slug' as const }
		]) {
			await expect(store.remember('u_a', input)).rejects.toBeInstanceOf(MemoryLimitError);
		}
		expect(await store.counts('u_a')).toEqual({ total: 0, owner_scoped: 0 });
	});

	it('caps owner-scoped memories but still lets one be updated', async () => {
		for (let i = 0; i < OWNER_SCOPED_MAX; i++) {
			await store.remember('u_a', fact(`pref-${i}`, `Preference ${i}.`));
		}
		await expect(store.remember('u_a', fact('one-more', 'Too many.'))).rejects.toThrow(
			/owner memories/
		);
		await expect(store.remember('u_a', fact('pref-0', 'Changed.'))).resolves.toMatchObject({
			created: false
		});
		// A project memory still fits.
		await expect(
			store.remember('u_a', fact('one-more', 'Fine here.', 'project:d_alpha'))
		).resolves.toMatchObject({ created: true });
	});

	it('caps memories per owner', async () => {
		for (let i = 0; i < MEMORIES_PER_OWNER; i++) {
			await client.execute({
				sql: `INSERT INTO mate_memories (owner_id, key, scope, body, created_at, updated_at)
					VALUES ('u_a', ?, 'topic:filler', 'x', 't', 't')`,
				args: [`m-${i}`]
			});
		}
		await expect(store.remember('u_a', fact('new', 'No room.', 'topic:x'))).rejects.toThrow(
			/Memory is full/
		);
		await expect(store.remember('u_a', fact('m-1', 'Updated.', 'topic:x'))).resolves.toBeDefined();
		await expect(
			store.remember('u_b', fact('new', 'Other owner.', 'topic:x'))
		).resolves.toBeDefined();
	});

	it('ranks a matching memory above unrelated ones and keeps the index in step', async () => {
		await store.remember('u_a', fact('ui-style', 'Prefers dense tables over cards.', 'topic:ui'));
		await store.remember(
			'u_a',
			fact('backup-host', 'Nightly backups go to the bucket on the beads host.', 'topic:backups')
		);
		await store.remember('u_a', fact('coffee', 'Drinks it black.'));

		const hit = await store.recall('u_a', { text: 'when do the backups run?', limit: 25 });
		expect(hit.memories.map((m) => m.key)).toEqual(['backup-host']);
		expect(hit.total).toBe(1);

		// Stemming: "backup" finds "backups".
		expect((await store.recall('u_a', { text: 'backup', limit: 25 })).total).toBe(1);

		await store.remember('u_a', fact('backup-host', 'Backups moved to weekly.', 'topic:backups'));
		expect((await store.recall('u_a', { text: 'nightly', limit: 25 })).total).toBe(0);
		expect((await store.recall('u_a', { text: 'weekly', limit: 25 })).total).toBe(1);

		await store.forget('u_a', 'backup-host');
		expect((await store.recall('u_a', { text: 'weekly', limit: 25 })).total).toBe(0);
	});

	it('filters by scope, lists newest first and bounds the count', async () => {
		await store.remember('u_a', fact('a-one', 'Alpha one.', 'project:d_alpha'));
		await store.remember('u_a', fact('b-one', 'Beta one.', 'project:d_beta'));
		await store.remember('u_a', fact('a-two', 'Alpha two.', 'project:d_alpha'));

		const alpha = await store.recall('u_a', { scope: 'project:d_alpha', limit: 1 });
		expect(alpha.memories.map((m) => m.key)).toEqual(['a-two']);
		expect(alpha.total).toBe(2);

		const text = await store.recall('u_a', { text: 'one', scope: 'project:d_beta', limit: 25 });
		expect(text.memories.map((m) => m.key)).toEqual(['b-one']);
	});

	it('treats query text as words, never FTS syntax', async () => {
		await store.remember('u_a', fact('quote', 'He said "hi" (once).'));
		expect(ftsQuery('a "b" OR c*')).toBe('"a" OR "b" OR "or" OR "c"');
		expect(ftsQuery('?!')).toBeUndefined();
		expect((await store.recall('u_a', { text: '"hi" NEAR( (', limit: 25 })).total).toBe(1);
		expect((await store.recall('u_a', { text: '***', limit: 25 })).total).toBe(0);
	});

	it('stamps recalled memories', async () => {
		await store.remember('u_a', fact('editor', 'Uses Helix.'));
		await store.markRecalled('u_a', ['editor']);
		expect((await store.get('u_a', 'editor'))?.last_recalled_at).not.toBeNull();
	});

	it('validates scopes', () => {
		expect(isMemoryScope('owner')).toBe(true);
		expect(isMemoryScope('project:d_beads_web')).toBe(true);
		expect(isMemoryScope('topic:backups')).toBe(true);
		expect(isMemoryScope('topic:')).toBe(false);
		expect(isMemoryScope('project:')).toBe(false);
		expect(isMemoryScope('team')).toBe(false);
	});
});
