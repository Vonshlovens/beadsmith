import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	githubAppJwt,
	mintGithubRepositoryToken,
	mintTailscaleAuthKey,
	parseGithubRepository,
	readDoltAccount
} from './sandbox-credentials.js';

type Call = { url: string; init: RequestInit };

function fakeFetch(replies: { status?: number; body: unknown }[]) {
	const calls: Call[] = [];
	const fetch_impl = (async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		const reply = replies.shift() ?? { status: 500, body: {} };
		return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
	}) as unknown as typeof fetch;
	return { calls, fetch_impl };
}

describe('mintTailscaleAuthKey', () => {
	it('asks for a single-use, pre-authorized, ephemeral, tagged key', async () => {
		const { calls, fetch_impl } = fakeFetch([
			{ body: { access_token: 'oauth-access' } },
			{ body: { key: 'tskey-auth-abc' } }
		]);
		const key = await mintTailscaleAuthKey({
			client_id: 'cid',
			client_secret: 'csecret',
			tags: ['tag:beads-sandbox'],
			fetch: fetch_impl
		});
		expect(key).toBe('tskey-auth-abc');
		expect(calls[0].url).toBe('https://api.tailscale.com/api/v2/oauth/token');
		expect(String(calls[0].init.body)).toContain('grant_type=client_credentials');
		expect(calls[1].init.headers).toMatchObject({ authorization: 'Bearer oauth-access' });
		expect(JSON.parse(String(calls[1].init.body))).toEqual({
			capabilities: {
				devices: {
					create: {
						reusable: false,
						ephemeral: true,
						preauthorized: true,
						tags: ['tag:beads-sandbox']
					}
				}
			},
			expirySeconds: 600,
			description: 'beadsmith sandbox run'
		});
	});

	it('reports a refusal without the client secret', async () => {
		const { fetch_impl } = fakeFetch([{ status: 401, body: { message: 'csecret is wrong' } }]);
		const attempt = mintTailscaleAuthKey({
			client_id: 'cid',
			client_secret: 'csecret',
			tags: ['tag:x'],
			fetch: fetch_impl
		});
		await expect(attempt).rejects.toThrow('Tailscale refused the request (HTTP 401).');
	});
});

describe('GitHub App tokens', () => {
	const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
	const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

	it('signs a short-lived RS256 app JWT', () => {
		const now = new Date('2026-11-06T12:00:00Z');
		const [header, payload, signature] = githubAppJwt('12345', pem, now).split('.');
		expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toEqual({
			iat: now.getTime() / 1000 - 60,
			exp: now.getTime() / 1000 + 480,
			iss: '12345'
		});
		const verify = createVerify('RSA-SHA256');
		verify.update(`${header}.${payload}`);
		expect(verify.verify(publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
	});

	it('mints a token for one repository with the narrowest permissions', async () => {
		const { calls, fetch_impl } = fakeFetch([
			{ body: { id: 77 } },
			{ body: { token: 'ghs_repo_scoped_token_000000' } }
		]);
		const token = await mintGithubRepositoryToken({
			app_id: '12345',
			private_key: pem,
			repository_url: 'https://github.com/example-org/beads-web.git',
			write: false,
			fetch: fetch_impl
		});
		expect(token).toBe('ghs_repo_scoped_token_000000');
		expect(calls[0].url).toBe('https://api.github.com/repos/example-org/beads-web/installation');
		expect(calls[1].url).toBe('https://api.github.com/app/installations/77/access_tokens');
		expect(JSON.parse(String(calls[1].init.body))).toEqual({
			repositories: ['beads-web'],
			permissions: { contents: 'read', pull_requests: 'read', checks: 'read', statuses: 'read' }
		});
	});

	it('says when the App is not installed on the repository', async () => {
		const { fetch_impl } = fakeFetch([{ status: 404, body: {} }]);
		await expect(
			mintGithubRepositoryToken({
				app_id: '1',
				private_key: pem,
				repository_url: 'https://github.com/example-org/other',
				write: true,
				fetch: fetch_impl
			})
		).rejects.toThrow('The GitHub App is not installed on this repository.');
	});

	it('only accepts plain github.com repository URLs', () => {
		expect(parseGithubRepository('https://github.com/a/b')).toEqual({ owner: 'a', repo: 'b' });
		expect(parseGithubRepository('https://github.com/a/b.git')).toEqual({ owner: 'a', repo: 'b' });
		expect(parseGithubRepository('https://user:pw@github.com/a/b')).toBeUndefined();
		expect(parseGithubRepository('https://github.com/a')).toBeUndefined();
		expect(parseGithubRepository('http://github.com/a/b')).toBeUndefined();
	});
});

describe('readDoltAccount', () => {
	const dir = mkdtempSync(join(tmpdir(), 'bdx-dolt-accounts-'));
	const file = join(dir, 'accounts.json');
	writeFileSync(
		file,
		JSON.stringify({
			beads_web: { user: 'sbx_beads_web', password: 'long-random-password-0001' },
			weak: { user: 'sbx_weak', password: 'short' }
		})
	);

	it('returns the account for a project and fails closed otherwise', async () => {
		expect(await readDoltAccount(file, 'beads_web')).toEqual({
			user: 'sbx_beads_web',
			password: 'long-random-password-0001'
		});
		await expect(readDoltAccount(file, 'missing')).rejects.toMatchObject({ code: 'forbidden' });
		await expect(readDoltAccount(file, 'weak')).rejects.toThrow(/malformed/);
		await expect(readDoltAccount(join(dir, 'nope.json'), 'beads_web')).rejects.toThrow(
			'The sandbox Dolt accounts file could not be read.'
		);
	});
});
