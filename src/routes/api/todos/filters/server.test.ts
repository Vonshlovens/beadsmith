import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requiredPermission, roleCan } from '$lib/server/auth/roles.js';
import { setStateStore, type StateStore } from '$lib/server/state/db.js';
import { GET, PUT } from './+server.js';

let settings: Map<string, string>;

beforeEach(() => {
	settings = new Map();
	const store: StateStore = {
		getSetting: async (key) => settings.get(key),
		setSetting: async (key, value) => void settings.set(key, value)
	};
	setStateStore(store);
});

afterEach(() => setStateStore(undefined));

function put(body: unknown): Promise<Response> {
	const request = new Request('http://localhost/api/todos/filters', {
		method: 'PUT',
		body: JSON.stringify(body)
	});
	return PUT({ request } as unknown as Parameters<typeof PUT>[0]) as Promise<Response>;
}

describe('/api/todos/filters', () => {
	it('is admin-only like the rest of /api/todos', () => {
		for (const method of ['GET', 'PUT']) {
			const permission = requiredPermission(method, '/api/todos/filters');
			expect(roleCan('member', permission!)).toBe(false);
			expect(roleCan('admin', permission!)).toBe(true);
		}
	});

	it('starts empty, saves under todos.filters, and reads back', async () => {
		const empty = (await (await GET({} as never)).json()) as { filters: unknown };
		expect(empty.filters).toEqual({});
		const response = await put({ filters: { soon: 'due:+1w', work: '+beadsmith p1' } });
		expect(response.status).toBe(200);
		expect(JSON.parse(settings.get('todos.filters')!)).toEqual({
			soon: 'due:+1w',
			work: '+beadsmith p1'
		});
		const back = (await (await GET({} as never)).json()) as { filters: unknown };
		expect(back.filters).toEqual({ soon: 'due:+1w', work: '+beadsmith p1' });
	});

	it('refuses junk and overlong values', async () => {
		expect((await put({ filters: { a: 3 } })).status).toBe(400);
		expect((await put({ filters: { a: 'x'.repeat(201) } })).status).toBe(400);
		expect((await put({ nope: 1 })).status).toBe(400);
		expect(settings.has('todos.filters')).toBe(false);
	});

	it('ignores a corrupt stored value', async () => {
		settings.set('todos.filters', '{{');
		const read = (await (await GET({} as never)).json()) as { filters: unknown };
		expect(read.filters).toEqual({});
	});
});
