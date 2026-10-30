import { createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '$lib/types.js';
import { readEnv } from '../env.js';
import { initStateSchema } from '../state/db.js';
import { getAgentProvider, type AgentProvider } from './provider.js';
import { cancelDispatch, enqueueDispatch, followUpDispatch, getDispatch } from './service.js';
import { createDispatchStore } from './store.js';
import { DispatchError } from './types.js';
import {
	createWebhookProvider,
	resolveWebhookSecret,
	signWebhookRequest
} from './webhook-provider.js';

const SECRET = 's'.repeat(40);
const WEBHOOK_ENV = readEnv({
	HOME: '/home/tester',
	BDX_DISPATCH_PROVIDER: 'webhook',
	BDX_DISPATCH_WEBHOOK_URL: 'https://runner.example.com/beadsmith/',
	BDX_DISPATCH_WEBHOOK_SECRET: SECRET
});

describe('dispatch provider selection (env)', () => {
	const base = { HOME: '/home/tester' };

	it('defaults to none', () => {
		expect(readEnv(base).dispatch_provider).toBe('none');
		expect(readEnv(base).dispatch_provider_error).toBeUndefined();
	});

	it('honours an explicit choice and explains inactive ones', () => {
		expect(readEnv({ ...base, BDX_DISPATCH_PROVIDER: 'none' })).toMatchObject({
			dispatch_provider: 'none'
		});
		expect(readEnv({ ...base, BDX_DISPATCH_PROVIDER: 'overalls' })).toMatchObject({
			dispatch_provider: 'none',
			dispatch_provider_error: 'invalid'
		});
		expect(WEBHOOK_ENV).toMatchObject({
			dispatch_provider: 'webhook',
			dispatch_webhook_url: 'https://runner.example.com/beadsmith'
		});
	});

	it('requires https (http only on loopback) and a secret for webhooks', () => {
		const webhook = {
			...base,
			BDX_DISPATCH_PROVIDER: 'webhook',
			BDX_DISPATCH_WEBHOOK_SECRET: SECRET
		};
		expect(
			readEnv({ ...webhook, BDX_DISPATCH_WEBHOOK_URL: 'http://runner.example.com' })
		).toMatchObject({
			dispatch_provider: 'none',
			dispatch_provider_error: 'webhook_url_invalid'
		});
		expect(
			readEnv({ ...webhook, BDX_DISPATCH_WEBHOOK_URL: 'http://127.0.0.1:8787' }).dispatch_provider
		).toBe('webhook');
		expect(
			readEnv({ ...webhook, BDX_DISPATCH_WEBHOOK_URL: 'https://u:p@runner.example.com' })
				.dispatch_provider
		).toBe('none');
		expect(
			readEnv({
				...base,
				BDX_DISPATCH_PROVIDER: 'webhook',
				BDX_DISPATCH_WEBHOOK_URL: 'https://runner.example.com'
			})
		).toMatchObject({
			dispatch_provider: 'none',
			dispatch_provider_error: 'webhook_secret_missing'
		});
	});

	it('builds the configured provider', () => {
		expect(getAgentProvider(readEnv(base))).toBeUndefined();
		expect(getAgentProvider(WEBHOOK_ENV)?.id).toBe('webhook');
	});
});

describe('resolveWebhookSecret', () => {
	it('prefers the file and enforces a minimum length', () => {
		const dir = mkdtempSync(join(tmpdir(), 'bsm-webhook-'));
		writeFileSync(join(dir, 'secret'), `${'f'.repeat(40)}\n`);
		expect(resolveWebhookSecret({ BDX_DISPATCH_WEBHOOK_SECRET_FILE: join(dir, 'secret') })).toBe(
			'f'.repeat(40)
		);
		expect(() => resolveWebhookSecret({ BDX_DISPATCH_WEBHOOK_SECRET: 'short' })).toThrow(
			DispatchError
		);
		expect(() =>
			resolveWebhookSecret({ BDX_DISPATCH_WEBHOOK_SECRET_FILE: '/nonexistent' })
		).toThrow(/could not be read/);
	});
});

type Call = { url: string; init: RequestInit };

function runner(responses: Array<{ status: number; body?: unknown }>) {
	const calls: Call[] = [];
	const fetch_impl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
		calls.push({ url: String(url), init: init ?? {} });
		const next = responses.shift() ?? { status: 500 };
		return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
			status: next.status
		});
	});
	const provider = createWebhookProvider({
		server_env: WEBHOOK_ENV,
		fetch: fetch_impl as typeof fetch,
		now: () => new Date('2026-10-17T00:00:00Z'),
		secret: SECRET
	});
	return { provider, calls };
}

