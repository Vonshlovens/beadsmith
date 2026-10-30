import { createClient } from '@libsql/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { initStateSchema } from '../state/db.js';
import { createTackleMapStore, mergeTackleMaps } from './tackle-maps.js';

const BEADS_WEB = {
	url: 'https://github.com/example-org/beads-web',
	ref: 'main',
	auto_create_pr: true
};

const OTHER = {
	url: 'https://github.com/example-org/other',
	ref: 'develop',
	auto_create_pr: false
};

let store: ReturnType<typeof createTackleMapStore>;

beforeEach(async () => {
	const client = createClient({ url: ':memory:' });
	await initStateSchema(client);
	store = createTackleMapStore(client);
});

describe('createTackleMapStore', () => {
	it('round-trips a mapping without storing extra keys', async () => {
		await store.put('d_beads_web', BEADS_WEB);

		expect(await store.get('d_beads_web')).toEqual(BEADS_WEB);
		expect(await store.list()).toEqual({ d_beads_web: BEADS_WEB });
	});

	it('clears a mapping so Tackle can fail closed', async () => {
		await store.put('d_beads_web', BEADS_WEB);
		expect(await store.delete('d_beads_web')).toBe(true);
		expect(await store.get('d_beads_web')).toBeUndefined();
		expect(await store.delete('d_beads_web')).toBe(false);
	});
});

describe('mergeTackleMaps', () => {
	it('lets env override SQLite for the same project', () => {
		const merged = mergeTackleMaps(
			{ mappings: { d_beads_web: BEADS_WEB } },
			{ d_beads_web: OTHER, d_other: OTHER }
		);

		expect(merged.invalid).toBe(false);
		expect(merged.mappings.d_beads_web).toEqual(BEADS_WEB);
		expect(merged.sources.d_beads_web).toBe('env');
		expect(merged.sources.d_other).toBe('sqlite');
	});

	it('fails closed when env/file config is invalid', () => {
		const merged = mergeTackleMaps(
			{ mappings: { d_beads_web: BEADS_WEB }, error: 'invalid' },
			{ d_other: OTHER }
		);

		expect(merged).toEqual({ invalid: true, mappings: {}, sources: {} });
	});
});
