import { describe, expect, it } from 'vitest';
import {
	checkConfig,
	configClass,
	isAllowedCloudflareAccessServiceToken,
	isLoopbackHost,
	normalizeServiceTokenId,
	readEnv,
	resolveStateDir
} from './env.js';

describe('readEnv', () => {
	it('applies documented defaults when nothing is configured', () => {
		const env = readEnv({ HOME: '/home/tester' });

		expect(env.dolt_port).toBe(3306);
		expect(env.dolt_user).toBe('root');
		expect(env.dolt_configured).toBe(false);
		expect(env.agent_actors).toEqual(['agent']);
		expect(env.dispatch_provider).toBe('none');
		expect(env.dispatch_provider_error).toBeUndefined();
		expect(env.tackle_repositories).toEqual({});
		expect(env.tackle_repositories_error).toBeUndefined();
	});

	it('reads the Dolt server settings', () => {
		const env = readEnv({
			HOME: '/home/tester',
			BEADS_DOLT_SERVER_HOST: '100.64.0.10',
			BEADS_DOLT_SERVER_PORT: '3307',
			BEADS_DOLT_SERVER_USER: 'reader'
		});

		expect(env).toMatchObject({
			dolt_host: '100.64.0.10',
			dolt_port: 3307,
			dolt_user: 'reader',
			dolt_configured: true
		});
	});

	it('never exposes the Dolt password', () => {
		const env = readEnv({
			HOME: '/home/tester',
			BEADS_DOLT_PASSWORD: 'super-secret-value'
		});

		expect(JSON.stringify(env)).not.toContain('super-secret-value');
	});

	it('enables webhook dispatch without exposing the shared secret', () => {
		const env = readEnv({
			HOME: '/home/tester',
			BDX_DISPATCH_PROVIDER: 'webhook',
			BDX_DISPATCH_WEBHOOK_URL: 'https://runner.example.com/beadsmith',
			BDX_DISPATCH_WEBHOOK_SECRET: 'runner-secret-value-'.repeat(2)
		});

		expect(env.dispatch_provider).toBe('webhook');
		expect(JSON.stringify(env)).not.toContain('runner-secret-value');
	});

	it('loads Tackle repository maps without treating them as browser input', () => {
		const env = readEnv({
			HOME: '/home/tester',
			BDX_TACKLE_REPOSITORIES: JSON.stringify({
				d_beads_web: {
					url: 'https://github.com/example-org/beads-web',
					ref: 'main',
					auto_create_pr: true
				}
			})
		});

		expect(env.tackle_repositories.d_beads_web).toEqual({
			url: 'https://github.com/example-org/beads-web',
			ref: 'main',
			auto_create_pr: true
		});
		expect(env.tackle_repositories_error).toBeUndefined();
	});

	it('marks invalid Tackle maps so enqueue can fail closed', () => {
		const env = readEnv({
			HOME: '/home/tester',
			BDX_TACKLE_REPOSITORIES: '{"d_beads_web":{"url":"https://evil.example/repo"}}'
		});

		expect(env.tackle_repositories).toEqual({});
		expect(env.tackle_repositories_error).toBe('invalid');
	});

	it('falls back to the default port when the value is not a positive integer', () => {
		const env = readEnv({
			HOME: '/home/tester',
			BEADS_DOLT_SERVER_PORT: 'not-a-port'
		});

		expect(env.dolt_port).toBe(3306);
	});

	it('splits comma lists and lowercases allowed hosts', () => {
		const env = readEnv({
			HOME: '/home/tester',
			BDX_ALLOWED_HOSTS: 'Beads.Local, other.test ,'
		});

		expect(env.allowed_hosts).toEqual(['beads.local', 'other.test']);
	});

	it('reads Cloudflare Access issuer and audience as a pair', () => {
		const env = readEnv({
			HOME: '/home/tester',
			BDX_CF_ACCESS_ISSUER: 'https://beads.cloudflareaccess.com',
			BDX_CF_ACCESS_AUDIENCE: 'application-audience'
		});

		expect(env.cloudflare_access).toEqual({
			issuer: 'https://beads.cloudflareaccess.com',
			audience: 'application-audience',
			allowed_service_token_ids: []
		});
		expect(env.cloudflare_access_issuer_host).toBe('beads.cloudflareaccess.com');
		expect(env.cloudflare_access_audience_configured).toBe(true);
	});

	it('marks a service-token allowlist without issuer and audience incomplete', () => {
		const env = readEnv({
			HOME: '/home/tester',
			BDX_CF_ACCESS_ALLOWED_SERVICE_TOKEN_IDS: '0123456789abcdef0123456789abcdef'
		});

		expect(env.cloudflare_access).toBeUndefined();
		expect(env.cloudflare_access_error).toBe('incomplete');
		expect(env.cloudflare_access_audience_configured).toBe(false);
	});

	it('omits a non-Cloudflare issuer host instead of leaking a JWKS URL', () => {
		const env = readEnv({
			HOME: '/home/tester',
			BDX_CF_ACCESS_ISSUER: 'https://evil.example/cdn-cgi/access/certs',
			BDX_CF_ACCESS_AUDIENCE: 'application-audience'
		});

		expect(env.cloudflare_access_issuer_host).toBeUndefined();
		expect(env.cloudflare_access?.issuer).toBe('https://evil.example/cdn-cgi/access/certs');
	});

	it('reads a Cloudflare Access service-token Client ID allowlist', () => {
		const env = readEnv({
			HOME: '/home/tester',
			BDX_CF_ACCESS_ISSUER: 'https://beads.cloudflareaccess.com',
			BDX_CF_ACCESS_AUDIENCE: 'application-audience',
			BDX_CF_ACCESS_ALLOWED_SERVICE_TOKEN_IDS: ' 0123456789abcdef0123456789abcdef '
		});

		expect(env.cloudflare_access?.allowed_service_token_ids).toEqual([
			'0123456789abcdef0123456789abcdef'
		]);
		expect(JSON.stringify(env)).not.toContain('secret');
	});
});

