import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseE2bSettings } from '../env.js';
import type { MissionEvent } from '#lib/mission-events.js';
import { claudeCode } from '#lib/agent-session/claude-code.js';
import { FakeHcCore, type FakeTerminal } from '#lib/test/fake-hc.js';
import { FakeRalph } from '#lib/test/fake-ralph.js';
import {
	buildSandboxNetwork,
	createE2bProvider,
	LOOP_METADATA,
	LOOP_TERMINAL,
	loopTerminalName,
	parseRunFiles,
	parseTranscriptEnd,
	ralphArgv,
	SERVE_TERMINAL,
	settledUpdate,
	SESSION_METADATA,
	MODEL_METADATA,
	EFFORT_METADATA,
	type E2bProviderDeps,
	type SandboxCreateInput,
	type SandboxDriver,
	type SandboxNetwork,
	type SandboxRef
} from './e2b-provider.js';
import {
	AGENT_BUSY_MESSAGE,
	LOOP_ALREADY_RESTARTED_MESSAGE,
	LOOP_NOT_RUNNING_MESSAGE,
	NOT_A_LOOP_SANDBOX_MESSAGE,
	RUN_NOT_CANCELLABLE_MESSAGE
} from './provider.js';
import { ralphRouteAllowed } from './ralph.js';
import { ANTHROPIC_PLACEHOLDER, GITHUB_PLACEHOLDER } from '../e2b/sandbox.js';
import { CLAUDE_CONFIG_DIR, HC_CARRIER, RUNS_DIR, WORK_DIR } from '../e2b/image.js';

const SETTINGS = parseE2bSettings({
	BDX_E2B_API_KEY_FILE: '/run/secrets/e2b',
	BDX_E2B_ANTHROPIC_API_KEY_FILE: '/run/secrets/anthropic',
	BDX_E2B_DOLT_ACCOUNTS_FILE: '/run/secrets/dolt-accounts.json',
	BDX_E2B_TAILSCALE_OAUTH_CLIENT_ID: 'client-id',
	BDX_E2B_TAILSCALE_OAUTH_CLIENT_SECRET_FILE: '/run/secrets/ts',
	BDX_E2B_GITHUB_APP_ID: '12345',
	BDX_E2B_GITHUB_APP_PRIVATE_KEY_FILE: '/run/secrets/gh-app.pem'
})!;

const ANTHROPIC_KEY = 'sk-ant-api03-REAL-KEY-never-in-sandbox';
const GITHUB_TOKEN = 'ghs_REALTOKENneverinsandbox0000';
const DOLT_PASSWORD = 'scoped-dolt-password-0000';
const PR = 'https://github.com/example-org/beads-web/pull/7';

const later = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** What `beadsmith-run` left behind for one run. */
interface FakeRun {
	/** Setup done and the core is up (the default once started). */
	ready: boolean;
	/** Setup failed with this code. */
	exit?: number;
	cancelled?: boolean;
	claimed_s?: number;
	setup_killed?: boolean;
}

/**
 * A fake Claude Code on a fake hc core: idle at launch; each message is a
 * turn that `finish` ends (or that ends at once with `auto`).
 */
class FakeClaude {
	readonly core = new FakeHcCore();
	readonly lines: string[] = [];
	transcript = '';
	auto = true;
	launch_status = 'idle';
	reply = `Done. Opened ${PR}`;

	constructor() {
		this.core.onRun = (t) => this.core.setStatus(t.address, this.launch_status);
		this.core.onSend = (t, text) =>
			queueMicrotask(() => {
				this.write({ type: 'user', message: { role: 'user', content: text } });
				this.core.setStatus(t.address, 'working');
				this.write({
					type: 'assistant',
					message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }] }
				});
				if (this.auto) this.finish(t);
			});
	}

	write(entry: unknown): void {
		this.lines.push(JSON.stringify(entry));
		this.core.files.set(this.transcript, this.lines.map((l) => `${l}\n`).join(''));
	}

	finish(t: FakeTerminal = this.live()!): void {
		this.write({
			type: 'user',
			message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] }
		});
		this.write({ type: 'assistant', message: { content: [{ type: 'text', text: this.reply }] } });
		this.write({ type: 'system', subtype: 'turn_duration', durationMs: 4200 });
		this.core.endTurn(t.address, 'idle');
	}

	live(): FakeTerminal | undefined {
		return [...this.core.terminals.values()].find((t) => t.state === 'live');
	}

	runs(): string[][] {
		return this.core.calls
			.filter((c) => c.method === 'terminal.run')
			.map((c) => c.params.argv as string[]);
	}

	sends(): string[] {
		return this.core.calls
			.filter((c) => c.method === 'terminal.send')
			.map((c) => c.params.text as string);
	}
}

class FakeSandbox implements SandboxRef {
	runs = new Map<string, FakeRun>();
	files = new Map<string, string>();
	started: { command: string; envs: Record<string, string> }[] = [];
	networks: SandboxNetwork[] = [];
	timeouts: number[] = [];
	carriers = 0;
	killed = false;
	/** What setup does when `beadsmith-run` starts. */
	setup: Partial<FakeRun> = { ready: true };
	/** Runs before each command; a test returns a promise to hold that command. */
	hold?: (command: string) => Promise<void> | undefined;
	constructor(
		readonly id: string,
		readonly claude: FakeClaude
	) {}

	file(run_id: string, name: string): string | undefined {
		return this.files.get(`${RUNS_DIR}/${run_id}/${name}`);
	}

	/** The previous run's claim time while its starter has not finished. */
	previousStart(run_id: string): number | undefined {
		const prev = `r${Number(run_id.slice(1)) - 1}`;
		const run = this.runs.get(prev);
		if (run?.claimed_s === undefined) return undefined;
		if (this.file(prev, 'start-done') !== undefined) return undefined;
		if (this.file(prev, 'result.json') !== undefined) return undefined;
		return run.claimed_s;
	}

