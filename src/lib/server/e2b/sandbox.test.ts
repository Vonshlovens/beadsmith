import { ALL_TRAFFIC, Sandbox } from 'e2b';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	buildSandboxNetwork,
	createSdkDriver,
	type E2bBaseSettings,
	readModelCredential
} from './sandbox.js';

afterEach(() => vi.restoreAllMocks());

const base = { api_key_file: '/run/secrets/e2b', template: 'beadsmith-agent' } as E2bBaseSettings;

describe('SDK sandbox ingress', () => {
	it.each(['mission', 'chat'] as const)(
		'requires a traffic token for a %s while preserving its egress rules',
		async (scope) => {
			const mission = scope === 'mission';
			const model = mission
				? { kind: 'api_key' as const, value: 'test-model-key' }
				: { kind: 'oauth_token' as const, value: 'test-model-token' };
			const network = buildSandboxNetwork(
				mission ? { allow_out: ['*.tailscale.com'] } : {},
				model,
				mission ? 'test-github-token' : undefined
			);
			const create = vi
				.spyOn(Sandbox, 'create')
				.mockResolvedValue({ sandboxId: 'test-sandbox' } as Sandbox);
			const input = {
				template: base.template,
				timeout_ms: 60_000,
				metadata: { beadsmith: '1', scope },
				envs: { IS_SANDBOX: '1' },
				network
			};

			const sandbox = await createSdkDriver(async () => 'test-e2b-key').create(input);

			expect(sandbox.id).toBe('test-sandbox');
			expect(create).toHaveBeenCalledExactlyOnceWith(base.template, {
				apiKey: 'test-e2b-key',
				timeoutMs: 60_000,
				metadata: input.metadata,
				envs: input.envs,
				lifecycle: { onTimeout: 'pause' },
				network: {
					allowPublicTraffic: false,
					allowOut: mission
						? ['api.anthropic.com', 'github.com', 'api.github.com', '*.tailscale.com']
						: ['api.anthropic.com', '*'],
					denyOut: [ALL_TRAFFIC],
					rules: {
						'api.anthropic.com': [
							{
								transform: {
									headers: mission
										? { 'x-api-key': 'test-model-key' }
										: { authorization: 'Bearer test-model-token' }
								}
							}
						],
						...(mission
							? {
									'github.com': [
										{
											transform: {
												headers: {
													authorization: `Basic ${Buffer.from('x-access-token:test-github-token').toString('base64')}`
												}
											}
										}
									],
									'api.github.com': [
										{ transform: { headers: { authorization: 'Bearer test-github-token' } } }
									]
								}
							: {})
					}
				}
			});
		}
	);
});

describe('readModelCredential', () => {
	it('drops whitespace from a token pasted from a wrapped terminal line', async () => {
		const credential = await readModelCredential(
			{ ...base, claude_oauth_token_file: '/run/secrets/claude' },
			async () => 'sk-ant-oat01-abc\n def\n ghi\n'
		);
		expect(credential).toEqual({ kind: 'oauth_token', value: 'sk-ant-oat01-abcdefghi' });
	});

	it('prefers the API key and cleans it the same way', async () => {
		const credential = await readModelCredential(
			{
				...base,
				anthropic_api_key_file: '/run/secrets/anthropic',
				claude_oauth_token_file: '/run/secrets/claude'
			},
			async (path) => (path === '/run/secrets/anthropic' ? ' sk-ant-api03-xyz \n' : 'unused')
		);
		expect(credential).toEqual({ kind: 'api_key', value: 'sk-ant-api03-xyz' });
	});
});
