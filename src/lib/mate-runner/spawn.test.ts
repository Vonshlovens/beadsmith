import { describe, expect, it } from 'vitest';
import { chatInstance, chatPlace, scopePrompt, shellQuote, sshArgs } from './spawn.js';

const CONFIG = {
	target: 'root@10.100.0.2',
	identity_file: '/k',
	known_hosts_file: '/h',
	chat_homes: '/var/lib/private/mate-chats',
	claude: 'mate-claude'
};
const SESSION = '6f1c1f4e-0b1a-4c3d-9e8f-0123456789ab';

describe('spawn', () => {
	it('names the database a scoped chat is about', () => {
		expect(scopePrompt('d_beads_web')).toContain('"beads_web"');
		expect(scopePrompt('beads_web')).toContain('"beads_web"');
	});

	it('quotes a word for a POSIX shell', () => {
		expect(shellQuote("it's")).toBe(`'it'\\''s'`);
	});

	it("asks the guest helper for one chat's core, with its host key pinned, and nothing else", () => {
		const args = sshArgs(CONFIG, 'connect', SESSION);
		expect(args).toContain('StrictHostKeyChecking=yes');
		expect(args).toContain('UserKnownHostsFile=/h');
		expect(args.slice(-3)).toEqual(['root@10.100.0.2', '--', `connect ${SESSION}`]);
		expect(sshArgs(CONFIG, 'discard', SESSION).at(-1)).toBe(`discard ${SESSION}`);
		// The CLI, its prompt and the scope travel over hc, never on this command line.
		expect(args.join(' ')).not.toContain('mate-claude');
	});

	it("puts each chat in its own home, named the way the guest's helper names it", () => {
		// printf %s <session> | sha256sum | cut -c1-24
		expect(chatInstance(SESSION)).toMatch(/^[0-9a-f]{24}$/);
		const home = `/var/lib/private/mate-chats/${chatInstance(SESSION)}`;
		expect(chatPlace(CONFIG, SESSION)).toEqual({
			cwd: `${home}/work`,
			config_dir: `${home}/.claude`,
			command: 'mate-claude'
		});
		expect(chatInstance('6f1c1f4e-0b1a-4c3d-9e8f-0123456789ac')).not.toBe(chatInstance(SESSION));
	});

	it('refuses a session id the guest helper would not accept', () => {
		for (const bad of ['', 'x; rm -rf /', SESSION.toUpperCase(), `${SESSION} extra`]) {
			expect(() => sshArgs(CONFIG, 'connect', bad)).toThrow();
		}
	});
});