	/** The transcript's line count, as `wc -l` gives it for the path in a command. */
	transcriptLines(command: string): number {
		const path = /\[ -e '([^']+)' \]/.exec(command)![1];
		return (this.claude.core.files.get(path) ?? '').split('\n').length - 1;
	}

	async exec(command: string) {
		await this.hold?.(command);
		const run_of = (re: RegExp) => this.runs.get(re.exec(command)?.[1] ?? '');
		if (/^d='[^']+\/(r[0-9]+)'; if \[ ! -d/.test(command)) {
			const id = /runs\/(r[0-9]+)'/.exec(command)![1];
			const run = this.runs.get(id);
			if (run === undefined) return { exit_code: 0, stdout: 'missing\n' };
			return {
				exit_code: 0,
				stdout:
					`exit=${run.exit ?? ''}\ncancelled=${run.cancelled ? '1' : ''}\n` +
					`ready=${run.ready ? '1' : ''}\nclaimed=${run.claimed_s ?? ''}\nnow=1000\n` +
					`started=${this.file(id, 'started') === undefined ? '' : '1'}\n` +
					`prev_claimed=${this.previousStart(id) ?? ''}\n` +
					`turn=${this.file(id, 'turn.json') ?? ''}\nresult=${this.file(id, 'result.json') ?? ''}\n`
			};
		}
		if (/^d='[^']+\/(r[0-9]+)'; mkdir "\$d\/claim"/.test(command)) {
			const id = /runs\/(r[0-9]+)'/.exec(command)![1];
			const run = this.runs.get(id)!;
			if (run.claimed_s !== undefined) return { exit_code: 1, stdout: '' };
			run.claimed_s = 1000;
			this.files.set(`${RUNS_DIR}/${id}/start-line`, `${this.transcriptLines(command)}\n`);
			return { exit_code: 0, stdout: '' };
		}
		if (/^d='[^']+\/(r[0-9]+)'; if \[ -f "\$d\/end" \]/.test(command)) {
			const id = /runs\/(r[0-9]+)'/.exec(command)![1];
			const end = this.file(id, 'end');
			if (end !== undefined) return { exit_code: 0, stdout: `end=${end.trim()}\n` };
			const later = [...this.runs.keys()]
				.map((r) => Number(r.slice(1)))
				.filter((n) => n > Number(id.slice(1)))
				.sort((a, b) => a - b)
				.map(
					(n) =>
						`later=${this.file(`r${n}`, 'start-line')?.trim() ?? ''}|${this.file(`r${n}`, 'turn.json') ?? ''}\n`
				);
			return {
				exit_code: 0,
				stdout: `lines=${this.transcriptLines(command)}\n${later.join('')}`
			};
		}
		if (command.includes('(set -C; printf')) {
			const id = /runs\/(r[0-9]+)'/.exec(command)![1];
			const value = /printf '%s\\n' ([0-9]+)/.exec(command)![1];
			if (this.file(id, 'end') === undefined) this.files.set(`${RUNS_DIR}/${id}/end`, `${value}\n`);
			return { exit_code: 0, stdout: this.file(id, 'end')! };
		}
		if (command.startsWith("mkdir '") && command.includes('/claim')) {
			const run = run_of(/runs\/(r[0-9]+)\/claim/)!;
			if (run.claimed_s !== undefined) return { exit_code: 1, stdout: '' };
			run.claimed_s = 1000;
			return { exit_code: 0, stdout: '' };
		}
		if (command.startsWith("[ -f '") && command.endsWith("/cancelled' ]")) {
			const run = run_of(/runs\/(r[0-9]+)\/cancelled/);
			return { exit_code: run?.cancelled ? 0 : 1, stdout: '' };
		}
		if (command.startsWith("cat '")) {
			const path = /^cat '([^']+)'/.exec(command)![1];
			return { exit_code: 0, stdout: this.files.get(path) ?? '' };
		}
		if (command.startsWith('tail -c')) {
			return { exit_code: 0, stdout: `cloning…\nError: Dolt refused ${DOLT_PASSWORD}\n` };
		}
		if (command.startsWith('ls -1')) {
			return { exit_code: 0, stdout: [...this.runs.keys()].join('\n') };
		}
		if (/^d='[^']+\/(r[0-9]+)'; \[ -d/.test(command)) {
			const run = run_of(/runs\/(r[0-9]+)'/);
			if (run === undefined || run.exit !== undefined) return { exit_code: 3, stdout: '' };
			run.cancelled = true;
			if (!run.ready) run.setup_killed = true;
			return { exit_code: 0, stdout: '' };
		}
		return { exit_code: 0, stdout: '' };
	}
	async start(command: string, envs: Record<string, string>) {
		this.started.push({ command, envs });
		this.runs.set(command.split(' ')[1], { ready: false, ...this.setup });
	}
	async follow(): Promise<never> {
		throw new Error('missions follow the transcript over hc');
	}
	/** `beadsmith-hc connect`: hc's bytes as base64 lines both ways. */
	async interactive(
		command: string,
		options: { on_stdout: (chunk: string) => void; on_stderr: (chunk: string) => void }
	) {
		expect(command).toBe(`${HC_CARRIER} connect`);
		this.carriers += 1;
		await this.hold?.(command);
		const hc = this.claude.core.connect();
		let exited!: (code: number | null) => void;
		const exit = new Promise<number | null>((resolve) => (exited = resolve));
		hc.onData((bytes) => {
			const line = `${Buffer.from(bytes).toString('base64')}\n`;
			// Split a line across callbacks, as E2B may.
			options.on_stdout(line.slice(0, 5));
			options.on_stdout(line.slice(5));
		});
		hc.onClose(() => exited(0));
		let pending = '';
		return {
			sendStdin: async (data: string) => {
				pending += data;
				let newline;
				while ((newline = pending.indexOf('\n')) !== -1) {
					hc.write(new Uint8Array(Buffer.from(pending.slice(0, newline), 'base64')));
					pending = pending.slice(newline + 1);
				}
			},
			closeStdin: async () => {},
			kill: async () => hc.close(),
			wait: () => exit
		};
	}
	async writeFile(path: string, content: string) {
		this.files.set(path, content);
	}
	async setTimeout(timeout_ms: number) {
		this.timeouts.push(timeout_ms);
	}
	async updateNetwork(network: SandboxNetwork) {
		this.networks.push(network);
	}
	async kill() {
		this.killed = true;
	}
}

const providers: Array<{ claude: FakeClaude }> = [];
afterEach(() => {
	for (const { claude } of providers.splice(0)) claude.core.disconnectAll();
});

function setup(overrides: { create_fails?: boolean; ralph?: FakeRalph } = {}) {
	const claude = new FakeClaude();
	const sandboxes = new Map<string, FakeSandbox>();
	const states = new Map<string, 'running' | 'paused'>();
	const metadata = new Map<string, Record<string, string>>();
	const created: SandboxCreateInput[] = [];
	const driver: SandboxDriver = {
		async create(input) {
			if (overrides.create_fails) throw new Error(`quota exceeded for key ${ANTHROPIC_KEY}`);
			created.push(input);
			const sandbox = new FakeSandbox(`sbx${sandboxes.size + 1}`, claude);
			sandboxes.set(sandbox.id, sandbox);
			states.set(sandbox.id, 'running');
			metadata.set(sandbox.id, input.metadata);
			// Loop sandboxes have no CLI session of Beadsmith's.
			if (input.metadata[SESSION_METADATA] !== undefined) {
				claude.transcript = claudeCode.transcriptPath({
					cwd: WORK_DIR,
					config_dir: CLAUDE_CONFIG_DIR,
					session_id: input.metadata[SESSION_METADATA]
				});
			}
			return sandbox;
		},
		async connect(id) {
			const sandbox = sandboxes.get(id);
			if (sandbox === undefined) throw new Error('not found');
			states.set(id, 'running');
			return sandbox;
		},
		async info(id) {
			const state = states.get(id);
			return state === undefined ? undefined : { id, state, metadata: metadata.get(id) ?? {} };
		},
		async find() {
			return [];
		}
	};
	const logs: string[] = [];
	const mint_github_token = vi.fn(async () => GITHUB_TOKEN);
	const mint_tailscale_key = vi.fn(async () => 'tskey-auth-single-use');
	const deps: E2bProviderDeps = {
		settings: SETTINGS,
		label: 'Sand',
		driver,
		read_secret: async () => ANTHROPIC_KEY,
		mint_tailscale_key,
		mint_github_token,
		read_dolt_account: async (database) => {
			if (database !== 'beads_web') throw new Error('no account');
			return { user: 'sbx_beads_web', password: DOLT_PASSWORD };
		},
		timing: { poll_ms: 5, startup_ms: 500, settle_ms: 50, wait_ms: 5 },
		...(overrides.ralph === undefined ? {} : { ralph_fetch: () => overrides.ralph!.fetch }),
		log: (message) => logs.push(message)
	};
	const provider = createE2bProvider(deps);
	providers.push({ claude });
	return {
		provider,
		/** A new provider on the same sandboxes, as after a Beadsmith restart. */
		restartServer: () => createE2bProvider(deps),
		claude,
		sandboxes,
		states,
		metadata,
		created,
		mint_github_token,
		mint_tailscale_key,
		logs
	};
}

const TACKLE = {
	name: 'Tackle: bw-1',
	prompt: 'Tackle bw-1',
	dolt_database: 'beads_web',
	auto_create_pr: true,
	repository: { url: 'https://github.com/example-org/beads-web', starting_ref: 'main' }
};

describe('buildSandboxNetwork', () => {
	it('adds keys per host and keeps rule hosts in the allowlist', () => {
		const network = buildSandboxNetwork(
			{},
			{ kind: 'api_key', value: ANTHROPIC_KEY },
			GITHUB_TOKEN
		);
		expect(network.headers['api.anthropic.com']).toEqual({ 'x-api-key': ANTHROPIC_KEY });
		expect(network.headers['api.github.com']).toEqual({ authorization: `Bearer ${GITHUB_TOKEN}` });
		expect(
			Buffer.from(network.headers['github.com'].authorization.slice(6), 'base64').toString()
		).toBe(`x-access-token:${GITHUB_TOKEN}`);
		expect(network.allow_out).toEqual(['api.anthropic.com', 'github.com', 'api.github.com', '*']);
		expect(network.deny_out).toEqual(['0.0.0.0/0']);
	});

	it('replaces the open default with an operator allowlist', () => {
		expect(
			buildSandboxNetwork(
				{ allow_out: ['*.tailscale.com'] },
				{ kind: 'api_key', value: ANTHROPIC_KEY }
			).allow_out
		).toEqual(['api.anthropic.com', '*.tailscale.com']);
	});
});

