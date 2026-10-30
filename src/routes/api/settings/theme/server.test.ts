import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setStateStore, type StateStore } from '$lib/server/state/db.js';
import type { ApiErrorBody } from '$lib/types.js';
import { POST } from './+server.js';

let settings: Map<string, string>;

/** State store stub: only the settings pair is exercised here. */
function fakeStore(): StateStore {
	return {
		getSetting: async (key: string) => settings.get(key),
		setSetting: async (key: string, value: string) => {
			settings.set(key, value);
		}
	};
}

/**
 * Invoke the handler with a JSON body.
 * @param body Raw body text.
 */
async function post(body: string): Promise<Response> {
	const request = new Request('http://localhost/api/settings/theme', { method: 'POST', body });
	return POST({ request } as unknown as Parameters<typeof POST>[0]) as Promise<Response>;
}

beforeEach(() => {
	settings = new Map<string, string>();
	setStateStore(fakeStore());
});

afterEach(() => {
	setStateStore(undefined);
});

describe('POST /api/settings/theme', () => {
	it('stores each accepted preference under ui.theme', async () => {
		for (const theme of ['system', 'light', 'dark']) {
			const response = await post(JSON.stringify({ theme }));

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ theme });
			expect(settings.get('ui.theme')).toBe(theme);
		}
	});

	it('rejects an unknown theme without writing', async () => {
		const response = await post(JSON.stringify({ theme: 'solarized' }));

		expect(response.status).toBe(400);
		expect(((await response.json()) as ApiErrorBody).error.code).toBe('bad_request');
		expect(settings.size).toBe(0);
	});

	it('rejects a non-string theme, a missing field, and a bad body', async () => {
		expect((await post(JSON.stringify({ theme: 1 }))).status).toBe(400);
		expect((await post(JSON.stringify({}))).status).toBe(400);
		expect((await post('not json')).status).toBe(400);
		expect(settings.size).toBe(0);
	});

	it('is case-sensitive', async () => {
		const response = await post(JSON.stringify({ theme: 'Dark' }));

		expect(response.status).toBe(400);
	});

	it('reports a store failure as unavailable', async () => {
		setStateStore({
			...fakeStore(),
			setSetting: async () => {
				throw new Error('state db is read-only');
			}
		});

		const response = await post(JSON.stringify({ theme: 'dark' }));

		expect(response.status).toBe(503);
		expect(((await response.json()) as ApiErrorBody).error.code).toBe('unavailable');
	});
});
