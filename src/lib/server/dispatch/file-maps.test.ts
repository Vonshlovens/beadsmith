import { createClient } from '@libsql/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { initStateSchema } from '../state/db.js';
import { createFileMapStore } from './file-maps.js';

const BEADS_WEB = {
	url: 'https://github.com/example-org/beads-web',
	ref: 'main'
};

let store: ReturnType<typeof createFileMapStore>;
let client: ReturnType<typeof createClient>;

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	await initStateSchema(client);
	store = createFileMapStore(client);
});

describe('createFileMapStore', () => {
	it('round-trips a checkout without storing a PR flag', async () => {
		await store.put('d_beads_web', BEADS_WEB);

		expect(await store.inspect('d_beads_web')).toEqual({ kind: 'valid', mapping: BEADS_WEB });
		expect(await store.list()).toEqual({ d_beads_web: BEADS_WEB });
	});

	it('treats a missing row as none so File can use the global default', async () => {
		expect(await store.inspect('d_other')).toEqual({ kind: 'none' });
	});

	it('clears a mapping so File returns to the global default', async () => {
		await store.put('d_beads_web', BEADS_WEB);
		expect(await store.delete('d_beads_web')).toBe(true);
		expect(await store.inspect('d_beads_web')).toEqual({ kind: 'none' });
		expect(await store.delete('d_beads_web')).toBe(false);
	});

	it('marks a present but unusable row invalid instead of listing it', async () => {
		await client.execute({
			sql: `INSERT INTO file_checkout_maps (project_id, url, ref, updated_at)
				VALUES (?, ?, ?, ?)`,
			args: ['d_other', 'https://evil.example/repo', 'main', '2026-08-25T00:00:00.000Z']
		});

		expect(await store.inspect('d_other')).toEqual({ kind: 'invalid' });
		expect(await store.list()).toEqual({});
	});
});