describe('E2B provider', () => {
	it('launches one sandbox with keys outside it and the project Dolt account inside', async () => {
		const { provider, sandboxes, created, mint_github_token } = setup();
		expect(await provider.launch(TACKLE)).toEqual({ agent_id: 'sbx1', run_id: 'r1' });
		const [input] = created;
		expect(input.template).toBe('beadsmith-agent');
		expect(input.timeout_ms).toBe(55 * 60_000);
		expect(input.metadata).toMatchObject({
			beadsmith_database: 'beads_web',
			beadsmith_repository: TACKLE.repository.url,
			beadsmith_write: '1'
		});
		expect(input.metadata[SESSION_METADATA]).toMatch(/^[0-9a-f-]{36}$/);
		expect(input.envs).toMatchObject({
			ANTHROPIC_API_KEY: ANTHROPIC_PLACEHOLDER,
			BEADS_DOLT_SERVER_HOST: '127.0.0.1',
			BEADS_DOLT_SERVER_USER: 'sbx_beads_web',
			BEADS_DOLT_PASSWORD: DOLT_PASSWORD,
			BEADS_DOLT_SERVER_DATABASE: 'beads_web',
			BEADSMITH_DOLT_TAILNET_HOST: 'beads',
			BEADSMITH_REPO_URL: TACKLE.repository.url,
			GH_TOKEN: GITHUB_PLACEHOLDER
		});
		// Rule 6: the real keys only travel in the egress rules.
		const envs = JSON.stringify(input.envs);
		expect(envs).not.toContain(ANTHROPIC_KEY);
		expect(envs).not.toContain(GITHUB_TOKEN);
		expect(input.network.headers['api.anthropic.com']['x-api-key']).toBe(ANTHROPIC_KEY);
		expect(mint_github_token).toHaveBeenCalledWith(TACKLE.repository.url, true);

		const sandbox = sandboxes.get('sbx1')!;
		expect(sandbox.file('r1', 'prompt')).toBe('Tackle bw-1');
		// The skills the prompts name ride along, whatever the checkout holds.
		for (const name of ['file', 'tackle', 'comment', 'discuss']) {
			expect(sandbox.files.get(`/home/user/.beadsmith/skills/${name}/SKILL.md`)).toMatch(
				new RegExp(`^---\\nname: ${name}\\n`)
			);
		}
		expect(sandbox.started).toEqual([
			{ command: 'beadsmith-run r1', envs: { BEADSMITH_TS_AUTHKEY: 'tskey-auth-single-use' } }
		]);
	});

	it('launches without a checkout or GitHub token when the mission has none', async () => {
		const { provider, created, mint_github_token } = setup();
		await provider.launch({
			name: 'File',
			prompt: 'file',
			dolt_database: 'beads_web',
			auto_create_pr: false
		});
		expect(mint_github_token).not.toHaveBeenCalled();
		expect(created[0].network.headers['github.com']).toBeUndefined();
		expect(created[0].envs.GH_TOKEN).toBeUndefined();
	});

	it('fails closed for a project without a sandbox Dolt account or a non-GitHub checkout', async () => {
		const { provider, created } = setup();
		await expect(provider.launch({ ...TACKLE, dolt_database: 'other' })).rejects.toThrow();
		await expect(
			provider.launch({
				...TACKLE,
				repository: { url: 'https://gitlab.com/a/b', starting_ref: 'main' }
			})
		).rejects.toThrow(/github\.com/);
		expect(created).toHaveLength(0);
	});

	it('reports a create failure without the provider error text', async () => {
		const { provider, logs } = setup({ create_fails: true });
		await expect(provider.launch(TACKLE)).rejects.toThrow('Sand could not create a sandbox.');
		// The detail goes to the server log, with credential shapes stripped.
		expect(logs).toHaveLength(1);
		expect(logs[0]).toContain('quota exceeded');
		expect(logs[0]).not.toContain(ANTHROPIC_KEY);
	});

	it('reports a running setup without touching hc', async () => {
		const { provider, sandboxes } = setup();
		await provider.launch(TACKLE);
		const sandbox = sandboxes.get('sbx1')!;
		sandbox.runs.get('r1')!.ready = false;
		expect(await provider.getRun('sbx1', 'r1')).toEqual({ status: 'running' });
		expect(sandbox.carriers).toBe(0);
	});

	it('names a failed setup step and logs its log, redacted, once', async () => {
		const { provider, sandboxes, logs } = setup();
		await provider.launch(TACKLE);
		sandboxes.get('sbx1')!.runs.set('r1', { ready: false, exit: 13 });
		expect(await provider.getRun('sbx1', 'r1')).toEqual({
			status: 'failed',
			error_message: 'The sandbox joined the tailnet but Dolt did not answer.'
		});
		await provider.getRun('sbx1', 'r1');
		expect(logs).toHaveLength(1);
		expect(logs[0]).toContain('sbx1/r1 setup exited 13');
		expect(logs[0]).toContain('Dolt refused [redacted]');
		expect(logs[0]).not.toContain(DOLT_PASSWORD);
	});

	it('starts the CLI in an hc terminal, sends the prompt, and reads the turn to its result', async () => {
		const { provider, claude, sandboxes, created } = setup();
		claude.auto = false;
		await provider.launch(TACKLE);
		const sandbox = sandboxes.get('sbx1')!;
		const session_id = created[0].metadata[SESSION_METADATA];

		expect(await provider.getRun('sbx1', 'r1')).toEqual({ status: 'running' });
		const [argv] = claude.runs();
		expect(argv).toEqual([
			'claude',
			'--permission-mode',
			'bypassPermissions',
			'--session-id',
			session_id
		]);
		// The prompt goes in with terminal.send, never on the command line.
		expect(claude.sends()).toEqual(['Tackle bw-1']);
		expect(JSON.parse(sandbox.file('r1', 'turn.json')!)).toEqual({ base: 0, first_line: 1 });
		expect(claude.live()!.labels).toMatchObject({ 'beadsmith-session': session_id });

		// Still working: a second read neither starts nor sends again.
		expect(await provider.getRun('sbx1', 'r1')).toEqual({ status: 'running' });
		expect(claude.sends()).toHaveLength(1);

		claude.finish();
		const update = await provider.getRun('sbx1', 'r1');
		expect(update).toEqual({
			status: 'succeeded',
			result_summary: `Done. Opened ${PR}`,
			duration_ms: 4200,
			git_pr_url: PR
		});
		expect(JSON.parse(sandbox.file('r1', 'result.json')!)).toMatchObject({
			status: 'succeeded',
			git_pr_url: PR
		});
		expect(sandbox.timeouts).toEqual([SETTINGS.idle_minutes * 60_000]);
		// The CLI keeps running between turns.
		expect(claude.live()).toBeDefined();
		const carriers = sandbox.carriers;
		expect(await provider.getRun('sbx1', 'r1')).toEqual(update);
		expect(sandbox.carriers).toBe(carriers);
	});

	it('relays the mission CLI terminal to a watcher and never wakes a paused sandbox for it', async () => {
		const { provider, claude, states } = setup();
		claude.auto = false;
		await provider.launch(TACKLE);
		expect(await provider.getRun('sbx1', 'r1')).toEqual({ status: 'running' });
		const cli = claude.live()!;
		const received: string[] = [];
		const relay = await provider.attachTerminal!('sbx1', {
			mode: 'watch',
			cols: 80,
			rows: 24,
			onData: (bytes) => void received.push(new TextDecoder().decode(bytes))
		});
		claude.core.output(cli.address, 'thinking hard');
		await vi.waitFor(() => expect(received.join('')).toContain('thinking hard'));
		relay.close();

		states.set('sbx1', 'paused');
		await expect(
			provider.attachTerminal!('sbx1', { mode: 'watch', cols: 80, rows: 24, onData: () => {} })
		).rejects.toThrow(/paused/);
		expect(states.get('sbx1')).toBe('paused');
	});

	it('starts a run once when two reads race for it', async () => {
		const { provider, claude } = setup();
		claude.auto = false;
		await provider.launch(TACKLE);
		await Promise.all([provider.getRun('sbx1', 'r1'), provider.getRun('sbx1', 'r1')]);
		expect(claude.runs()).toHaveLength(1);
		expect(claude.sends()).toHaveLength(1);
	});

	it('fails a launch that stops on a first-run prompt instead of answering it', async () => {
		const { provider, claude, sandboxes } = setup();
		claude.launch_status = 'blocked';
		await provider.launch(TACKLE);
		const update = await provider.getRun('sbx1', 'r1');
		expect(update.status).toBe('failed');
		expect(update.error_message).toMatch(/stopped at a prompt before its first turn/);
		expect(claude.sends()).toEqual([]);
		expect(sandboxes.get('sbx1')!.file('r1', 'result.json')).toBeDefined();
	});

	it('reports a gone or time-limited sandbox as failed', async () => {
		const { provider, states } = setup();
		await provider.launch(TACKLE);
		states.set('sbx1', 'paused');
		expect((await provider.getRun('sbx1', 'r1')).error_message).toMatch(/55-minute limit/);
		expect(await provider.getRun('gone', 'r1')).toMatchObject({ status: 'failed' });
	});

	it('sends a follow-up to the same running CLI, with a fresh token and the full time limit', async () => {
		const { provider, claude, sandboxes, mint_github_token } = setup();
		claude.auto = false;
		await provider.launch(TACKLE);
		await provider.getRun('sbx1', 'r1');
		await expect(provider.createRun!('sbx1', 'more')).rejects.toThrow(AGENT_BUSY_MESSAGE);
		claude.finish();
		await provider.getRun('sbx1', 'r1');

		claude.auto = true;
		expect(await provider.createRun!('sbx1', 'Now add tests')).toEqual({ run_id: 'r2' });
		const sandbox = sandboxes.get('sbx1')!;
		expect(sandbox.started.at(-1)).toEqual({
			command: 'beadsmith-run r2',
			envs: { BEADSMITH_TS_AUTHKEY: 'tskey-auth-single-use' }
		});
		expect(sandbox.networks).toHaveLength(1);
		expect(mint_github_token).toHaveBeenCalledTimes(2);
		expect(sandbox.timeouts.at(-1)).toBe(55 * 60_000);

		expect((await provider.getRun('sbx1', 'r2')).status).toMatch(/running|succeeded/);
		expect(claude.runs()).toHaveLength(1);
		expect(claude.sends()).toEqual(['Tackle bw-1', 'Now add tests']);
		const turn = JSON.parse(sandbox.file('r2', 'turn.json')!);
		expect(turn.base).toBe(1);
		expect(turn.first_line).toBeGreaterThan(1);
	});

	it('resumes the CLI session when its terminal is gone', async () => {
		const { provider, claude, created } = setup();
		await provider.launch(TACKLE);
		await provider.getRun('sbx1', 'r1');
		await later(10);
		expect((await provider.getRun('sbx1', 'r1')).status).toBe('succeeded');
		claude.core.exit(claude.live()!.address);

		await provider.createRun!('sbx1', 'again');
		await provider.getRun('sbx1', 'r2');
		expect(claude.runs()[1]).toContain('--resume');
		expect(claude.runs()[1]).toContain(created[0].metadata[SESSION_METADATA]);
		expect(claude.sends().at(-1)).toBe('again');
	});

	it('launches the CLI with the mission model and effort, and resumes with them', async () => {
		const { provider, claude, created } = setup();
		await provider.launch({ ...TACKLE, model: 'opus', effort: 'medium' });
		expect(created[0].metadata).toMatchObject({
			[MODEL_METADATA]: 'opus',
			[EFFORT_METADATA]: 'medium'
		});
		await provider.getRun('sbx1', 'r1');
		await later(10);
		expect((await provider.getRun('sbx1', 'r1')).status).toBe('succeeded');
		expect(claude.runs()[0]).toEqual(
			expect.arrayContaining(['--model', 'opus', '--effort', 'medium'])
		);

		// A relaunch after the terminal went keeps the launch's choice.
		claude.core.exit(claude.live()!.address);
		await provider.createRun!('sbx1', 'again');
		await provider.getRun('sbx1', 'r2');
		expect(claude.runs()[1]).toEqual(
			expect.arrayContaining(['--resume', '--model', 'opus', '--effort', 'medium'])
		);
	});

	it('fails a turn whose terminal was lost', async () => {
		const { provider, claude } = setup();
		claude.auto = false;
		await provider.launch(TACKLE);
		await provider.getRun('sbx1', 'r1');
		claude.core.exit(claude.live()!.address, 1);
		expect(await provider.getRun('sbx1', 'r1')).toMatchObject({
			status: 'failed',
			error_message: 'The agent terminal was lost in the middle of a turn.'
		});
		// A status read does not start the CLI again.
		expect(claude.runs()).toHaveLength(1);
	});

	it('stops a turn cut off by the time limit before continuing', async () => {
		const { provider, claude, sandboxes, states } = setup();
		claude.auto = false;
		await provider.launch(TACKLE);
		await provider.getRun('sbx1', 'r1');
		states.set('sbx1', 'paused');
		await provider.createRun!('sbx1', 'carry on');
		const sandbox = sandboxes.get('sbx1')!;
		expect(sandbox.runs.get('r1')!.cancelled).toBe(true);
		expect(claude.core.terminal('t1').state).toBe('finished');
		expect(sandbox.started.map((s) => s.command)).toEqual(['beadsmith-run r1', 'beadsmith-run r2']);
	});

	it('cancels a working run by ending the CLI and refuses a finished one', async () => {
		const { provider, claude, sandboxes } = setup();
		claude.auto = false;
		await provider.launch(TACKLE);
		await provider.getRun('sbx1', 'r1');
		await provider.cancelRun!('sbx1', 'r1');
		expect(claude.core.terminal('t1').state).toBe('finished');
		expect(await provider.getRun('sbx1', 'r1')).toEqual({ status: 'cancelled' });
		await expect(provider.cancelRun!('sbx1', 'r1')).rejects.toThrow(RUN_NOT_CANCELLABLE_MESSAGE);

		// Cancelled during setup: the setup script is stopped, no CLI starts.
		await provider.launch({ ...TACKLE, name: 'second' });
		const second = sandboxes.get('sbx2')!;
		second.runs.get('r1')!.ready = false;
		await provider.cancelRun!('sbx2', 'r1');
		expect(second.runs.get('r1')!.setup_killed).toBe(true);
		second.runs.get('r1')!.ready = true;
		expect(await provider.getRun('sbx2', 'r1')).toEqual({ status: 'cancelled' });
		expect(claude.runs()).toHaveLength(1);
	});

	it('sends no prompt when a cancel lands while the CLI is still launching', async () => {
		const { provider, claude, sandboxes } = setup();
		claude.auto = false;
		await provider.launch(TACKLE);
		const run = sandboxes.get('sbx1')!.runs.get('r1')!;
		const launch = claude.core.onRun!;
		claude.core.onRun = (t) => {
			// The cancel finds no terminal yet and leaves only its mark.
			run.cancelled = true;
			launch(t);
		};
		expect(await provider.getRun('sbx1', 'r1')).toEqual({ status: 'cancelled' });
		expect(claude.runs()).toHaveLength(1);
		expect(claude.sends()).toEqual([]);
		expect(claude.core.terminal('t1').state).toBe('finished');
	});

	it("never lets a cancelled run's delayed starter end a follow-up's CLI", async () => {
		const { provider, claude, sandboxes } = setup();
		claude.auto = false;
		await provider.launch(TACKLE);
		const sandbox = sandboxes.get('sbx1')!;
		// r1's starter stalls reading its prompt, before any CLI exists.
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		sandbox.hold = (command) => (command === `cat '${RUNS_DIR}/r1/prompt'` ? held : undefined);
		const first = provider.getRun('sbx1', 'r1');
		await later(10);
		// The cancel finds no terminal and leaves its mark; the follow-up is accepted.
		await provider.cancelRun!('sbx1', 'r1');
		expect(await provider.createRun!('sbx1', 'Try again')).toEqual({ run_id: 'r2' });
		// r2 waits for r1's starter rather than racing it for the one CLI.
		expect(await provider.getRun('sbx1', 'r2')).toEqual({ status: 'running' });
		release();
		expect(await first).toEqual({ status: 'cancelled' });
		expect(await provider.getRun('sbx1', 'r2')).toEqual({ status: 'running' });
		expect(claude.sends()).toEqual(['Try again']);
		expect(claude.live()).toBeDefined();
		expect([...claude.core.terminals.values()].filter((t) => t.state === 'live')).toHaveLength(1);
		claude.finish();
		expect((await provider.getRun('sbx1', 'r2')).status).toBe('succeeded');
	});

	it('leaves the CLI alone when a starter resumes after the next run stopped waiting', async () => {
		const { provider, claude, sandboxes } = setup();
		claude.auto = false;
		await provider.launch(TACKLE);
		const sandbox = sandboxes.get('sbx1')!;
		// r1's starter passed its cancel check and stalls opening hc.
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		let holding = true;
		sandbox.hold = (command) => {
			if (!holding || command !== `${HC_CARRIER} connect`) return undefined;
			holding = false;
			return held;
		};
		const first = provider.getRun('sbx1', 'r1');
		await later(10);
		await provider.cancelRun!('sbx1', 'r1');
		// Its claim goes stale, so r2 no longer waits for it.
		sandbox.runs.get('r1')!.claimed_s = 1;
		await provider.createRun!('sbx1', 'Try again');
		expect(await provider.getRun('sbx1', 'r2')).toEqual({ status: 'running' });
		const now = Date.now();
		const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 300_000);
		try {
			release();
			await first;
		} finally {
			clock.mockRestore();
		}
		expect(claude.sends()).toEqual(['Try again']);
		expect(claude.live()).toBeDefined();
	});

	it("lets a follow-up start once a dead starter's claim is stale", async () => {
		const { provider, claude, sandboxes } = setup();
		claude.auto = false;
		await provider.launch(TACKLE);
		const sandbox = sandboxes.get('sbx1')!;
		// A starter claimed r1 and its process died: no start-done, an old claim.
		sandbox.runs.get('r1')!.claimed_s = 1;
		expect((await provider.getRun('sbx1', 'r1')).status).toBe('failed');
		await provider.createRun!('sbx1', 'Try again');
		expect(await provider.getRun('sbx1', 'r2')).toEqual({ status: 'running' });
		expect(claude.sends()).toEqual(['Try again']);
	});

	it('ends the CLI when a cancel lands while the prompt is being sent', async () => {
		const { provider, claude, sandboxes } = setup();
		claude.auto = false;
		await provider.launch(TACKLE);
		const run = sandboxes.get('sbx1')!.runs.get('r1')!;
		const send = claude.core.onSend!;
		claude.core.onSend = (t, text) => {
			run.cancelled = true;
			send(t, text);
		};
		expect(await provider.getRun('sbx1', 'r1')).toEqual({ status: 'cancelled' });
		expect(claude.sends()).toEqual(['Tackle bw-1']);
		expect(claude.core.terminal('t1').state).toBe('finished');
	});

	it('streams the transcript as mission events and resumes after the last id', async () => {
		const { provider, claude, sandboxes } = setup();
		claude.auto = false;
		await provider.launch(TACKLE);
		const events: MissionEvent[] = [];
		const streaming = provider.streamMissionEvents!('sbx1', 'r1', async (event) => {
			events.push(event);
			if (event.type === 'tool_call' && event.status === 'running') claude.finish();
		});
		expect(await streaming).toBe('terminal');
		expect(events.map((e) => e.type)).toEqual(['tool_call', 'tool_call', 'assistant', 'result']);
		expect(events.at(-1)).toMatchObject({
			type: 'result',
			status: 'succeeded',
			text: `Done. Opened ${PR}`,
			duration_ms: 4200
		});
		const result = JSON.parse(sandboxes.get('sbx1')!.file('r1', 'result.json')!);
		expect(result).toMatchObject({ status: 'succeeded', event_id: events.at(-1)!.id });

		// A finished run replays its transcript and result, from after what the client has.
		const replay: MissionEvent[] = [];
		expect(
			await provider.streamMissionEvents!('sbx1', 'r1', async (e) => void replay.push(e))
		).toBe('terminal');
		expect(replay).toEqual(events);
		const again: MissionEvent[] = [];
		const after = events[1].id;
		expect(
			await provider.streamMissionEvents!('sbx1', 'r1', async (e) => void again.push(e), {
				last_event_id: after
			})
		).toBe('terminal');
		expect(again).toEqual(events.slice(2));
		const none: MissionEvent[] = [];
		await provider.streamMissionEvents!('sbx1', 'r1', async (e) => void none.push(e), {
			last_event_id: events.at(-1)!.id
		});
		expect(none).toEqual([]);
	});

	it('replays a finished run without the runs after it', async () => {
		const { provider, claude } = setup();
		await provider.launch(TACKLE);
		await provider.getRun('sbx1', 'r1');
		expect(await provider.createRun!('sbx1', 'Now add tests')).toEqual({ run_id: 'r2' });
		expect((await provider.getRun('sbx1', 'r2')).status).toBe('succeeded');

		const first: MissionEvent[] = [];
		const second: MissionEvent[] = [];
		await provider.streamMissionEvents!('sbx1', 'r1', async (e) => void first.push(e));
		await provider.streamMissionEvents!('sbx1', 'r2', async (e) => void second.push(e));
		expect(first.map((e) => e.type)).toEqual(['tool_call', 'tool_call', 'assistant', 'result']);
		expect(second.map((e) => e.type)).toEqual(['tool_call', 'tool_call', 'assistant', 'result']);
		const line = (e: MissionEvent) => Number(e.id.split('.')[0]);
		expect(Math.max(...first.map(line))).toBeLessThan(Math.min(...second.map(line)));
		// The stored ids are the live ones, so the replay resumes where a client stopped.
		expect(second.at(-1)!.id).not.toBe(first.at(-1)!.id);
		expect(claude.sends()).toEqual(['Tackle bw-1', 'Now add tests']);
	});

	it('bounds a cancelled run with no stored result by the next run', async () => {
		const { provider, claude, sandboxes } = setup();
		claude.auto = false;
		await provider.launch(TACKLE);
		await provider.getRun('sbx1', 'r1');
		await provider.cancelRun!('sbx1', 'r1');
		const sandbox = sandboxes.get('sbx1')!;
		expect(sandbox.file('r1', 'result.json')).toBeUndefined();

		// Only the cancelled run's lines so far: its result sorts after them.
		const before: MissionEvent[] = [];
		await provider.streamMissionEvents!('sbx1', 'r1', async (e) => void before.push(e));
		expect(before.map((e) => e.type)).toEqual(['tool_call', 'result']);
		expect(before.at(-1)).toMatchObject({ id: '2.9000', status: 'cancelled' });

		claude.auto = true;
		expect(await provider.createRun!('sbx1', 'Try again')).toEqual({ run_id: 'r2' });
		expect((await provider.getRun('sbx1', 'r2')).status).toBe('succeeded');
		const after: MissionEvent[] = [];
		await provider.streamMissionEvents!('sbx1', 'r1', async (e) => void after.push(e));
		expect(after).toEqual(before);
	});

	it('bounds a cancelled run by the first later run with a turn', async () => {
		const { provider, claude, sandboxes } = setup();
		claude.auto = false;
		await provider.launch(TACKLE);
		await provider.getRun('sbx1', 'r1');
		await provider.cancelRun!('sbx1', 'r1');
		const sandbox = sandboxes.get('sbx1')!;
		const before: MissionEvent[] = [];
		await provider.streamMissionEvents!('sbx1', 'r1', async (e) => void before.push(e));
		expect(before.map((e) => e.type)).toEqual(['tool_call', 'result']);

		// r2 is cancelled while its setup runs, so it never marks a turn.
		sandbox.setup = { ready: false };
		expect(await provider.createRun!('sbx1', 'Try again')).toEqual({ run_id: 'r2' });
		await provider.cancelRun!('sbx1', 'r2');
		expect(sandbox.runs.get('r2')!.setup_killed).toBe(true);
		expect(sandbox.file('r2', 'turn.json')).toBeUndefined();

		claude.auto = true;
		sandbox.setup = { ready: true };
		expect(await provider.createRun!('sbx1', 'Once more')).toEqual({ run_id: 'r3' });
		expect((await provider.getRun('sbx1', 'r3')).status).toBe('succeeded');
		const after: MissionEvent[] = [];
		await provider.streamMissionEvents!('sbx1', 'r1', async (e) => void after.push(e));
		expect(after).toEqual(before);
	});

	it('keeps a cancelled run to the end taken before a follow-up wrote past it', async () => {
		const { provider, claude, sandboxes } = setup();
		claude.auto = false;
		await provider.launch(TACKLE);
		await provider.getRun('sbx1', 'r1');
		await provider.cancelRun!('sbx1', 'r1');
		const sandbox = sandboxes.get('sbx1')!;
		// The stop keeps the transcript's end once the CLI is gone.
		expect(sandbox.file('r1', 'end')).toBe('2\n');

		// A run from before stored ends has none: the replay takes the bound
		// itself, before it connects to hc. Hold that connection while r2 runs.
		sandbox.files.delete(`${RUNS_DIR}/r1/end`);
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		let holding = true;
		sandbox.hold = (command) => {
			if (!holding || command !== `${HC_CARRIER} connect`) return undefined;
			holding = false;
			return held;
		};
		const events: MissionEvent[] = [];
		const streaming = provider.streamMissionEvents!('sbx1', 'r1', async (e) => void events.push(e));
		while (holding) await later(1);

		claude.auto = true;
		expect(await provider.createRun!('sbx1', 'Try again')).toEqual({ run_id: 'r2' });
		expect((await provider.getRun('sbx1', 'r2')).status).toBe('succeeded');
		expect(sandbox.file('r2', 'start-line')).toBe('2\n');
		release();
		expect(await streaming).toBe('terminal');
		expect(events.map((e) => e.type)).toEqual(['tool_call', 'result']);
		expect(events.at(-1)).toMatchObject({ id: '2.9000', status: 'cancelled' });
		expect(sandbox.file('r1', 'end')).toBe('2\n');
	});

	it('bounds a run by the transcript and the first later run that claimed its start', () => {
		expect(parseTranscriptEnd('end=7\n')).toBe(7);
		expect(parseTranscriptEnd('lines=9\n')).toBe(9);
		// A later run that has not claimed its start wrote nothing before the count.
		expect(parseTranscriptEnd('lines=9\nlater=|\nlater=6|\n')).toBe(6);
		expect(parseTranscriptEnd('lines=4\nlater=6|\n')).toBe(4);
		// A run from before start lines: its turn's first line.
		expect(parseTranscriptEnd('lines=9\nlater=|{"base":1,"first_line":5}\n')).toBe(4);
		// An unreadable transcript is bounded by a later start, or not at all.
		expect(parseTranscriptEnd('lines=\nlater=3|\n')).toBe(3);
		expect(parseTranscriptEnd('lines=\nlater=|\n')).toBeUndefined();
	});

	it('resumes a live stream after the last id the client saw', async () => {
		const { provider, claude } = setup();
		claude.auto = false;
		await provider.launch(TACKLE);
		await provider.getRun('sbx1', 'r1');
		const first: MissionEvent[] = [];
		const controller = new AbortController();
		const one = provider.streamMissionEvents!(
			'sbx1',
			'r1',
			async (event) => {
				first.push(event);
				controller.abort();
			},
			{ signal: controller.signal }
		);
		expect(await one).toBe('disconnected');
		expect(first.map((e) => e.type)).toEqual(['tool_call']);

		const rest: MissionEvent[] = [];
		const two = provider.streamMissionEvents!('sbx1', 'r1', async (e) => void rest.push(e), {
			last_event_id: first[0].id
		});
		await later(20);
		claude.finish();
		expect(await two).toBe('terminal');
		expect(rest.map((e) => e.type)).toEqual(['tool_call', 'assistant', 'result']);
		expect(rest[0]).toMatchObject({ status: 'completed' });
	});

	it('ends a cancelled stream with a cancelled result', async () => {
		const { provider, sandboxes } = setup();
		await provider.launch(TACKLE);
		sandboxes.get('sbx1')!.runs.set('r1', { ready: false, cancelled: true, exit: 130 });
		const events: MissionEvent[] = [];
		expect(
			await provider.streamMissionEvents!('sbx1', 'r1', async (e) => void events.push(e))
		).toBe('terminal');
		expect(events).toEqual([{ type: 'result', id: '0.9000', status: 'cancelled' }]);
	});
});

