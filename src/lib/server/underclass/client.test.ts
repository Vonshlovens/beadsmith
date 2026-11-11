import { describe, expect, it } from 'vitest';
import {
	createUnderclassClient,
	toPoolSnapshot,
	UNDERCLASS_READ_ROUTES,
	UnderclassError,
	type UnderclassClientDeps
} from './client.js';
import {
	CLAUDE_EMAIL,
	monitorFixture,
	NOW_MS,
	STICKY_KEY,
	stateFixture,
	statsFixture,
	usageFixture
} from './fixtures.js';

const settings = {
	origin: 'https://underclass.example:8443',
	ui_token_file: '/run/secrets/underclass-ui-token'
};
const TOKEN = 'ui-token-value';

const fixtures: Record<string, () => unknown> = {
	[UNDERCLASS_READ_ROUTES.monitor]: monitorFixture,
	[UNDERCLASS_READ_ROUTES.state]: stateFixture,
	[UNDERCLASS_READ_ROUTES.usage]: usageFixture,
	[UNDERCLASS_READ_ROUTES.stats]: statsFixture
};

interface Call {
	url: string;
	init: RequestInit;
}

/** A fake Underclass: serves the fixtures to the right bearer, records every call. */
function fakeServer(override?: (path: string) => Response | undefined): {
	calls: Call[];
	fetch: typeof fetch;
} {
	const calls: Call[] = [];
	const fake = async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const url = String(input);
		calls.push({ url, init });
		const parsed = new URL(url);
		const path = `${parsed.pathname}${parsed.search}`;
		const custom = override?.(path);
		if (custom) return custom;
		if ((init.headers as Record<string, string>).authorization !== `Bearer ${TOKEN}`) {
			return new Response('unauthorized', { status: 401 });
		}
		const body = fixtures[path];
		return body
			? new Response(JSON.stringify(body()), { headers: { 'content-type': 'application/json' } })
			: new Response('not found', { status: 404 });
	};
	return { calls, fetch: fake as typeof fetch };
}

function client(deps: UnderclassClientDeps = {}) {
	return createUnderclassClient(settings, { readToken: async () => `${TOKEN}\n`, ...deps });
}

async function failure(promise: Promise<unknown>): Promise<UnderclassError> {
	const error = await promise.then(
		() => undefined,
		(caught: unknown) => caught
	);
	expect(error).toBeInstanceOf(UnderclassError);
	return error as UnderclassError;
}

