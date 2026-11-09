import { describe, expect, it, vi } from 'vitest';
import { parseE2bSettings } from '../env.js';
import type { MissionEvent } from '#lib/mission-events.js';
import {
	buildSandboxNetwork,
	createE2bProvider,
	parseRunFiles,
	runUpdateFromFiles,
	type SandboxCreateInput,
	type SandboxDriver,
	type SandboxNetwork,
	type SandboxRef
} from './e2b-provider.js';
import { AGENT_BUSY_MESSAGE } from './provider.js';
import { ANTHROPIC_PLACEHOLDER } from '../e2b/sandbox.js';

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

/** One run's files inside the fake sandbox. */
interface FakeRun {
	exit?: number;
	cancelled?: boolean;
	result?: string;
	events?: string[];
}

class FakeSandbox implements SandboxRef {
	runs = new Map<string, FakeRun>();
	files = new Map<string, string>();
	started: { command: string; envs: Record<string, string> }[] = [];
	networks: SandboxNetwork[] = [];
	timeouts: number[] = [];
	killed = false;
	constructor(readonly id: string) {}

	async exec(command: string) {
		const status = /^d='[^']+\/(r[0-9]+)'; if \[ ! -d/.exec(command);
		if (status) {
			const run = this.runs.get(status[1]);
			if (run === undefined) return { exit_code: 0, stdout: 'missing\n' };
			return {
				exit_code: 0,
				stdout:
					`exit=${run.exit ?? ''}\ncancelled=${run.cancelled ? '1' : ''}\n` +
					`started=1000\nfinished=6000\nresult=${run.result ?? ''}\n`
			};
		}
		if (command.startsWith('tail -c')) {
			return {
				exit_code: 0,
				stdout: `Error: Dolt refused ${DOLT_PASSWORD}\n--- setup.log\ncloning…\n`
			};
		}
		if (command.startsWith('ls -1')) {
			return { exit_code: 0, stdout: [...this.runs.keys()].join('\n') };
		}
		const cancel = /^d='[^']+\/(r[0-9]+)'; \[ -d/.exec(command);
		if (cancel) {
			const run = this.runs.get(cancel[1]);
			if (run === undefined || run.exit !== undefined) return { exit_code: 3, stdout: '' };
			run.cancelled = true;
			return { exit_code: 0, stdout: '' };
		}
		return { exit_code: 0, stdout: '' };
	}
	async start(command: string, envs: Record<string, string>) {
		this.started.push({ command, envs });
		const run_id = command.split(' ')[1];
		this.runs.set(run_id, {});
	}
	async follow(command: string, on_stdout: (chunk: string) => void) {
		const run_id = /runs\/(r[0-9]+)'/.exec(command)?.[1] ?? '';
		const from = Number(/tail -n \+([0-9]+)/.exec(command)?.[1] ?? '1');
		const lines = (this.runs.get(run_id)?.events ?? []).slice(from - 1);
		// Split across chunks to exercise line buffering.
		const text = lines.map((entry) => `${entry}\n`).join('');
		on_stdout(text.slice(0, 7));
		on_stdout(text.slice(7));
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
	async interactive(): Promise<never> {
		throw new Error('dispatch never starts an interactive command');
	}
}