describe('run files', () => {
	it('parses the status script output', () => {
		expect(parseRunFiles('missing\n')).toEqual({ exists: false, cancelled: false, ready: false });
		expect(
			parseRunFiles(
				'exit=\ncancelled=\nready=1\nclaimed=990\nnow=1000\n' +
					'turn={"base":2,"first_line":40}\nresult={"status":"succeeded","event_id":"52.9000","duration_ms":5}\n'
			)
		).toEqual({
			exists: true,
			exit_code: undefined,
			cancelled: false,
			ready: true,
			claim_age_s: 10,
			turn: { base: 2, first_line: 40 },
			result: { status: 'succeeded', event_id: '52.9000', duration_ms: 5 }
		});
		// Files Beadsmith did not write in the expected shape are ignored.
		const odd = parseRunFiles('ready=1\nturn={"base":-1}\nresult={"status":"running"}\n');
		expect(odd).not.toHaveProperty('turn');
		expect(odd).not.toHaveProperty('result');
	});

	it('settles a run from its files', () => {
		const base = { exists: true, cancelled: false, ready: true };
		expect(settledUpdate({ ...base })).toBeUndefined();
		expect(settledUpdate({ ...base, exit_code: 10 })).toMatchObject({
			error_message: 'The sandbox could not join the tailnet.'
		});
		expect(settledUpdate({ ...base, exit_code: 14 })).toMatchObject({
			error_message: 'The sandbox could not start its terminal server (hc).'
		});
		expect(settledUpdate({ ...base, cancelled: true, exit_code: 130 })).toEqual({
			status: 'cancelled'
		});
		// A claim with no turn long after the CLI's startup limit: the starter died.
		expect(settledUpdate({ ...base, claim_age_s: 30 })).toBeUndefined();
		expect(settledUpdate({ ...base, claim_age_s: 3_600 })).toEqual({
			status: 'failed',
			error_message: 'The agent did not start.'
		});
	});
});

