import { describe, expect, it } from 'vitest';
import { scopePrompt, shellQuote, sshArgs } from './spawn.js';

const CONFIG = {
	target: 'agent@10.100.0.2',
	identity_file: '/k',
	known_hosts_file: '/h',
	workdir: '/w d',
	config_dir: '/home/agent/.claude',
	claude: 'mate-claude',
	hc: "/opt/it's/hc"
};

describe('spawn', () => {
	it('names the database a scoped chat is about', () => {
		expect(scopePrompt('d_beads_web')).toContain('"beads_web"');
		expect(scopePrompt('beads_web')).toContain('"beads_web"');
	});

	it('runs hc connect in the guest with its host key pinned, and nothing else', () => {
		expect(shellQuote("it's")).toBe(`'it'\\''s'`);
		const args = sshArgs(CONFIG);
		expect(args).toContain('StrictHostKeyChecking=yes');
		expect(args).toContain('UserKnownHostsFile=/h');
		expect(args.slice(-3)).toEqual(['agent@10.100.0.2', '--', `exec '/opt/it'\\''s/hc' connect`]);
		// The CLI, its prompt and the scope travel over hc, never on this command line.
		expect(args.join(' ')).not.toContain('mate-claude');
	});
});
