import { describe, expect, it } from 'vitest';
import { type E2bBaseSettings, readModelCredential } from './sandbox.js';

const base = { api_key_file: '/run/secrets/e2b', template: 'beadsmith-agent' } as E2bBaseSettings;

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