function setup(overrides: { create_fails?: boolean } = {}) {
	const sandboxes = new Map<string, FakeSandbox>();
	const states = new Map<string, 'running' | 'paused'>();
	const metadata = new Map<string, Record<string, string>>();
	const created: SandboxCreateInput[] = [];
	const driver: SandboxDriver = {
		async create(input) {
			if (overrides.create_fails) throw new Error(`quota exceeded for key ${ANTHROPIC_KEY}`);
			created.push(input);
			const sandbox = new FakeSandbox(`sbx${sandboxes.size + 1}`);
			sandboxes.set(sandbox.id, sandbox);
			states.set(sandbox.id, 'running');
			metadata.set(sandbox.id, input.metadata);
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
	const provider = createE2bProvider({
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
		log: (message) => logs.push(message)
	});
	return { provider, sandboxes, states, created, mint_github_token, mint_tailscale_key, logs };
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
		expect(input.envs).toMatchObject({
			ANTHROPIC_API_KEY: ANTHROPIC_PLACEHOLDER,
			BEADS_DOLT_SERVER_HOST: '127.0.0.1',
			BEADS_DOLT_SERVER_USER: 'sbx_beads_web',
			BEADS_DOLT_PASSWORD: DOLT_PASSWORD,
			BEADS_DOLT_SERVER_DATABASE: 'beads_web',
			BEADSMITH_DOLT_TAILNET_HOST: 'beads',
			BEADSMITH_REPO_URL: TACKLE.repository.url
		});
		// Rule 6: the real keys only travel in the egress rules.
		const envs = JSON.stringify(input.envs);
		expect(envs).not.toContain(ANTHROPIC_KEY);
		expect(envs).not.toContain(GITHUB_TOKEN);
		expect(input.network.headers['api.anthropic.com']['x-api-key']).toBe(ANTHROPIC_KEY);
		expect(mint_github_token).toHaveBeenCalledWith(TACKLE.repository.url, true);

		const sandbox = sandboxes.get('sbx1')!;
		expect(sandbox.files.get('/home/user/.beadsmith/runs/r1/prompt')).toBe('Tackle bw-1');
		expect(sandbox.started).toEqual([
			{
				command: 'beadsmith-run r1',
				envs: { BEADSMITH_TS_AUTHKEY: 'tskey-auth-single-use', BEADSMITH_CONTINUE: '0' }
			}
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

	it('logs the end of a failed run, redacted, once', async () => {
		const { provider, sandboxes, logs } = setup();
		await provider.launch(TACKLE);
		sandboxes.get('sbx1')!.runs.set('r1', { exit: 1 });
		expect(await provider.getRun('sbx1', 'r1')).toMatchObject({ status: 'failed' });
		await provider.getRun('sbx1', 'r1');
		expect(logs).toHaveLength(1);
		expect(logs[0]).toContain('sbx1/r1 exited 1');
		expect(logs[0]).toContain('Dolt refused [redacted]');
		expect(logs[0]).not.toContain(DOLT_PASSWORD);
	});

	it('reads run status from the run files and sets the idle timeout once finished', async () => {
		const { provider, sandboxes } = setup();
		await provider.launch(TACKLE);
		const sandbox = sandboxes.get('sbx1')!;
		expect(await provider.getRun('sbx1', 'r1')).toEqual({ status: 'running' });
		expect(sandbox.timeouts).toEqual([]);

		sandbox.runs.set('r1', {
			exit: 0,
			result: JSON.stringify({
				type: 'result',
				subtype: 'success',
				is_error: false,
				duration_ms: 5000,
				result: `Opened https://github.com/example-org/beads-web/pull/7 (db password ${DOLT_PASSWORD})`
			})
		});
		const update = await provider.getRun('sbx1', 'r1');
		expect(update).toMatchObject({
			status: 'succeeded',
			duration_ms: 5000,
			git_pr_url: 'https://github.com/example-org/beads-web/pull/7'
		});
		expect(update.result_summary).not.toContain(DOLT_PASSWORD);
		expect(sandbox.timeouts).toEqual([10 * 60_000]);
		// Cached: a later read does not need the sandbox.
		sandbox.runs.clear();
		expect(await provider.getRun('sbx1', 'r1')).toMatchObject({ status: 'succeeded' });
	});

	it('reports a gone or time-limited sandbox as failed', async () => {
		const { provider, states } = setup();
		await provider.launch(TACKLE);
		states.set('sbx1', 'paused');
		expect(await provider.getRun('sbx1', 'r1')).toMatchObject({
			status: 'failed',
			error_message: expect.stringContaining('55-minute limit')
		});
		expect(await provider.getRun('sbx-gone', 'r1')).toMatchObject({ status: 'failed' });
	});

	it('continues the session in a new run, with a fresh token and the full time limit', async () => {
		const { provider, sandboxes, mint_github_token } = setup();
		await provider.launch(TACKLE);
		const sandbox = sandboxes.get('sbx1')!;
		await expect(provider.createRun?.('sbx1', 'more')).rejects.toThrow(AGENT_BUSY_MESSAGE);

		sandbox.runs.set('r1', { exit: 0 });
		expect(await provider.createRun?.('sbx1', 'more')).toEqual({ run_id: 'r2' });
		expect(sandbox.started.at(-1)).toMatchObject({
			command: 'beadsmith-run r2',
			envs: { BEADSMITH_CONTINUE: '1' }
		});
		expect(sandbox.files.get('/home/user/.beadsmith/runs/r2/prompt')).toBe('more');
		expect(sandbox.networks).toHaveLength(1);
		expect(mint_github_token).toHaveBeenCalledTimes(2);
		expect(sandbox.timeouts.at(-1)).toBe(55 * 60_000);
	});

	it('stops a run cut off by the time limit before continuing', async () => {
		const { provider, sandboxes, states } = setup();
		await provider.launch(TACKLE);
		states.set('sbx1', 'paused');
		expect(await provider.createRun?.('sbx1', 'pick it up')).toEqual({ run_id: 'r2' });
		expect(sandboxes.get('sbx1')!.runs.get('r1')?.cancelled).toBe(true);
	});

	it('cancels a working run and refuses a finished one', async () => {
		const { provider, sandboxes } = setup();
		await provider.launch(TACKLE);
		await provider.cancelRun?.('sbx1', 'r1');
		expect(await provider.getRun('sbx1', 'r1')).toEqual({ status: 'cancelled' });
		sandboxes.get('sbx1')!.runs.set('r2', { exit: 0 });
		await expect(provider.cancelRun?.('sbx1', 'r2')).rejects.toThrow(
			'This run cannot be cancelled.'
		);
	});

	it('streams the event log as mission events and resumes after the last id', async () => {
		const { provider, sandboxes } = setup();
		await provider.launch(TACKLE);
		const run = sandboxes.get('sbx1')!.runs.get('r1')!;
		const result = JSON.stringify({
			type: 'result',
			subtype: 'success',
			is_error: false,
			result: 'done'
		});
		run.events = [
			JSON.stringify({ type: 'system', subtype: 'init' }),
			JSON.stringify({
				type: 'assistant',
				message: { content: [{ type: 'text', text: 'hello' }] }
			}),
			result
		];
		run.exit = 0;
		run.result = result;

		const events: MissionEvent[] = [];
		const outcome = await provider.streamMissionEvents?.('sbx1', 'r1', async (event) => {
			events.push(event);
		});
		expect(outcome).toBe('terminal');
		expect(events).toEqual([
			{ type: 'assistant', id: '2.0', text: 'hello' },
			{ type: 'result', id: '3.0', status: 'succeeded', text: 'done' }
		]);

		const resumed: MissionEvent[] = [];
		await provider.streamMissionEvents?.(
			'sbx1',
			'r1',
			async (event) => {
				resumed.push(event);
			},
			{ last_event_id: '2.0' }
		);
		expect(resumed.map((event) => event.id)).toEqual(['3.0']);
	});

	it('ends a cancelled stream with a cancelled result', async () => {
		const { provider, sandboxes } = setup();
		await provider.launch(TACKLE);
		const run = sandboxes.get('sbx1')!.runs.get('r1')!;
		run.events = [];
		run.cancelled = true;
		run.exit = 143;
		const events: MissionEvent[] = [];
		await provider.streamMissionEvents?.('sbx1', 'r1', async (event) => {
			events.push(event);
		});
		expect(events).toEqual([expect.objectContaining({ type: 'result', status: 'cancelled' })]);
	});
});

describe('run files', () => {
	it('parses the status script output', () => {
		expect(parseRunFiles('missing\n')).toEqual({ exists: false, cancelled: false });
		expect(parseRunFiles('exit=1\ncancelled=\nstarted=10\nfinished=30\nresult=\n')).toEqual({
			exists: true,
			exit_code: 1,
			cancelled: false,
			started_ms: 10,
			finished_ms: 30,
			result_line: undefined
		});
	});

	it('explains an exit without a result', () => {
		expect(
			runUpdateFromFiles(
				{ exists: true, exit_code: 2, cancelled: false, started_ms: 10, finished_ms: 30 },
				''
			)
		).toEqual({
			status: 'failed',
			duration_ms: 20,
			error_message: 'The agent exited with code 2 before reporting a result.'
		});
	});

	it('names the setup step that failed', () => {
		expect(runUpdateFromFiles({ exists: true, exit_code: 10, cancelled: false }, '')).toMatchObject(
			{ status: 'failed', error_message: 'The sandbox could not join the tailnet.' }
		);
		expect(runUpdateFromFiles({ exists: true, exit_code: 13, cancelled: false }, '')).toMatchObject(
			{ error_message: 'The sandbox joined the tailnet but Dolt did not answer.' }
		);
	});
});
