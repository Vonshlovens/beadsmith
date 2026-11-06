/**
 * E2B dispatch provider ("Sand" in the UI): one hosted E2B sandbox per
 * mission, built from the template in `sandbox/e2b/` (ADR-0016,
 * docs/sand-e2b.md). Each sandbox is its own Firecracker microVM, so this
 * needs no KVM host of ours.
 *
 * Mapping onto `AgentProvider`:
 *
 * - agent id = E2B sandbox id; run ids are `r1`, `r2`, … (one per prompt).
 * - launch creates the sandbox, writes the prompt and starts
 *   `beadsmith-run r1` in the background. That script joins the tailnet with
 *   a fresh ephemeral key, forwards 127.0.0.1:3306 to Dolt over it, checks
 *   out the repository (first run only) and runs Claude Code headless, writing
 *   its event log, exit code and timing under `~/.beadsmith/runs/<run>/`.
 * - run status reads those files. A finished sandbox gets a short idle
 *   timeout and then pauses (not billed for compute), so a follow-up resumes
 *   it and continues the same Claude session.
 * - live events tail the event log and map it through `claude-stream.ts`.
 *
 * Keys stay outside the sandbox (ADR-0015, rule 6): the Anthropic key and the
 * GitHub token are added to outbound requests by E2B's egress proxy; inside,
 * the agent sees placeholders. The project's scoped Dolt account and a
 * single-use Tailscale key are the only credentials it holds.
 */
import type { MissionEvent } from '#lib/mission-events.js';
import type { E2bSettings } from '../env.js';
import {
	AGENT_BUSY_MESSAGE,
	RUN_NOT_CANCELLABLE_MESSAGE,
	type AgentFollowUpRun,
	type AgentLaunch,
	type AgentLaunchInput,
	type AgentProvider,
	type AgentRunUpdate,
	type AgentStreamOptions,
	type AgentStreamOutcome
} from './provider.js';
import {
	ClaudeStreamMapper,
	findPullRequestUrl,
	parseClaudeResult,
	parseStreamEventId
} from './claude-stream.js';
import {
	mintGithubRepositoryToken,
	mintTailscaleAuthKey,
	parseGithubRepository,
	readDoltAccount,
	readSecretFile
} from './sandbox-credentials.js';
import { readGithubPullUrl } from './sanitize.js';
import { DispatchError } from './types.js';
import {
	buildSandboxNetwork,
	createSdkDriver,
	GITHUB_PLACEHOLDER,
	modelPlaceholderEnvs,
	readModelCredential,
	type SandboxDriver,
	type SandboxInfo,
	type SandboxNetwork,
	type SandboxRef
} from '../e2b/sandbox.js';

export { buildSandboxNetwork };
export type {
	SandboxCreateInput,
	SandboxDriver,
	SandboxNetwork,
	SandboxRef
} from '../e2b/sandbox.js';

/** Where the template's `beadsmith-run` keeps each run (the default user's home). */
export const RUNS_DIR = '/home/user/.beadsmith/runs';
const RUN_ID_PATTERN = /^r[1-9][0-9]{0,5}$/;
const SANDBOX_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const DEFAULT_DOLT_LOCAL_PORT = '3306';

export interface E2bProviderDeps {
	settings: E2bSettings;
	label: string;
	driver?: SandboxDriver;
	/** Secret file reader; tests replace it. */
	read_secret?: (path: string, what: string) => Promise<string>;
	mint_tailscale_key?: () => Promise<string>;
	mint_github_token?: (repository_url: string, write: boolean) => Promise<string>;
	read_dolt_account?: (database: string) => Promise<{ user: string; password: string }>;
}

function requireSandboxId(value: string): string {
	if (!SANDBOX_ID_PATTERN.test(value)) throw new DispatchError('unavailable', 'Invalid agent id.');
	return value;
}

function requireRunId(value: string): string {
	if (!RUN_ID_PATTERN.test(value)) throw new DispatchError('unavailable', 'Invalid run id.');
	return value;
}

function runNumber(run_id: string): number {
	return Number(run_id.slice(1));
}

