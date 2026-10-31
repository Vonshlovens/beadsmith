import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsoleSnapshot } from '$lib/types.js';
import { GET } from './+server.js';

const mocks = vi.hoisted(() => ({
	getConsoleSnapshot: vi.fn<() => Promise<ConsoleSnapshot>>()
}));

vi.mock('$lib/server/console.js', () => ({
	getConsoleSnapshot: mocks.getConsoleSnapshot
}));

const SNAPSHOT: ConsoleSnapshot = {
	health: {
		dolt: { configured: true, reachable: true, latency_ms: 5 },
		state_db: { ok: true },
		dispatch: { enabled: false, key_configured: false, armed: true }
	},
	coverage: {
		project_count: 1,
		mapped_count: 0,
		unmapped_ids: ['d_beads_web'],
		maps_invalid: false
	},
	projects: [
		{
			id: 'd_beads_web',
			name: 'beads_web',
			tackle: { mapped: false },
			file: { mapped: false },
			allow: { file: true, tackle: true }
		}
	],
	access: {
		audience_configured: false,
		service_token_ids: [],
		allowed_hosts: [],
		policy: 'dolt_unconfigured'
	}
};

beforeEach(() => {
	mocks.getConsoleSnapshot.mockReset();
});

describe('GET /api/console', () => {
	it('returns the redacted operator snapshot', async () => {
		mocks.getConsoleSnapshot.mockResolvedValue(SNAPSHOT);

		const response = await GET({
			locals: {},
			request: new Request('http://localhost/api/console')
		} as unknown as Parameters<typeof GET>[0]);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(SNAPSHOT);
	});
});