describe('BDX_PUBLIC_ORIGIN', () => {
	it('is undefined when absent', () => {
		const env = readEnv({ HOME: '/home/tester' });

		expect(env.public_origin).toBeUndefined();
		expect(env.public_origin_error).toBeUndefined();
	});

	it('is undefined when set to an empty string', () => {
		const env = readEnv({ HOME: '/home/tester', BDX_PUBLIC_ORIGIN: '   ' });

		expect(env.public_origin).toBeUndefined();
		expect(env.public_origin_error).toBeUndefined();
	});

	it('parses a bare https origin for a host already in BDX_ALLOWED_HOSTS', () => {
		const env = readEnv({
			HOME: '/home/tester',
			BDX_ALLOWED_HOSTS: 'beads.example.com',
			BDX_PUBLIC_ORIGIN: 'https://beads.example.com'
		});

		expect(env.public_origin).toEqual({
			hostname: 'beads.example.com',
			origin: 'https://beads.example.com'
		});
		expect(env.public_origin_error).toBeUndefined();
	});

	it('fails closed on a malformed value', () => {
		const cases = [
			'not-a-url',
			'ftp://beads.example.com',
			'https://beads.example.com/some/path',
			'https://beads.example.com?query=1',
			'https://beads.example.com#frag',
			'https://user:pass@beads.example.com' // trufflehog:ignore (fixture)
		];

		for (const raw of cases) {
			const env = readEnv({
				HOME: '/home/tester',
				BDX_ALLOWED_HOSTS: 'beads.example.com',
				BDX_PUBLIC_ORIGIN: raw
			});

			expect(env.public_origin, raw).toBeUndefined();
			expect(env.public_origin_error, raw).toBe('invalid');
		}
	});

	it('fails closed when the hostname is not in BDX_ALLOWED_HOSTS', () => {
		const env = readEnv({
			HOME: '/home/tester',
			BDX_ALLOWED_HOSTS: 'other.example.com',
			BDX_PUBLIC_ORIGIN: 'https://beads.example.com'
		});

		expect(env.public_origin_error).toBe('host_not_allowed');
	});
});

describe('resolveStateDir', () => {
	it('prefers BDX_STATE_DIR', () => {
		const dir = resolveStateDir({
			HOME: '/home/tester',
			BDX_STATE_DIR: '/tmp/bdx-state'
		});

		expect(dir).toBe('/tmp/bdx-state');
	});

	it('uses XDG_STATE_HOME when set', () => {
		const dir = resolveStateDir({
			HOME: '/home/tester',
			XDG_STATE_HOME: '/home/tester/.state'
		});

		expect(dir).toBe('/home/tester/.state/beads-web');
	});

	it('falls back to ~/.local/state/beads-web', () => {
		const dir = resolveStateDir({ HOME: '/home/tester' });

		expect(dir).toBe('/home/tester/.local/state/beads-web');
	});
});

