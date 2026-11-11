/**
 * Build the E2B template Beadsmith's `e2b` provider ("Sand") launches
 * (docs/sand-e2b.md). Run from the repository root with the E2B API key in
 * the environment:
 *
 *   E2B_API_KEY=... node sandbox/e2b/build-template.ts [name]
 *
 * The name defaults to `beadsmith-agent` (BDX_E2B_TEMPLATE). Rebuild after
 * changing this file or `beadsmith-run`; running sandboxes keep the old build.
 *
 * Versions are pinned. bd is checksum-verified and matches the schema of the
 * Beads databases sandboxes open, not nix/overlay.nix: the maintainer's
 * projects are still on bd 1.1's schema, and bd 1.3 fails on them
 * ("table not found: leases"). Move it with the databases' own migration;
 * Claude Code is an npm `stable` release at least three days old, like the
 * rest of the repository's dependencies (pnpm-workspace.yaml), and one that
 * reports its status to hc through OSC 7501 (ADR-0021: the session core
 * waits on it). hc comes from `nix/herdr-core.json`, the pin the Nix overlay
 * reads too (ADR-0021 rule 5); bump it there, never with `hc update`.
 */
import { Template, defaultBuildLogger } from 'e2b';
import {
	claudeFirstRunFiles,
	HC_CONFIG_PATH,
	HC_CONFIG_TOML,
	hcInstallCommands,
	readHcPin
} from '../../src/lib/server/e2b/image.ts';

const BD_VERSION = '1.1.0';
const BD_SHA256_LINUX_AMD64 = 'b0f3dd607c3fb989ee08d0a6854fba80d0402971eb108f9af6170bc14d491a34';
const CLAUDE_CODE_VERSION = '2.1.311';

const name = process.argv[2] ?? 'beadsmith-agent';
const hc = readHcPin('linux-x86_64');

/** Write a file as the default user, without quoting its contents into a shell line. */
function writeAsUser(path: string, text: string): string {
	const encoded = Buffer.from(text).toString('base64');
	return `mkdir -p "$(dirname '${path}')" && echo '${encoded}' | base64 -d > '${path}'`;
}

/**
 * Fallback standing instructions for First Mate. Beadsmith overwrites
 * AGENTS.md with the current ones (crew tools, ADR-0020) every time it starts
 * or resumes a chat sandbox (src/lib/server/mate/crew-bridge.ts), so this
 * text only shows in a sandbox started by hand from the template.
 */
const MATE_INSTRUCTIONS =
	'You are First Mate, a Beads assistant. This sandbox currently has model access only. ' +
	'Do not claim Beads or repository access. Ask the operator when a requested action needs ' +
	'unavailable access. Never seek credentials or bypass network boundaries.';

const template = Template({ fileContextPath: import.meta.dirname })
	.fromNodeImage('24')
	.aptInstall(['ca-certificates', 'curl', 'git', 'jq', 'socat', 'procps'])
	.runCmd(
		[
			// GitHub CLI, from GitHub's signed apt repository.
			'install -d -m 0755 /etc/apt/keyrings',
			'curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg',
			'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list',
			// Tailscale, from Tailscale's signed apt repository.
			'curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.noarmor.gpg -o /usr/share/keyrings/tailscale-archive-keyring.gpg',
			'curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.tailscale-keyring.list -o /etc/apt/sources.list.d/tailscale.list',
			'apt-get update && apt-get install -y --no-install-recommends gh tailscale && rm -rf /var/lib/apt/lists/*',
			// bd, checksum-verified.
			`cd /tmp && curl -fsSL -o bd.tgz https://github.com/gastownhall/beads/releases/download/v${BD_VERSION}/beads_${BD_VERSION}_linux_amd64.tar.gz`,
			`echo "${BD_SHA256_LINUX_AMD64}  /tmp/bd.tgz" | sha256sum -c -`,
			'mkdir -p /tmp/bd && tar -xzf /tmp/bd.tgz -C /tmp/bd && install -m 0755 "$(find /tmp/bd -type f -name bd | head -1)" /usr/local/bin/bd && rm -rf /tmp/bd /tmp/bd.tgz',
			`npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`,
			// hc (herdr-core), checksum-verified against the repository's pin.
			...hcInstallCommands(hc)
		],
		{ user: 'root' }
	)
	.copy('beadsmith-run', '/usr/local/bin/beadsmith-run', { user: 'root', mode: 0o755 })
	.copy('beadsmith-hc.cjs', '/usr/local/bin/beadsmith-hc', { user: 'root', mode: 0o755 })
	.setEnvs({
		// E2B's egress proxy re-signs TLS with a CA it adds to the system
		// bundle; Node (Claude Code) only trusts it when told to.
		NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/ca-certificates.crt',
		// Unattended inside a sandbox: no permission prompts (ADR-0015), no
		// telemetry or update checks leaving through the allowlist.
		IS_SANDBOX: '1',
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
		DISABLE_AUTOUPDATER: '1',
		GIT_TERMINAL_PROMPT: '0',
		BD_NON_INTERACTIVE: '1'
	})
	.runCmd([
		// First Mate chats (src/lib/server/mate/e2b-runner.ts) run here, with the
		// fallback instructions; Beadsmith writes the current AGENTS.md on start.
		'mkdir -p /home/user/mate',
		`printf '%s\\n' ${JSON.stringify(MATE_INSTRUCTIONS)} > /home/user/mate/AGENTS.md`,
		'ln -sf AGENTS.md /home/user/mate/CLAUDE.md',
		'git config --global user.name "Beadsmith agent"',
		'git config --global user.email "beadsmith-agent@users.noreply.github.com"',
		'git config --global init.defaultBranch main',
		// Agents run as interactive Claude Code in hc terminals (ADR-0021): its
		// first-run dialogs are answered here, and hc types nothing on its own.
		...Object.entries(claudeFirstRunFiles()).map(([path, text]) => writeAsUser(path, text)),
		writeAsUser(HC_CONFIG_PATH, HC_CONFIG_TOML),
		'chmod 700 /home/user/.claude /home/user/.config/herdr-core',
		'hc --version'
	]);

await Template.build(template, name, {
	cpuCount: 2,
	memoryMB: 4096,
	onBuildLogs: defaultBuildLogger()
});
console.log(`Built E2B template ${name}. Set BDX_E2B_TEMPLATE=${name} if it is not the default.`);