describe('Underclass client', () => {
	it('calls exactly the four read routes on the configured origin, with the bearer', async () => {
		const server = fakeServer();
		await client({ fetch: server.fetch }).snapshot();
		expect(server.calls.map((call) => call.url).sort()).toEqual(
			[
				'https://underclass.example:8443/admin/api/monitor',
				'https://underclass.example:8443/admin/api/state',
				'https://underclass.example:8443/admin/api/stats?since=24h&bucket=hour',
				'https://underclass.example:8443/admin/api/usage?group_by=model'
			].sort()
		);
		for (const call of server.calls) {
			expect(call.init.method).toBe('GET');
			expect(call.init.redirect).toBe('manual');
			expect(call.init.body).toBeUndefined();
			expect((call.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
		}
	});

	it('never names a write or secret-bearing route', () => {
		const routes = Object.values(UNDERCLASS_READ_ROUTES).join(' ');
		for (const forbidden of [
			'client-key',
			'flows',
			'relogin',
			'catalog',
			'events/import',
			'accounts'
		]) {
			expect(routes).not.toContain(forbidden);
		}
	});

	it('maps the fixtures to the typed view', async () => {
		const pool = await client({ fetch: fakeServer().fetch }).snapshot();
		expect(pool.observed_at).toBe(new Date(NOW_MS).toISOString());
		expect(pool.in_flight).toBe(3);
		expect(pool.month).toEqual({
			attempts: 130,
			unmeasured: 1,
			input_tokens: 54_000,
			output_tokens: 9_800
		});
		const [claude, codex] = pool.accounts;
		expect(claude).toMatchObject({
			id: 'acct-claude',
			label: CLAUDE_EMAIL,
			backend: 'claude',
			plan: 'max',
			status: 'cooling',
			cooling_until: new Date(NOW_MS + 30 * 60_000).toISOString(),
			in_flight: 2,
			banked_resets: 2
		});
		expect(claude.windows.map((window) => [window.name, window.used_fraction])).toEqual([
			['five_hour', 1],
			['seven_day', 0.42]
		]);
		expect(codex).toMatchObject({ status: 'healthy', cooling_until: null, banked_resets: 1 });
		expect(codex.windows).toEqual([
			{
				name: 'primary',
				used_fraction: 0.25,
				resets_at: new Date(Math.floor((NOW_MS + 3_600_000) / 1000) * 1000).toISOString(),
				window_seconds: 18_000
			}
		]);
		expect(pool.month_by_model).toEqual([
			{
				model: 'claude-opus',
				requests: 120,
				unmeasured: 1,
				input_tokens: 50_000,
				output_tokens: 9_000
			}
		]);
		expect(pool.day).toMatchObject({
			requests: 40,
			outcomes: { completed: 40, http_429: 1 },
			events: { overloaded: 1 }
		});
		expect(pool.day.hours).toHaveLength(2);
		expect(pool.recent[0]).toEqual({
			at: new Date(NOW_MS - 1_000).toISOString(),
			model: 'claude-opus',
			backend: 'claude',
			account_label: CLAUDE_EMAIL,
			status: 200,
			duration_ms: 900,
			outcome: 'completed',
			error_code: null
		});
		expect(pool.recent[1]).toMatchObject({ status: 503, error_code: 'pool_saturated' });
	});

	it('drops request ids, sticky keys, raw account ids in logs and the catalog', async () => {
		const text = JSON.stringify(await client({ fetch: fakeServer().fetch }).snapshot());
		for (const leaked of [
			STICKY_KEY,
			'req-should-not-appear',
			'catalog-entry-should-not-appear',
			TOKEN
		]) {
			expect(text).not.toContain(leaked);
		}
	});

	it('treats an unreadable, empty or malformed token file as credential_unavailable', async () => {
		const server = fakeServer();
		for (const readToken of [
			async () => {
				throw new Error('ENOENT /run/secrets/underclass-ui-token');
			},
			async () => '\n',
			async () => 'two\nlines'
		]) {
			const error = await failure(client({ fetch: server.fetch, readToken }).snapshot());
			expect(error.kind).toBe('credential_unavailable');
			expect(error.message).not.toContain('/run/secrets');
		}
		expect(server.calls).toHaveLength(0);
	});

	it('classes 401 and 403 as authentication_rejected', async () => {
		for (const status of [401, 403]) {
			const server = fakeServer(() => new Response('nope', { status }));
			expect((await failure(client({ fetch: server.fetch }).snapshot())).kind).toBe(
				'authentication_rejected'
			);
		}
		const wrong = await failure(
			client({ fetch: fakeServer().fetch, readToken: async () => 'wrong' }).snapshot()
		);
		expect(wrong.kind).toBe('authentication_rejected');
	});

	it('classes network errors, timeouts and gateway errors as unreachable', async () => {
		const refused = (async () => {
			throw new TypeError('fetch failed: connect ECONNREFUSED 100.64.0.1:8443');
		}) as typeof fetch;
		const error = await failure(client({ fetch: refused }).snapshot());
		expect(error.kind).toBe('unreachable');
		expect(error.message).not.toContain('100.64');

		const hang = ((_: RequestInfo | URL, init: RequestInit = {}) =>
			new Promise<Response>((_resolve, reject) => {
				init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
			})) as typeof fetch;
		expect((await failure(client({ fetch: hang, timeout_ms: 5 }).snapshot())).kind).toBe(
			'unreachable'
		);

		for (const status of [502, 503, 504]) {
			const server = fakeServer(() => new Response('', { status }));
			expect((await failure(client({ fetch: server.fetch }).snapshot())).kind).toBe('unreachable');
		}
	});

	it('classes redirects, other statuses and unexpected shapes as unknown', async () => {
		const cases: ((path: string) => Response | undefined)[] = [
			() =>
				new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } }),
			() => new Response('boom', { status: 500 }),
			() => new Response('not json', { status: 200 }),
			(path) =>
				path === UNDERCLASS_READ_ROUTES.monitor
					? new Response(JSON.stringify({ accounts: 'nope' }), { status: 200 })
					: undefined
		];
		for (const override of cases) {
			const server = fakeServer(override);
			expect((await failure(client({ fetch: server.fetch }).snapshot())).kind).toBe('unknown');
		}
	});

	it('shows accounts without a quota report with no windows', () => {
		const monitor = monitorFixture();
		monitor.accounts[0] = {
			...monitor.accounts[0],
			backend: 'copilot',
			observation: null as never
		};
		const pool = toPoolSnapshot({
			monitor,
			state: stateFixture(),
			usage: usageFixture(),
			stats: statsFixture()
		});
		expect(pool.accounts[0]).toMatchObject({
			windows: [],
			banked_resets: null,
			quota_observed_at: null
		});
	});

	it('shows an expired cooldown as no cooldown', () => {
		const monitor = monitorFixture();
		monitor.accounts[0] = { ...monitor.accounts[0], reset_at: NOW_MS - 1 };
		const pool = toPoolSnapshot({
			monitor,
			state: stateFixture(),
			usage: usageFixture(),
			stats: statsFixture()
		});
		expect(pool.accounts[0].cooling_until).toBeNull();
	});
});
