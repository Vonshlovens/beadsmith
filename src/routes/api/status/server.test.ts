import { describe, expect, it, vi } from 'vitest';
import type { StatusSnapshot } from '$lib/types.js';

const snapshot = {
	mode: 'remote',
	dolt: { configured: true, reachable: true },
	state_db: { ok: true },
	agents: { active: false, count: 0 },
	dispatch: { enabled: true, key_configured: true, armed: true, provider: 'webhook' }
} as StatusSnapshot;

vi.mock('$lib/server/status.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/status.js')>();
	return { ...actual, getStatus: async () => structuredClone(snapshot) };
});

const { GET } = await import('./+server.js');

function call(role: 'admin' | 'member' | undefined) {
	return GET({ locals: { role } } as unknown as Parameters<typeof GET>[0]);
}

describe('GET /api/status', () => {
	it('lets admins launch', async () => {
		const body = (await (await call('admin')).json()) as StatusSnapshot;
		expect(body.dispatch).toMatchObject({ enabled: true, viewer_can_launch: true });
	});

	it('hides launching from members and unknown roles, keeping the rest', async () => {
		for (const role of ['member', undefined] as const) {
			const body = (await (await call(role)).json()) as StatusSnapshot;
			expect(body.dispatch).toMatchObject({
				enabled: false,
				viewer_can_launch: false,
				key_configured: true,
				armed: true
			});
		}
	});
});
