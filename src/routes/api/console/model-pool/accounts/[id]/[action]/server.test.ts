import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '#lib/server/env.js';
import { requiredPermission, roleCan } from '#lib/server/auth/roles.js';
import {
	setUnderclassClient,
	UnderclassAccountNotFound,
	UnderclassError,
	type UnderclassClient
} from '#lib/server/underclass/client.js';
import { CLAUDE_EMAIL } from '#lib/server/underclass/fixtures.js';
import type { ModelPoolAction } from '#lib/types.js';
import { _setActionLog, POST } from './+server.js';

const KEYS = ['BDX_UNDERCLASS_URL', 'BDX_UNDERCLASS_UI_TOKEN_FILE'] as const;
const saved: Partial<Record<(typeof KEYS)[number], string>> = {};
const USER = { id: 'user-1', email: 'admin@example.com' };

let lines: string[] = [];
let calls: { id: string; action: ModelPoolAction; force: boolean }[] = [];

function post(
	id: string,
	action: string,
	body?: string,
	user: typeof USER | null = USER
): ReturnType<typeof POST> {
	return POST({
		params: { id, action },
		request: new Request(`http://localhost/api/console/model-pool/accounts/${id}/${action}`, {
			method: 'POST',
			body
		}),
		locals: { user: user ?? undefined }
	} as unknown as Parameters<typeof POST>[0]);
}

function configure(on: boolean): void {
	if (on) {
		process.env.BDX_UNDERCLASS_URL = 'https://underclass.example';
		process.env.BDX_UNDERCLASS_UI_TOKEN_FILE = '/run/secrets/token';
	} else {
		for (const key of KEYS) delete process.env[key];
	}
	resetEnvCache();
}

function useClient(act: UnderclassClient['act']): void {
	setUnderclassClient({
		snapshot: async () => {
			throw new Error('not called');
		},
		act: async (id, action, options) => {
			calls.push({ id, action, force: options?.force === true });
			return act(id, action, options);
		}
	});
}

beforeEach(() => {
	for (const key of KEYS) saved[key] = process.env[key];
	lines = [];
	calls = [];
	_setActionLog((line) => lines.push(line));
	configure(true);
});

afterEach(() => {
	for (const key of KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
	resetEnvCache();
	setUnderclassClient(undefined);
	_setActionLog(undefined);
});

describe('POST /api/console/model-pool/accounts/:id/:action', () => {
	it('is admin-only', () => {
		const permission = requiredPermission(
			'POST',
			'/api/console/model-pool/accounts/acct-codex/disable'
		);
		expect(permission).toEqual({ console: ['manage'] });
		expect(roleCan('admin', permission!)).toBe(true);
		expect(roleCan('member', permission!)).toBe(false);
	});

	it('needs a session', async () => {
		useClient(async () => {
			throw new Error('not called');
		});
		const response = await post('acct-codex', 'disable', undefined, null);
		expect(response.status).toBe(401);
		expect(calls).toEqual([]);
	});

	it('runs each action and records the actor and account id, not the label', async () => {
		useClient(async (account_id, action) => ({
			outcome: 'done',
			action,
			account_id,
			status: action === 'disable' ? 'disabled' : 'healthy',
			banked_resets: null
		}));
		for (const action of ['refresh', 'enable', 'disable', 'reset']) {
			const response = await post('acct-codex', action);
			expect(response.status).toBe(200);
			expect(response.headers.get('cache-control')).toBe('no-store');
			expect((await response.json()).outcome).toBe('done');
		}
		expect(calls.map((call) => call.action)).toEqual(['refresh', 'enable', 'disable', 'reset']);
		expect(lines).toEqual([
			'model pool: user user-1 refresh account acct-codex: done',
			'model pool: user user-1 enable account acct-codex: done',
			'model pool: user user-1 disable account acct-codex: done',
			'model pool: user user-1 reset account acct-codex: done'
		]);
		expect(lines.join('\n')).not.toContain('@');
	});

	it('passes force on a reset and logs it', async () => {
		useClient(async (account_id, action) => ({
			outcome: 'done',
			action,
			account_id,
			status: 'healthy',
			banked_resets: 0
		}));
		expect((await post('acct-codex', 'reset', '{"force":true}')).status).toBe(200);
		expect(calls).toEqual([{ id: 'acct-codex', action: 'reset', force: true }]);
		expect(lines).toEqual(['model pool: user user-1 reset (forced) account acct-codex: done']);
	});

	it('rejects unknown actions, unsafe ids and stray body fields before calling Underclass', async () => {
		useClient(async () => {
			throw new Error('not called');
		});
		const bad: [string, string, string?][] = [
			['acct-codex', 'relogin'],
			['acct-codex', 'client-key'],
			['acct-codex', 'delete'],
			['..', 'disable'],
			['a.b', 'disable'],
			['acct%2Fx', 'disable'],
			['acct-codex', 'disable', '{"force":true}'],
			['acct-codex', 'reset', '{"force":"yes"}'],
			['acct-codex', 'reset', '{"path":"/admin/api/client-key"}'],
			['acct-codex', 'reset', 'not json']
		];
		for (const [id, action, body] of bad) {
			const response = await post(id, action, body);
			expect(response.status, `${id} ${action} ${body}`).toBe(400);
		}
		expect(calls).toEqual([]);
		expect(lines).toEqual([]);
	});

	it('answers a refusal as a 200 with its code', async () => {
		useClient(async (account_id, action) => ({
			outcome: 'refused',
			action,
			account_id,
			refusal: 'not_rate_limited',
			can_force: true
		}));
		const response = await post('acct-codex', 'reset');
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			outcome: 'refused',
			action: 'reset',
			account_id: 'acct-codex',
			refusal: 'not_rate_limited',
			can_force: true
		});
		expect(lines).toEqual([
			'model pool: user user-1 reset account acct-codex: refused (not_rate_limited)'
		]);
	});

	it('answers 404 for an account Underclass does not know', async () => {
		useClient(async () => {
			throw new UnderclassAccountNotFound();
		});
		const response = await post('acct-gone', 'disable');
		expect(response.status).toBe(404);
		expect((await response.json()).error.code).toBe('not_found');
	});

	it('answers 503 with a fixed message when Underclass fails, without leaking text', async () => {
		for (const kind of ['unreachable', 'authentication_rejected'] as const) {
			useClient(async () => {
				throw new UnderclassError(kind);
			});
			const response = await post('acct-codex', 'refresh');
			expect(response.status).toBe(503);
			expect((await response.json()).error).toEqual({
				code: 'unavailable',
				message: new UnderclassError(kind).message,
				failure_kind: kind
			});
		}
		useClient(async () => {
			throw new Error(`upstream said no for ${CLAUDE_EMAIL} at /run/secrets/token`);
		});
		const response = await post('acct-codex', 'refresh');
		expect(response.status).toBe(503);
		const text = await response.text();
		expect(text).not.toContain(CLAUDE_EMAIL);
		expect(text).not.toContain('/run/secrets');
		expect(lines.at(-1)).toBe('model pool: user user-1 refresh account acct-codex: failed');
	});

	it('answers 409 when the model pool is not connected', async () => {
		configure(false);
		useClient(async () => {
			throw new Error('not called');
		});
		const response = await post('acct-codex', 'disable');
		expect(response.status).toBe(409);
		expect(calls).toEqual([]);
	});
});