describe('webhook provider', () => {
	it('signs timestamp, method, path, and body with HMAC-SHA256', async () => {
		const { provider, calls } = runner([
			{
				status: 201,
				body: { agent_id: 'ag-1', run_id: 'run-1', agent_url: 'https://runner.example.com/a/1' }
			}
		]);
		const launched = await provider.launch({
			name: 'File: login',
			prompt: 'file this',
			auto_create_pr: false,
			repository: { url: 'https://github.com/example-org/beads-web', starting_ref: 'main' }
		});
		expect(launched).toEqual({
			agent_id: 'ag-1',
			run_id: 'run-1',
			agent_url: 'https://runner.example.com/a/1'
		});
		const [{ url, init }] = calls;
		expect(url).toBe('https://runner.example.com/beadsmith/agents');
		const headers = init.headers as Record<string, string>;
		expect(headers['x-beadsmith-timestamp']).toBe('1792195200');
		const body = String(init.body);
		expect(JSON.parse(body)).toMatchObject({
			version: 1,
			name: 'File: login',
			auto_create_pr: false
		});
		const expected = createHmac('sha256', SECRET)
			.update(`1792195200.POST /beadsmith/agents\n${body}`)
			.digest('hex');
		expect(headers['x-beadsmith-signature']).toBe(`v1=${expected}`);
		expect(await signWebhookRequest(SECRET, '1792195200', 'POST', '/beadsmith/agents', body)).toBe(
			`v1=${expected}`
		);
		expect(body).not.toContain(SECRET);
	});

	it('maps run status and sanitizes runner output', async () => {
		const { provider, calls } = runner([
			{
				status: 200,
				body: {
					status: 'succeeded',
					summary: `Done. token ${SECRET} Bearer abc123`,
					duration_ms: 1200,
					pr_url: 'https://github.com/example-org/beads-web/pull/7'
				}
			}
		]);
		const update = await provider.getRun('ag-1', 'run-1');
		expect(calls[0].url).toBe('https://runner.example.com/beadsmith/agents/ag-1/runs/run-1');
		expect(update).toMatchObject({
			status: 'succeeded',
			duration_ms: 1200,
			git_pr_url: 'https://github.com/example-org/beads-web/pull/7'
		});
		expect(update.result_summary).not.toContain(SECRET);
		expect(update.result_summary).toContain('Bearer [redacted]');
	});

	it('rejects unknown statuses, bad ids, and unsafe URLs from the runner', async () => {
		const { provider } = runner([
			{ status: 200, body: { status: 'exploded' } },
			{ status: 201, body: { agent_id: '../etc', run_id: 'r' } },
			{ status: 201, body: { agent_id: 'ag-2', agent_url: 'javascript:alert(1)' } }
		]);
		await expect(provider.getRun('ag-1', 'run-1')).rejects.toThrow(/unknown run status/);
		await expect(
			provider.launch({ name: 'n', prompt: 'p', auto_create_pr: false })
		).rejects.toThrow(/no valid agent_id/);
		expect(await provider.launch({ name: 'n', prompt: 'p', auto_create_pr: false })).toEqual({
			agent_id: 'ag-2',
			run_id: undefined,
			agent_url: undefined
		});
		await expect(provider.getRun('../x', 'run-1')).rejects.toThrow(/Invalid agent id/);
	});

	it('treats 404/501 on optional endpoints as unsupported, other errors as unavailable', async () => {
		const { provider } = runner([{ status: 501 }, { status: 503 }, { status: 404 }]);
		await expect(provider.cancelRun?.('ag-1', 'run-1')).rejects.toMatchObject({
			code: 'forbidden',
			message: 'The webhook runner does not support cancel.'
		});
		await expect(provider.createRun?.('ag-1', 'again')).rejects.toMatchObject({
			code: 'unavailable'
		});
		expect(await provider.getLatestRunId('ag-1')).toBeUndefined();
	});

	it('reports an unreachable runner without details', async () => {
		const provider = createWebhookProvider({
			server_env: WEBHOOK_ENV,
			fetch: (async () => {
				throw new TypeError(`connect ECONNREFUSED ${SECRET}`);
			}) as typeof fetch,
			secret: SECRET
		});
		await expect(provider.getRun('ag-1', 'run-1')).rejects.toThrow(
			'The webhook runner could not be reached.'
		);
	});
});