const LOOP = {
	name: 'Loop: build',
	dolt_database: 'beads_web',
	repository: { url: 'https://github.com/example-org/beads-web', starting_ref: 'main' },
	loop: { mode: 'build' as const, max_iterations: 5, harness: 'claude' as const }
};

describe('ralphArgv', () => {
	it('passes the loop flags and keeps a run prompt out of flag position', () => {
		expect(
			ralphArgv('bdx-run-0123abcd', {
				mode: 'run',
				prompt: '--max 999',
				issue_id: 'bw-1',
				harness: 'codex',
				model: 'gpt-5',
				effort: 'high',
				max_iterations: 3,
				iteration_timeout_minutes: 20
			})
		).toEqual([
			'ralph',
			'run',
			'--name',
			'bdx-run-0123abcd',
			'--no-observer',
			'--max',
			'3',
			'--harness',
			'codex',
			'--model',
			'gpt-5',
			'--effort',
			'high',
			'--timeout',
			'20',
			'--bead',
			'bw-1',
			'--',
			'--max 999'
		]);
		expect(ralphArgv('bdx-plan-0123abcd', { mode: 'plan', max_iterations: 2 })).toEqual([
			'ralph',
			'plan',
			'--name',
			'bdx-plan-0123abcd',
			'--no-observer',
			'--max',
			'2'
		]);
	});
});