interface RunFiles {
	exists: boolean;
	exit_code?: number;
	cancelled: boolean;
	started_ms?: number;
	finished_ms?: number;
	result_line?: string;
}

function statusCommand(run_id: string): string {
	const dir = `${RUNS_DIR}/${run_id}`;
	return [
		`d='${dir}'`,
		`if [ ! -d "$d" ]; then echo missing; exit 0; fi`,
		`printf 'exit=%s\\n' "$(cat "$d/exit" 2>/dev/null)"`,
		`printf 'cancelled=%s\\n' "$([ -f "$d/cancelled" ] && echo 1)"`,
		`printf 'started=%s\\n' "$(cat "$d/started_ms" 2>/dev/null)"`,
		`printf 'finished=%s\\n' "$(cat "$d/finished_ms" 2>/dev/null)"`,
		`printf 'result='; grep -a '"type":"result"' "$d/events.jsonl" 2>/dev/null | tail -n 1`
	].join('; ');
}

/**
 * Mark a run cancelled, then stop its process group. Marking first means
 * status reads `cancelled` even if the kill races the exit. Exit 3: nothing
 * to cancel (no such run, or it already finished).
 */
function cancelCommand(run_id: string): string {
	return (
		`d='${RUNS_DIR}/${run_id}'; [ -d "$d" ] && [ ! -f "$d/exit" ] || exit 3; touch "$d/cancelled"; ` +
		`kill -TERM -- "-$(cat "$d/pid")" 2>/dev/null || kill -TERM "$(cat "$d/pid")" 2>/dev/null; true`
	);
}

function readInt(value: string | undefined): number | undefined {
	if (value === undefined || !/^[0-9]{1,15}$/.test(value)) return undefined;
	return Number(value);
}

/** Parse `statusCommand` output. */
export function parseRunFiles(stdout: string): RunFiles {
	if (stdout.trim() === 'missing') return { exists: false, cancelled: false };
	const fields = new Map<string, string>();
	for (const line of stdout.split('\n')) {
		const eq = line.indexOf('=');
		if (eq > 0 && !fields.has(line.slice(0, eq))) fields.set(line.slice(0, eq), line.slice(eq + 1));
	}
	const result_line = fields.get('result')?.trim();
	return {
		exists: true,
		exit_code: readInt(fields.get('exit')?.trim()),
		cancelled: fields.get('cancelled')?.trim() === '1',
		started_ms: readInt(fields.get('started')?.trim()),
		finished_ms: readInt(fields.get('finished')?.trim()),
		result_line: result_line === undefined || result_line === '' ? undefined : result_line
	};
}

/** A run's files → the provider-neutral run update. */
export function runUpdateFromFiles(files: RunFiles, redact: string): AgentRunUpdate {
	if (!files.exists) {
		return { status: 'failed', error_message: 'The sandbox has no record of this run.' };
	}
	if (files.cancelled) return { status: 'cancelled' };
	if (files.exit_code === undefined) return { status: 'running' };
	const result =
		files.result_line === undefined ? undefined : parseClaudeResult(files.result_line, redact);
	const duration_ms =
		result?.duration_ms ??
		(files.started_ms !== undefined &&
		files.finished_ms !== undefined &&
		files.finished_ms >= files.started_ms
			? files.finished_ms - files.started_ms
			: undefined);
	const pr = readGithubPullUrl(findPullRequestUrl(result?.text), redact);
	const base = {
		...(result?.text === undefined ? {} : { result_summary: result.text }),
		...(duration_ms === undefined ? {} : { duration_ms }),
		...(pr === undefined ? {} : { git_pr_url: pr })
	};
	if (files.exit_code === 0 && result !== undefined && !result.is_error) {
		return { status: 'succeeded', ...base };
	}
	return {
		status: 'failed',
		...base,
		error_message:
			result === undefined
				? `The agent exited with code ${files.exit_code} before reporting a result.`
				: (result.text ?? 'The agent run failed.')
	};
}

