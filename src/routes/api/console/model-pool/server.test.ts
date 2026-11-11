import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '#lib/server/env.js';
import { requiredPermission, roleCan } from '#lib/server/auth/roles.js';
import { setUnderclassClient, UnderclassError } from '#lib/server/underclass/client.js';
import {
	CLAUDE_EMAIL,
	monitorFixture,
	stateFixture,
	statsFixture,
	usageFixture
} from '#lib/server/underclass/fixtures.js';
import { toPoolSnapshot } from '#lib/server/underclass/client.js';
import type { DoltFailureKind } from '#lib/types.js';
import { GET } from './+server.js';

const KEYS = ['BDX_UNDERCLASS_URL', 'BDX_UNDERCLASS_UI_TOKEN_FILE'] as const;
const saved: Partial<Record<(typeof KEYS)[number], string>> = {};

function get(): ReturnType<typeof GET> {
	return GET({
		request: new Request('http://localhost/api/console/model-pool')
	} as unknown as Parameters<typeof GET>[0]);
}

function configure(url?: string, token_file?: string): void {
	for (const [key, value] of [
		['BDX_UNDERCLASS_URL', url],
		['BDX_UNDERCLASS_UI_TOKEN_FILE', token_file]
	] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	resetEnvCache();
}

beforeEach(() => {
	for (const key of KEYS) saved[key] = process.env[key];
});

afterEach(() => {
	for (const key of KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
	resetEnvCache();
	setUnderclassClient(undefined);
});

describe('/api/console/model-pool', () => {
	it('is admin-only, reads included', () => {
		const permission = requiredPermission('GET', '/api/console/model-pool');
		expect(permission).toEqual({ console: ['manage'] });
		expect(roleCan('admin', permission!)).toBe(true);
		expect(roleCan('member', permission!)).toBe(false);
		expect(roleCan(undefined, permission!)).toBe(false);
	});

	it('reports the feature off without settings, and names a half-configured one', async () => {
		configure();
		expect(await (await get()).json()).toEqual({ configured: false });
		configure('https://underclass.example');
		expect(await (await get()).json()).toEqual({
			configured: false,
			config_error: 'token_file_missing'
		});
		configure('http://underclass.example', '/run/secrets/token');
		expect(await (await get()).json()).toEqual({ configured: false, config_error: 'url_invalid' });
	});

	it('returns the pool for an admin', async () => {
		configure('https://underclass.example', '/run/secrets/token');
		setUnderclassClient({
			snapshot: async () =>
				toPoolSnapshot({
					monitor: monitorFixture(),
					state: stateFixture(),
					usage: usageFixture(),
					stats: statsFixture()
				})
		});
		const response = await get();
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		const body = await response.json();
		expect(body.configured).toBe(true);
		expect(body.pool.accounts[0].label).toBe(CLAUDE_EMAIL);
	});

	it('answers each failure class with a 503 and a fixed message', async () => {
		configure('https://underclass.example', '/run/secrets/token');
		const kinds: DoltFailureKind[] = [
			'credential_unavailable',
			'authentication_rejected',
			'unreachable',
			'unknown'
		];
		for (const kind of kinds) {
			setUnderclassClient({
				snapshot: async () => {
					throw new UnderclassError(kind);
				}
			});
			const response = await get();
			expect(response.status).toBe(503);
			const body = await response.json();
			expect(body.error).toEqual({
				code: 'unavailable',
				message: new UnderclassError(kind).message,
				failure_kind: kind
			});
		}
	});

	it('collapses an unexpected error without leaking its text', async () => {
		configure('https://underclass.example', '/run/secrets/token');
		setUnderclassClient({
			snapshot: async () => {
				throw new Error(`token file /run/secrets/token for ${CLAUDE_EMAIL}`);
			}
		});
		const response = await get();
		expect(response.status).toBe(503);
		const text = await response.text();
		expect(text).not.toContain('/run/secrets');
		expect(text).not.toContain(CLAUDE_EMAIL);
	});
});