describe('checkConfig', () => {
	it('accepts any bind once a Dolt server is configured', () => {
		for (const HOST of ['127.0.0.1', '0.0.0.0', undefined]) {
			const env = readEnv({ HOME: '/h', HOST, BEADS_DOLT_SERVER_HOST: 'dolt.internal' });

			expect(checkConfig(env), String(HOST)).toBeUndefined();
		}
	});

	it('accepts a public allowed host without Cloudflare Access', () => {
		const env = readEnv({
			HOME: '/h',
			BEADS_DOLT_SERVER_HOST: 'dolt.internal',
			BDX_ALLOWED_HOSTS: 'beads.example.com'
		});

		expect(env.cloudflare_access_error).toBeUndefined();
		expect(checkConfig(env)).toBeUndefined();
	});

	it('refuses to run without a remote Dolt server', () => {
		const env = readEnv({ HOME: '/h' });

		expect(checkConfig(env)).toMatch(/remote service requires/);
	});

	it('refuses an Access issuer without an audience', () => {
		const env = readEnv({
			HOME: '/h',
			BEADS_DOLT_SERVER_HOST: 'dolt.internal',
			BDX_CF_ACCESS_ISSUER: 'https://beads.cloudflareaccess.com'
		});

		expect(checkConfig(env)).toMatch(/issuer and audience must be configured together/);
	});

	it('refuses an invalid Cloudflare Access service-token allowlist', () => {
		const env = readEnv({
			HOME: '/h',
			BEADS_DOLT_SERVER_HOST: 'dolt.internal',
			BDX_CF_ACCESS_ISSUER: 'https://beads.cloudflareaccess.com',
			BDX_CF_ACCESS_AUDIENCE: 'application-audience',
			BDX_CF_ACCESS_ALLOWED_SERVICE_TOKEN_IDS: 'not a client id'
		});

		expect(env.cloudflare_access).toBeUndefined();
		expect(checkConfig(env)).toMatch(/service-token allowlist is invalid/);
	});

	it('refuses a malformed BDX_PUBLIC_ORIGIN', () => {
		const env = readEnv({
			HOME: '/h',
			BEADS_DOLT_SERVER_HOST: 'dolt.internal',
			BDX_ALLOWED_HOSTS: 'beads.example.com',
			BDX_PUBLIC_ORIGIN: 'https://beads.example.com/extra'
		});

		expect(checkConfig(env)).toMatch(/BDX_PUBLIC_ORIGIN must be an absolute/);
	});

	it('refuses a BDX_PUBLIC_ORIGIN hostname absent from BDX_ALLOWED_HOSTS', () => {
		const env = readEnv({
			HOME: '/h',
			BEADS_DOLT_SERVER_HOST: 'dolt.internal',
			BDX_ALLOWED_HOSTS: 'other.example.com',
			BDX_PUBLIC_ORIGIN: 'https://beads.example.com'
		});

		expect(checkConfig(env)).toMatch(/BDX_PUBLIC_ORIGIN hostname must be included/);
	});

	it('accepts a complete public origin alongside complete Access config', () => {
		const env = readEnv({
			HOME: '/h',
			BEADS_DOLT_SERVER_HOST: 'dolt.internal',
			BDX_ALLOWED_HOSTS: 'beads.example.com',
			BDX_CF_ACCESS_ISSUER: 'https://beads.cloudflareaccess.com',
			BDX_CF_ACCESS_AUDIENCE: 'application-audience',
			BDX_PUBLIC_ORIGIN: 'https://beads.example.com'
		});

		expect(checkConfig(env)).toBeUndefined();
	});
});

describe('configClass', () => {
	it('maps each failure onto a console class', () => {
		const dolt = { HOME: '/h', BEADS_DOLT_SERVER_HOST: 'dolt.internal' };
		expect(configClass(readEnv(dolt))).toBe('ok');
		expect(configClass(readEnv({ HOME: '/h' }))).toBe('dolt_unconfigured');
		expect(
			configClass(readEnv({ ...dolt, BDX_CF_ACCESS_ISSUER: 'https://beads.cloudflareaccess.com' }))
		).toBe('incomplete');
		expect(
			configClass(
				readEnv({
					...dolt,
					BDX_CF_ACCESS_ISSUER: 'https://beads.cloudflareaccess.com',
					BDX_CF_ACCESS_AUDIENCE: 'application-audience',
					BDX_CF_ACCESS_ALLOWED_SERVICE_TOKEN_IDS: 'nope'
				})
			)
		).toBe('invalid_service_token_id');
		expect(
			configClass(
				readEnv({
					...dolt,
					BDX_ALLOWED_HOSTS: 'beads.example.com',
					BDX_PUBLIC_ORIGIN: 'https://beads.example.com/extra'
				})
			)
		).toBe('public_origin_error');
	});
});

describe('Cloudflare Access service-token allowlist', () => {
	it('accepts a Client ID identifier and rejects emails, URLs, and short junk', () => {
		expect(normalizeServiceTokenId(' 0123456789abcdef0123456789abcdef ')).toBe(
			'0123456789abcdef0123456789abcdef'
		);
		expect(normalizeServiceTokenId('admin@example.com')).toBeUndefined();
		expect(normalizeServiceTokenId('https://example.com/token')).toBeUndefined();
		expect(normalizeServiceTokenId('short')).toBeUndefined();
	});

	it('requires an exact Client ID match and fails closed on an empty allowlist', () => {
		const allowlist = ['0123456789abcdef0123456789abcdef'];
		expect(
			isAllowedCloudflareAccessServiceToken('0123456789abcdef0123456789abcdef', allowlist)
		).toBe(true);
		expect(
			isAllowedCloudflareAccessServiceToken('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', allowlist)
		).toBe(false);
		expect(isAllowedCloudflareAccessServiceToken('0123456789abcdef0123456789abcdef', [])).toBe(
			false
		);
		expect(isAllowedCloudflareAccessServiceToken(undefined, allowlist)).toBe(false);
	});
});

describe('isLoopbackHost', () => {
	it('recognises the loopback aliases', () => {
		expect(isLoopbackHost('localhost')).toBe(true);
		expect(isLoopbackHost('127.0.0.1')).toBe(true);
		expect(isLoopbackHost('::1')).toBe(true);
		expect(isLoopbackHost('0.0.0.0')).toBe(false);
	});
});