const PROJECT: Project = {
	id: 'd_beads_web',
	name: 'beads_web',
	state: 'remote',
	dolt_database: 'beads_web',
	backend: 'server-sql',
	readonly: true
};
const ALLOW_ALL = { armed: true, allow: { file: true, tackle: true } };

describe('service routing across providers', () => {
	let client: ReturnType<typeof createClient>;
	let store: ReturnType<typeof createDispatchStore>;

	beforeEach(async () => {
		client = createClient({ url: ':memory:' });
		await initStateSchema(client);
		store = createDispatchStore(client);
	});

	function minimalProvider(): AgentProvider {
		return {
			id: 'webhook',
			label: 'Webhook agent runner',
			launch: vi.fn(async () => ({ agent_id: 'ag-1', run_id: 'run-1' })),
			getLatestRunId: vi.fn(async () => 'run-1'),
			getRun: vi.fn(async () => ({ status: 'succeeded' as const, result_summary: 'ok' }))
		};
	}

	async function launch(provider: AgentProvider) {
		return enqueueDispatch(
			{
				idempotency_key: 'k-1',
				project: PROJECT,
				actor: 'tester',
				payload: { operation: 'file', title: 'Login fails', notes: '' }
			},
			{
				store,
				provider,
				configured: true,
				policy: ALLOW_ALL,
				file_maps: {},
				repositories: {},
				schedule_background: () => {}
			}
		);
	}

	it('records the provider and polls status when it cannot stream', async () => {
		const provider = minimalProvider();
		const { request } = await launch(provider);
		const [record] = await store.list({ limit: 10 });
		expect(record.provider).toBe('webhook');
		const refreshed = await getDispatch(PROJECT.id, request.id, { store, provider });
		expect(refreshed?.status).toBe('succeeded');
		expect(provider.getRun).toHaveBeenCalledWith('ag-1', 'run-1');
	});

	it('refuses cancel and follow-up a provider cannot perform', async () => {
		const provider = minimalProvider();
		provider.getRun = vi.fn(async () => ({ status: 'running' as const }));
		const { request } = await launch(provider);
		await expect(cancelDispatch(PROJECT.id, request.id, { store, provider })).rejects.toMatchObject(
			{
				code: 'forbidden',
				message: 'Webhook agent runner cannot cancel runs.'
			}
		);
		await expect(
			followUpDispatch(PROJECT.id, request.id, 'more', { store, provider, policy: ALLOW_ALL })
		).rejects.toMatchObject({ code: 'forbidden' });
	});

	it('never routes a mission to a different provider than the one that launched it', async () => {
		const { request } = await launch(minimalProvider());
		// A row from a provider this build no longer has.
		await client.execute({
			sql: 'UPDATE dispatch_requests SET provider = ? WHERE id = ?',
			args: ['retired', request.id]
		});
		const webhook = minimalProvider();
		await expect(
			cancelDispatch(PROJECT.id, request.id, { store, provider: webhook })
		).rejects.toThrow(/launched by a provider that is no longer configured/);
		await getDispatch(PROJECT.id, request.id, { store, provider: webhook });
		expect(webhook.getRun).not.toHaveBeenCalled();
	});

	it('refuses to enqueue when no provider is configured', async () => {
		await expect(
			enqueueDispatch(
				{
					idempotency_key: 'k-2',
					project: PROJECT,
					actor: 'tester',
					payload: { operation: 'file', title: 'x', notes: '' }
				},
				{ store, configured: false, policy: ALLOW_ALL }
			)
		).rejects.toMatchObject({
			code: 'forbidden',
			message: 'Agent dispatch is not configured on this service.'
		});
	});
});
