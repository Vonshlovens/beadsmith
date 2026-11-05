import { describe, expect, it } from 'vitest';
import { claudeArgs, scopePrompt, shellQuote, sshArgs } from './spawn.js';

const LAUNCH = { session_id: '6f1c2a0e-1b2c-4d3e-8f90-123456789abc', resume: false, scope: null };

describe('spawn', () => {
	it('creates the session on the first launch and resumes it after', () => {
		expect(claudeArgs(LAUNCH).slice(-2)).toEqual(['--session-id', LAUNCH.session_id]);
		expect(claudeArgs({ ...LAUNCH, resume: true }).slice(-2)).toEqual([
			'--resume',
			LAUNCH.session_id
		]);
	});

	it('names the database a scoped chat is about', () => {
		expect(scopePrompt('d_beads_web')).toContain('"beads_web"');
		expect(claudeArgs({ ...LAUNCH, scope: 'd_x' })).toContain('--append-system-prompt');
	});

	it('quotes the remote command for the shell', () => {
		expect(shellQuote("it's")).toBe(`'it'\\''s'`);
		const args = sshArgs(
			{
				target: 'agent@10.100.0.2',
				identity_file: '/k',
				known_hosts_file: '/h',
				workdir: '/w d',
				claude: 'mate-claude'
			},
			{ ...LAUNCH, scope: "d_o'brien" }
		);
		expect(args.slice(-3, -1)).toEqual(['agent@10.100.0.2', '--']);
		expect(args.at(-1)).toMatch(/^cd '\/w d' && exec 'mate-claude' '-p'/);
		expect(args.at(-1)).toContain(`o'\\''brien`);
	});
});