describe('E2B provider loops', () => {
	async function launched(options: { ralph?: FakeRalph } = {}) {
		const ralph = options.ralph ?? new FakeRalph();
		const env = setup({ ralph });
		const launch = await env.provider.launchLoop!(LOOP);
		const sandbox = env.sandboxes.get(launch.agent_id)!;
		const name = env.metadata.get(launch.agent_id)![LOOP_METADATA];
		return { ...env, ralph, launch, sandbox, name };
	}

	function terminals(claude: FakeClaude) {
		return [...claude.core.terminals.values()];
	}

	it('launches a sandbox of its own that E2B destroys, with the loop command and no prompt', async () => {
		const { launch, created, sandbox, name, mint_github_token } = await launched();
		expect(launch).toEqual({ agent_id: 'sbx1', run_id: 'r1' });
		const [input] = created;
		expect(input.on_timeout).toBe('kill');
		expect(name).toMatch(/^bdx-build-[0-9a-f]{8}$/);
		expect(input.metadata).toMatchObject({ beadsmith_write: '1', beadsmith_database: 'beads_web' });
		expect(input.metadata).not.toHaveProperty(SESSION_METADATA);
		// The loop writes code, so its checkout gets a token that can push.
		expect(mint_github_token).toHaveBeenCalledWith(
			'https://github.com/example-org/beads-web',
			true
		);
		expect(JSON.parse(sandbox.file('r1', 'loop.json')!)).toEqual([
			'ralph',
			'build',
			'--name',
			name,
			'--no-observer',
			'--max',
			'5',
			'--harness',
			'claude'
		]);
		expect(sandbox.file('r1', 'prompt')).toBeUndefined();
		expect(sandbox.started.map((s) => s.command)).toEqual(['beadsmith-run r1']);
		// Keys stay at the egress; the sandbox holds only the project's Dolt account.
		expect(JSON.stringify(input.envs)).not.toContain(ANTHROPIC_KEY);
		expect(JSON.stringify(input.envs)).not.toContain(GITHUB_TOKEN);
	});

	it('starts ralph serve and the loop as hc terminals once, then reports iterations', async () => {
		const { provider, claude, ralph, sandbox, name } = await launched();
		// ralph has not recorded the run yet: still starting.
		expect(await provider.getRun('sbx1', 'r1')).toEqual({ status: 'running' });
		const started = terminals(claude);
		expect(started.map((t) => [t.name, t.cwd])).toEqual([
			[SERVE_TERMINAL, WORK_DIR],
			[LOOP_TERMINAL, WORK_DIR]
		]);
		expect(started[0].argv).toEqual(['ralph', 'serve', '--no-web', '--port', '7420']);
		expect(started[1].argv).toEqual(JSON.parse(sandbox.file('r1', 'loop.json')!));
		expect(sandbox.file('r1', 'started')).toBe('');

		ralph.addRun({ name });
		ralph.iterations.set(name, [
			{
				iteration: 1,
				outcome: 'completed',
				startedAt: '2026-11-11T10:00:00.000Z',
				finishedAt: '2026-11-11T10:04:00.000Z',
				durationMs: 240_000,
				headBefore: 'aaaaaaa',
				headAfter: 'bbbbbbb',
				inputTokens: 100,
				outputTokens: 50,
				costUsd: 0.25,
				validateOk: true,
				planOpen: 4,
				lastMessage: 'secret agent words'
			}
		]);
		const update = await provider.getRun('sbx1', 'r1');
		expect(update.status).toBe('running');
		expect(update.iterations).toEqual([
			expect.objectContaining({ iteration: 1, outcome: 'completed', plan_open: 4 })
		]);
		expect(JSON.stringify(update)).not.toContain('secret agent words');
		// Nothing started twice.
		expect(terminals(claude)).toHaveLength(2);
		// Only allowlisted ralph routes.
		expect(ralph.requests.every((r) => r.method === 'GET')).toBe(true);
	});

	it('gives a loop the run limit again each time it finishes an iteration', async () => {
		const { provider, ralph, sandbox, name } = await launched();
		const max_run_ms = SETTINGS.max_run_minutes * 60_000;
		const iteration = (n: number) => ({
			iteration: n,
			outcome: 'completed',
			startedAt: '2026-11-11T10:00:00.000Z',
			finishedAt: '2026-11-11T10:50:00.000Z',
			durationMs: 3_000_000,
			headBefore: null,
			headAfter: null,
			inputTokens: 1,
			outputTokens: 1,
			costUsd: null,
			validateOk: null,
			planOpen: null
		});
		// ralph has not recorded the run: no sign of progress, no extension.
		await provider.getRun('sbx1', 'r1');
		expect(sandbox.timeouts).toEqual([]);

		ralph.addRun({ name });
		await provider.getRun('sbx1', 'r1');
		// The first sight of a live run counts as progress.
		expect(sandbox.timeouts).toEqual([max_run_ms]);
		await provider.getRun('sbx1', 'r1');
		expect(sandbox.timeouts).toEqual([max_run_ms]);

		ralph.iterations.set(name, [iteration(1)]);
		expect((await provider.getRun('sbx1', 'r1')).status).toBe('running');
		expect(sandbox.timeouts).toEqual([max_run_ms, max_run_ms]);
		// Stuck in iteration 2: no more time, so the run limit cuts it off.
		await provider.getRun('sbx1', 'r1');
		await provider.getRun('sbx1', 'r1');
		expect(sandbox.timeouts).toEqual([max_run_ms, max_run_ms]);

		ralph.iterations.set(name, [iteration(1), iteration(2)]);
		await provider.getRun('sbx1', 'r1');
		expect(sandbox.timeouts).toEqual([max_run_ms, max_run_ms, max_run_ms]);

		// Ended: the idle window replaces the run limit.
		ralph.addRun({ name, status: 'finished', alive: false, stopReason: 'max_iterations' });
		expect((await provider.getRun('sbx1', 'r1')).status).not.toBe('running');
		expect(sandbox.timeouts.at(-1)).toBe(SETTINGS.idle_minutes * 60_000);
	});

	it('keeps reporting a running loop when its sandbox cannot get more time', async () => {
		const { provider, ralph, sandbox, name, logs } = await launched();
		await provider.getRun('sbx1', 'r1');
		ralph.addRun({ name });
		sandbox.setTimeout = async () => {
			throw new Error('rate limited');
		};
		expect((await provider.getRun('sbx1', 'r1')).status).toBe('running');
		expect(logs.join('\n')).toContain('could not extend the run limit');
	});

	it("replaces a running loop's GitHub token at the egress before its hour runs out", async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			vi.setSystemTime(new Date('2026-11-11T10:00:00Z'));
			const { provider, ralph, sandbox, name, mint_github_token, restartServer } = await launched();
			expect(mint_github_token).toHaveBeenCalledTimes(1);
			ralph.addRun({ name });
			await provider.getRun('sbx1', 'r1');
			vi.setSystemTime(new Date('2026-11-11T10:44:00Z'));
			await provider.getRun('sbx1', 'r1');
			// Still fresh: the egress keeps the launch token.
			expect(sandbox.networks).toHaveLength(0);

			mint_github_token.mockResolvedValueOnce('ghs_refreshed_token_000000000000');
			vi.setSystemTime(new Date('2026-11-11T10:46:00Z'));
			expect((await provider.getRun('sbx1', 'r1')).status).toBe('running');
			expect(sandbox.networks).toHaveLength(1);
			// Same scope as at launch: the one repository, write.
			expect(mint_github_token).toHaveBeenLastCalledWith(
				'https://github.com/example-org/beads-web',
				true
			);
			expect(sandbox.networks[0].headers['api.github.com']).toEqual({
				authorization: 'Bearer ghs_refreshed_token_000000000000'
			});
			await provider.getRun('sbx1', 'r1');
			expect(sandbox.networks).toHaveLength(1);

			// A failed refresh is retried on the next read.
			mint_github_token.mockRejectedValueOnce(new Error('GitHub could not be reached.'));
			vi.setSystemTime(new Date('2026-11-11T11:32:00Z'));
			expect((await provider.getRun('sbx1', 'r1')).status).toBe('running');
			expect(sandbox.networks).toHaveLength(1);
			await provider.getRun('sbx1', 'r1');
			expect(sandbox.networks).toHaveLength(2);

			// After a Beadsmith restart nothing says how old the token is: mint now.
			const restarted = restartServer();
			await restarted.getRun('sbx1', 'r1');
			expect(sandbox.networks).toHaveLength(3);
			await restarted.getRun('sbx1', 'r1');
			expect(sandbox.networks).toHaveLength(3);

			// An ended loop is not refreshed.
			ralph.addRun({ name, status: 'finished', alive: false, stopReason: 'max_iterations' });
			vi.setSystemTime(new Date('2026-11-11T13:00:00Z'));
			await restarted.getRun('sbx1', 'r1');
			expect(sandbox.networks).toHaveLength(3);
		} finally {
			vi.useRealTimers();
		}
	});

	it('relays the loop terminal, not ralph serve', async () => {
		const { provider, claude } = await launched();
		await provider.getRun('sbx1', 'r1');
		const loop = terminals(claude).find((t) => t.name === LOOP_TERMINAL)!;
		const relay = await provider.attachTerminal!('sbx1', {
			mode: 'watch',
			cols: 80,
			rows: 24,
			onData: () => {}
		});
		const attach = claude.core.calls.findLast((call) => call.method === 'terminal.attach');
		expect(attach?.params.terminal).toBe(loop.address);
		relay.close();
	});

	it('maps a finished loop onto the mission and lets the sandbox go', async () => {
		const { provider, claude, ralph, sandbox, name } = await launched();
		await provider.getRun('sbx1', 'r1');
		ralph.addRun({ name, status: 'finished', alive: false, stopReason: 'plan_exhausted' });
		ralph.reports.set(name, {
			stopReason: 'plan_exhausted',
			iterations: 3,
			durationMs: 900_000,
			needsHuman: [`bw-9 needs a decision; password ${DOLT_PASSWORD}`]
		});
		claude.core.exit(terminals(claude)[1].address, 3);
		const update = await provider.getRun('sbx1', 'r1');
		expect(update).toMatchObject({ status: 'succeeded', duration_ms: 900_000 });
		expect(update.result_summary).toContain('The loop ended after 3 iterations');
		expect(update.result_summary).toContain('A person should look.');
		expect(update.result_summary).toContain('bw-9 needs a decision');
		expect(update.result_summary).not.toContain(DOLT_PASSWORD);
		expect(update.loop_end).toEqual({ stop_reason: 'plan_exhausted', needs_person: true });
		expect(JSON.parse(sandbox.file('r1', 'result.json')!)).toMatchObject({ status: 'succeeded' });
		// Later reads come from result.json and keep how the loop ended.
		expect((await provider.getRun('sbx1', 'r1')).loop_end).toEqual({
			stop_reason: 'plan_exhausted',
			needs_person: true
		});
		expect(sandbox.timeouts.at(-1)).toBe(SETTINGS.idle_minutes * 60_000);
		expect(sandbox.killed).toBe(false);
	});

	it('asks for a person when the report does, even after a clean stop', async () => {
		const { provider, claude, ralph, name } = await launched();
		await provider.getRun('sbx1', 'r1');
		ralph.addRun({ name, status: 'finished', alive: false, stopReason: 'max_iterations' });
		ralph.reports.set(name, {
			stopReason: 'max_iterations',
			iterations: 5,
			durationMs: 60_000,
			needsHuman: ['bw-3 is blocked on a credential']
		});
		claude.core.exit(terminals(claude)[1].address, 0);
		const update = await provider.getRun('sbx1', 'r1');
		expect(update.status).toBe('succeeded');
		expect(update.loop_end).toEqual({ stop_reason: 'max_iterations', needs_person: true });
	});

	it('fails with a clear message when the template has no ralph', async () => {
		const { provider, claude } = await launched();
		await provider.getRun('sbx1', 'r1');
		claude.core.exit(terminals(claude)[1].address, 127);
		expect(await provider.getRun('sbx1', 'r1')).toEqual({
			status: 'failed',
			error_message: 'This sandbox has no ralph. Rebuild the Sand template (docs/sand-e2b.md).'
		});
	});

	it('cancels by stopping ralph now and ending its terminal', async () => {
		const { provider, claude, ralph, name } = await launched();
		await provider.getRun('sbx1', 'r1');
		ralph.addRun({ name });
		await provider.cancelRun!('sbx1', 'r1');
		expect(ralph.stops).toEqual([{ name, graceful: false }]);
		expect(terminals(claude).find((t) => t.name === LOOP_TERMINAL)?.state).toBe('finished');
		expect(await provider.getRun('sbx1', 'r1')).toEqual({ status: 'cancelled' });
		await expect(provider.cancelRun!('sbx1', 'r1')).rejects.toThrow(RUN_NOT_CANCELLABLE_MESSAGE);
	});

	it('steers a running loop through ralph, and refuses before it starts or after it ends', async () => {
		const { provider, ralph, name } = await launched();
		// Setup has not started ralph yet.
		await expect(provider.steerRun!('sbx1', 'r1', 'Fix the test first.')).rejects.toThrow(
			LOOP_NOT_RUNNING_MESSAGE
		);
		await provider.getRun('sbx1', 'r1');
		// Started, but ralph has not recorded the run: its 404 reads as not running.
		await expect(provider.steerRun!('sbx1', 'r1', 'Fix the test first.')).rejects.toThrow(
			LOOP_NOT_RUNNING_MESSAGE
		);
		const run = ralph.addRun({ name });
		await provider.steerRun!('sbx1', 'r1', 'Fix the test first.');
		expect(ralph.steers).toEqual([{ name, text: 'Fix the test first.' }]);
		run.status = 'finished';
		await expect(provider.steerRun!('sbx1', 'r1', 'Too late.')).rejects.toMatchObject({
			code: 'conflict',
			message: LOOP_NOT_RUNNING_MESSAGE
		});
		expect(ralph.requests.every((r) => ralphRouteAllowed(r.method, r.path))).toBe(true);
	});

	it("stops after the iteration with ralph's graceful stop, leaving the terminal running", async () => {
		const { provider, claude, ralph, name } = await launched();
		await provider.getRun('sbx1', 'r1');
		const run = ralph.addRun({ name });
		await provider.stopRunAfterIteration!('sbx1', 'r1');
		expect(ralph.stops).toEqual([{ name, graceful: true }]);
		expect(terminals(claude).find((t) => t.name === LOOP_TERMINAL)?.state).not.toBe('finished');
		expect((await provider.getRun('sbx1', 'r1')).status).toBe('running');
		run.status = 'stopped';
		await expect(provider.stopRunAfterIteration!('sbx1', 'r1')).rejects.toMatchObject({
			code: 'conflict'
		});
	});

	it('refuses loop controls on a one-shot mission', async () => {
		const env = setup();
		const launch = await env.provider.launch(TACKLE);
		await expect(env.provider.steerRun!(launch.agent_id, 'r1', 'Hi.')).rejects.toThrow(
			LOOP_NOT_RUNNING_MESSAGE
		);
		await expect(env.provider.stopRunAfterIteration!(launch.agent_id, 'r1')).rejects.toThrow(
			LOOP_NOT_RUNNING_MESSAGE
		);
	});

	it('refuses a follow-up', async () => {
		const { provider } = await launched();
		await expect(provider.createRun!('sbx1', 'more')).rejects.toThrow('A loop takes no follow-up.');
	});

	/** A launched loop whose first run ralph finished and Beadsmith recorded. */
	async function ended() {
		const env = await launched();
		await env.provider.getRun('sbx1', 'r1');
		env.ralph.addRun({
			name: env.name,
			status: 'finished',
			alive: false,
			stopReason: 'max_iterations'
		});
		env.claude.core.exit(terminals(env.claude)[1].address, 0);
		expect((await env.provider.getRun('sbx1', 'r1')).status).toBe('succeeded');
		return env;
	}

	it('restarts an ended loop in its live sandbox as a new run with its own names', async () => {
		const { provider, claude, ralph, sandbox, name, created, mint_github_token } = await ended();
		const restarted = await provider.restartLoop!('sbx1', 'r1', {
			...LOOP,
			loop: { ...LOOP.loop, max_iterations: 2 }
		});
		expect(restarted).toEqual({ agent_id: 'sbx1', run_id: 'r2' });
		// Same sandbox and checkout: nothing created, a fresh push token, the full run limit.
		expect(created).toHaveLength(1);
		expect(sandbox.networks).toHaveLength(1);
		expect(mint_github_token).toHaveBeenCalledTimes(2);
		expect(sandbox.timeouts.at(-1)).toBe(SETTINGS.max_run_minutes * 60_000);
		expect(sandbox.started.map((s) => s.command)).toEqual(['beadsmith-run r1', 'beadsmith-run r2']);
		expect(JSON.parse(sandbox.file('r2', 'loop.json')!)).toEqual([
			'ralph',
			'build',
			'--name',
			`${name}-r2`,
			'--no-observer',
			'--max',
			'2',
			'--harness',
			'claude'
		]);

		// The new run starts in a terminal of its own; the first run keeps its result.
		expect(await provider.getRun('sbx1', 'r2')).toEqual({ status: 'running' });
		const loop = terminals(claude).find((t) => t.name === loopTerminalName('r2'))!;
		expect(loop.argv).toEqual(JSON.parse(sandbox.file('r2', 'loop.json')!));
		expect(loopTerminalName('r2')).not.toBe(LOOP_TERMINAL);
		expect((await provider.getRun('sbx1', 'r1')).status).toBe('succeeded');

		// Controls and the relay address the new run.
		ralph.addRun({ name: `${name}-r2` });
		await provider.steerRun!('sbx1', 'r2', 'Smaller steps.');
		expect(ralph.steers).toEqual([{ name: `${name}-r2`, text: 'Smaller steps.' }]);
		const relay = await provider.attachTerminal!('sbx1', {
			mode: 'watch',
			cols: 80,
			rows: 24,
			onData: () => {}
		});
		const attach = claude.core.calls.findLast((call) => call.method === 'terminal.attach');
		expect(attach?.params.terminal).toBe(loop.address);
		relay.close();
	});

	it('restarts in a fresh sandbox once E2B has destroyed the old one, numbering on', async () => {
		const { provider, sandboxes, states, metadata, created } = await ended();
		// E2B no longer knows it.
		states.delete('sbx1');
		const restarted = await provider.restartLoop!('sbx1', 'r1', LOOP);
		expect(restarted).toEqual({ agent_id: 'sbx2', run_id: 'r2' });
		expect(created).toHaveLength(2);
		expect(created[1].on_timeout).toBe('kill');
		const base = metadata.get('sbx2')![LOOP_METADATA];
		expect(base).toMatch(/^bdx-build-[0-9a-f]{8}$/);
		const fresh = sandboxes.get('sbx2')!;
		expect(fresh.started.map((s) => s.command)).toEqual(['beadsmith-run r2']);
		expect(JSON.parse(fresh.file('r2', 'loop.json')!)).toContain(`${base}-r2`);
		expect(await provider.getRun('sbx2', 'r2')).toEqual({ status: 'running' });
	});

	it('stops a run the sandbox still counts as working before starting the next', async () => {
		const { provider, ralph, sandbox, name } = await launched();
		await provider.getRun('sbx1', 'r1');
		ralph.addRun({ name });
		await provider.restartLoop!('sbx1', 'r1', LOOP);
		expect(ralph.stops).toEqual([{ name, graceful: false }]);
		expect(sandbox.runs.get('r1')?.cancelled).toBe(true);
		expect(sandbox.timeouts.at(-1)).toBe(SETTINGS.max_run_minutes * 60_000);
	});

	it('refuses a restart of a one-shot mission or of a run already restarted', async () => {
		const env = setup();
		const launch = await env.provider.launch(TACKLE);
		await expect(env.provider.restartLoop!(launch.agent_id, 'r1', LOOP)).rejects.toMatchObject({
			code: 'conflict',
			message: NOT_A_LOOP_SANDBOX_MESSAGE
		});
		const { provider } = await ended();
		await provider.restartLoop!('sbx1', 'r1', LOOP);
		await expect(provider.restartLoop!('sbx1', 'r1', LOOP)).rejects.toMatchObject({
			code: 'conflict',
			message: LOOP_ALREADY_RESTARTED_MESSAGE
		});
	});

	it('streams ralph events as mission events and records the result once', async () => {
		const { provider, ralph, sandbox, name } = await launched();
		await provider.getRun('sbx1', 'r1');
		ralph.addRun({ name });
		ralph.emit(name, { type: 'iteration_started' });
		ralph.emit(name, { type: 'assistant', text: `working with ${DOLT_PASSWORD}` });
		ralph.emit(name, { type: 'tool_call', name: 'Bash', input: { command: 'cat secrets' } });
		ralph.emit(name, { type: 'tool_result', isError: false, output: 'secret output' });
		const finished = ralph.emit(name, {
			type: 'run_finished',
			reason: 'plan_complete',
			iterations: 1
		});
		const run = ralph.runs.get(name)!;
		run.status = 'finished';
		run.alive = false;
		run.stopReason = 'plan_complete';
		const events: MissionEvent[] = [];
		const outcome = await provider.streamMissionEvents!('sbx1', 'r1', async (e) => {
			events.push(e);
		});
		expect(outcome).toBe('terminal');
		expect(events.map((e) => e.type)).toEqual(['assistant', 'tool_call', 'tool_call', 'result']);
		expect(JSON.stringify(events)).not.toContain(DOLT_PASSWORD);
		expect(JSON.stringify(events)).not.toContain('secret output');
		expect(events.at(-1)).toMatchObject({
			id: String(finished),
			status: 'succeeded',
			text: 'The loop ended after 1 iteration: no open plan items are left.'
		});
		expect(JSON.parse(sandbox.file('r1', 'result.json')!)).toMatchObject({
			status: 'succeeded',
			event_id: String(finished)
		});

		// A browser that already saw the result is not sent it again.
		const again: MissionEvent[] = [];
		await provider.streamMissionEvents!(
			'sbx1',
			'r1',
			async (e) => {
				again.push(e);
			},
			{ last_event_id: String(finished) }
		);
		expect(again).toEqual([]);
		// One that did not, is.
		await provider.streamMissionEvents!('sbx1', 'r1', async (e) => {
			again.push(e);
		});
		expect(again).toEqual([expect.objectContaining({ type: 'result', id: String(finished) })]);
	});
});