export function createE2bProvider(deps: E2bProviderDeps): AgentProvider {
	const { settings } = deps;
	const read_secret = deps.read_secret ?? readSecretFile;
	const driver =
		deps.driver ?? createSdkDriver(() => read_secret(settings.api_key_file, 'E2B API key'));
	const max_run_ms = settings.max_run_minutes * 60_000;
	const idle_ms = settings.idle_minutes * 60_000;
	/** Terminal results already read, so a paused sandbox is not resumed to re-read them. */
	const finished = new Map<string, AgentRunUpdate>();

	const mintTailscale =
		deps.mint_tailscale_key ??
		(async () =>
			mintTailscaleAuthKey({
				client_id: settings.tailscale_client_id,
				client_secret: await read_secret(
					settings.tailscale_client_secret_file,
					'Tailscale OAuth client secret'
				),
				tags: settings.tailscale_tags
			}));

	const mintGithub =
		deps.mint_github_token ??
		(async (repository_url: string, write: boolean) => {
			if (
				settings.github_app_id === undefined ||
				settings.github_app_private_key_file === undefined
			) {
				throw new DispatchError(
					'forbidden',
					'Sandbox checkouts need the GitHub App (BDX_E2B_GITHUB_APP_ID); none is configured.'
				);
			}
			return mintGithubRepositoryToken({
				app_id: settings.github_app_id,
				private_key: await read_secret(
					settings.github_app_private_key_file,
					'GitHub App private key'
				),
				repository_url,
				write
			});
		});

	const doltAccount =
		deps.read_dolt_account ??
		((database: string) => readDoltAccount(settings.dolt_accounts_file, database));

	/** The project's Dolt password, redacted from anything read back. Empty if unknown. */
	async function redactionFor(info: SandboxInfo | undefined): Promise<string> {
		const database = info?.metadata.beadsmith_database;
		if (database === undefined) return '';
		try {
			return (await doltAccount(database)).password;
		} catch {
			return '';
		}
	}

	async function networkFor(metadata: Record<string, string>): Promise<SandboxNetwork> {
		const model = await readModelCredential(settings, read_secret);
		const repository = metadata.beadsmith_repository;
		const github =
			repository === undefined || repository === ''
				? undefined
				: await mintGithub(repository, metadata.beadsmith_write === '1');
		return buildSandboxNetwork(settings, model, github);
	}

	async function startRun(sandbox: SandboxRef, run_id: string, prompt: string, resume: boolean) {
		const dir = `${RUNS_DIR}/${run_id}`;
		await sandbox.exec(`mkdir -p '${dir}'`);
		await sandbox.writeFile(`${dir}/prompt`, prompt);
		await sandbox.start(`beadsmith-run ${run_id}`, {
			BEADSMITH_TS_AUTHKEY: await mintTailscale(),
			BEADSMITH_CONTINUE: resume ? '1' : '0'
		});
	}

	async function readRun(sandbox: SandboxRef, run_id: string): Promise<RunFiles> {
		const { stdout } = await sandbox.exec(statusCommand(run_id));
		return parseRunFiles(stdout);
	}

	async function latestRunId(sandbox: SandboxRef): Promise<string | undefined> {
		const { stdout } = await sandbox.exec(`ls -1 '${RUNS_DIR}' 2>/dev/null`);
		const runs = stdout
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => RUN_ID_PATTERN.test(line))
			.sort((a, b) => runNumber(a) - runNumber(b));
		return runs.at(-1);
	}

	async function connectOrGone(agent_id: string, timeout_ms: number): Promise<SandboxRef> {
		try {
			return await driver.connect(agent_id, timeout_ms);
		} catch {
			throw new DispatchError('conflict', "This agent's sandbox is gone. Start a new thread.");
		}
	}

	return {
		id: 'e2b',
		label: deps.label,

		async launch(input: AgentLaunchInput): Promise<AgentLaunch> {
			if (
				input.repository !== undefined &&
				parseGithubRepository(input.repository.url) === undefined
			) {
				throw new DispatchError(
					'unavailable',
					'Sandbox checkouts must be https://github.com repositories.'
				);
			}
			const account = await doltAccount(input.dolt_database);
			const metadata: Record<string, string> = {
				beadsmith: '1',
				beadsmith_database: input.dolt_database,
				beadsmith_repository: input.repository?.url ?? '',
				beadsmith_write: input.auto_create_pr ? '1' : '0'
			};
			const network = await networkFor(metadata);
			let sandbox: SandboxRef;
			try {
				sandbox = await driver.create({
					template: settings.template,
					timeout_ms: max_run_ms,
					metadata,
					network,
					envs: {
						BEADSMITH_AGENT_NAME: input.name,
						BEADSMITH_REPO_URL: input.repository?.url ?? '',
						BEADSMITH_REPO_REF: input.repository?.starting_ref ?? '',
						BEADSMITH_AUTO_CREATE_PR: input.auto_create_pr ? '1' : '0',
						BEADSMITH_TS_TAGS: settings.tailscale_tags.join(','),
						BEADSMITH_DOLT_TAILNET_HOST: settings.dolt_tailnet_host,
						BEADSMITH_DOLT_TAILNET_PORT: String(settings.dolt_tailnet_port),
						BEADS_DOLT_SERVER_HOST: '127.0.0.1',
						BEADS_DOLT_SERVER_PORT: DEFAULT_DOLT_LOCAL_PORT,
						BEADS_DOLT_SERVER_USER: account.user,
						BEADS_DOLT_PASSWORD: account.password,
						BEADS_DOLT_SERVER_DATABASE: input.dolt_database,
						BEADS_DOLT_AUTO_START: '0',
						...modelPlaceholderEnvs(
							settings.anthropic_api_key_file === undefined ? 'oauth_token' : 'api_key'
						),
						GH_TOKEN: GITHUB_PLACEHOLDER
					}
				});
			} catch (error) {
				if (error instanceof DispatchError) throw error;
				throw new DispatchError('unavailable', `${deps.label} could not create a sandbox.`);
			}
			try {
				await startRun(sandbox, 'r1', input.prompt, false);
			} catch (error) {
				// Do not leave a sandbox behind that will never report.
				await sandbox.kill().catch(() => undefined);
				if (error instanceof DispatchError) throw error;
				throw new DispatchError('unavailable', `${deps.label} could not start the agent.`);
			}
			return { agent_id: sandbox.id, run_id: 'r1' };
		},

		async getLatestRunId(agent_id: string): Promise<string | undefined> {
			const info = await driver.info(requireSandboxId(agent_id));
			if (info === undefined) return undefined;
			return latestRunId(await connectOrGone(agent_id, idle_ms));
		},

		async getRun(agent_id: string, run_id: string): Promise<AgentRunUpdate> {
			const key = `${requireSandboxId(agent_id)}/${requireRunId(run_id)}`;
			const cached = finished.get(key);
			if (cached !== undefined) return cached;
			const info = await driver.info(agent_id);
			if (info === undefined) {
				return {
					status: 'failed',
					error_message: 'The sandbox ended before the run reported a result.'
				};
			}
			if (info.state === 'paused') {
				// Only the time limit pauses a sandbox mid-run.
				return {
					status: 'failed',
					error_message: `The run reached ${deps.label}'s ${settings.max_run_minutes}-minute limit. Send a follow-up to resume it.`
				};
			}
			let sandbox: SandboxRef;
			try {
				sandbox = await driver.connect(agent_id, idle_ms);
			} catch {
				return {
					status: 'failed',
					error_message: 'The sandbox ended before the run reported a result.'
				};
			}
			const update = runUpdateFromFiles(await readRun(sandbox, run_id), await redactionFor(info));
			if (update.status !== 'running') {
				finished.set(key, update);
				// Finished: wait briefly for a follow-up, then pause (lifecycle onTimeout).
				await sandbox.setTimeout(idle_ms).catch(() => undefined);
			}
			return update;
		},

		async createRun(agent_id: string, prompt: string): Promise<AgentFollowUpRun> {
			const info = await driver.info(requireSandboxId(agent_id));
			if (info === undefined) {
				throw new DispatchError('conflict', "This agent's sandbox is gone. Start a new thread.");
			}
			const sandbox = await connectOrGone(agent_id, max_run_ms);
			const latest = await latestRunId(sandbox);
			if (latest !== undefined) {
				const files = await readRun(sandbox, latest);
				if (files.exists && files.exit_code === undefined && !files.cancelled) {
					// A run cut off by the time limit was already reported failed;
					// resuming would wake it, so stop it rather than call the agent busy.
					if (info.state !== 'paused') throw new DispatchError('conflict', AGENT_BUSY_MESSAGE);
					await sandbox.exec(cancelCommand(latest));
				}
			}
			const run_id = `r${latest === undefined ? 1 : runNumber(latest) + 1}`;
			// Fresh GitHub token (they last an hour) and the full run limit again.
			await sandbox.updateNetwork(await networkFor(info.metadata));
			await sandbox.setTimeout(max_run_ms);
			await startRun(sandbox, run_id, prompt, latest !== undefined);
			return { run_id };
		},

		async cancelRun(agent_id: string, run_id: string): Promise<void> {
			requireRunId(run_id);
			const info = await driver.info(requireSandboxId(agent_id));
			if (info === undefined) throw new DispatchError('conflict', RUN_NOT_CANCELLABLE_MESSAGE);
			const sandbox = await connectOrGone(agent_id, idle_ms);
			const { exit_code } = await sandbox.exec(cancelCommand(run_id));
			if (exit_code === 3) throw new DispatchError('conflict', RUN_NOT_CANCELLABLE_MESSAGE);
			await sandbox.setTimeout(idle_ms).catch(() => undefined);
		},

		async streamMissionEvents(
			agent_id: string,
			run_id: string,
			on_event: (event: MissionEvent) => Promise<void>,
			options: AgentStreamOptions = {}
		): Promise<AgentStreamOutcome> {
			requireRunId(run_id);
			const info = await driver.info(requireSandboxId(agent_id));
			if (info === undefined || info.state === 'paused') return 'stream_expired';
			const sandbox = await connectOrGone(agent_id, idle_ms);
			const redact = await redactionFor(info);
			const resume = parseStreamEventId(options.last_event_id);
			const first_line = resume?.line ?? 1;
			const dir = `${RUNS_DIR}/${run_id}`;
			const mapper = new ClaudeStreamMapper(redact);
			let line_number = first_line - 1;
			let buffer = '';
			let saw_result = false;
			let queue = Promise.resolve();

			const emit = (line: string) => {
				line_number += 1;
				for (const event of mapper.map(line, line_number)) {
					if (resume !== undefined && line_number === resume.line) {
						const index = Number(event.id.split('.')[1]);
						if (index <= resume.index) continue;
					}
					if (event.type === 'result') saw_result = true;
					queue = queue.then(() => on_event(event));
				}
			};

			// Wait for the run to start, then follow the log until the run's process exits.
			const command =
				`d='${dir}'; for i in $(seq 1 60); do [ -f "$d/pid" ] && break; sleep 1; done; ` +
				`[ -f "$d/pid" ] || exit 0; touch "$d/events.jsonl"; ` +
				`tail -n +${first_line} --pid="$(cat "$d/pid")" -F "$d/events.jsonl" 2>/dev/null`;
			try {
				await sandbox.follow(
					command,
					(chunk) => {
						buffer += chunk;
						let newline = buffer.indexOf('\n');
						while (newline >= 0) {
							emit(buffer.slice(0, newline));
							buffer = buffer.slice(newline + 1);
							newline = buffer.indexOf('\n');
						}
					},
					options.signal
				);
			} catch {
				await queue;
				return 'disconnected';
			}
			if (buffer.trim() !== '') emit(buffer);
			await queue;
			if (options.signal?.aborted === true) return 'disconnected';

			const update = runUpdateFromFiles(await readRun(sandbox, run_id), redact);
			if (update.status === 'running') return 'disconnected';
			if (!saw_result || update.status === 'cancelled') {
				await on_event({
					type: 'result',
					id: `${line_number + 1}.0`,
					status: update.status,
					...(update.result_summary === undefined ? {} : { text: update.result_summary }),
					...(update.duration_ms === undefined ? {} : { duration_ms: update.duration_ms })
				});
			}
			return 'terminal';
		}
	};
}
