/**
 * E2B dispatch provider ("Sand" in the UI): one hosted E2B sandbox per
 * mission, built from the template in `sandbox/e2b/` (ADR-0018,
 * docs/sand-e2b.md). Each sandbox is its own Firecracker microVM, so this
 * needs no KVM host of ours.
 *
 * The agent is interactive Claude Code in an hc terminal inside the sandbox,
 * driven by the session core (`src/lib/agent-session/`, ADR-0021). One CLI
 * session per sandbox: its id is in the sandbox metadata, and a follow-up is
 * the next message to the same running CLI.
 *
 * Mapping onto `AgentProvider`:
 *
 * - agent id = E2B sandbox id; run ids are `r1`, `r2`, … (one per prompt,
 *   each one turn of the CLI).
 * - launch creates the sandbox, writes the prompt and starts
 *   `beadsmith-run r1` in the background. That script joins the tailnet with
 *   a fresh ephemeral key, forwards 127.0.0.1:3306 to Dolt over it, checks
 *   out the repository (first run only), starts the hc core and writes
 *   `ready`.
 * - Once a run is ready, the first status read or stream to see it claims the
 *   start (an atomic `mkdir claim`, so two Beadsmith requests never send the
 *   prompt twice), attaches the session core (following the live terminal,
 *   or launching the CLI), sends the prompt and writes the turn's mark to
 *   `turn.json`. The CLI runs on in its terminal with nobody connected.
 * - Status and live events attach a session core to that mark; it says when
 *   the turn ended and how. The first to see the end writes `result.json`,
 *   which later status reads return without touching hc. A stream of a
 *   finished run replays the turn's transcript lines (from the mark to the
 *   line the result's event id names) and then that result. A finished run gets a short
 *   idle timeout, after which the sandbox pauses (not billed); a follow-up
 *   resumes it with the CLI still in its terminal.
 *
 * hc is reached only through `beadsmith-hc connect` on the E2B process
 * channel (`../e2b/hc-transport.ts`), never a port (ADR-0021 rule 1).
 *
 * A loop (ADR-0019) has a sandbox of its own, set up by the same
 * `beadsmith-run r1`. Once it is ready, the first reader to claim it starts
 * two hc terminals in the checkout: `ralph serve --no-web` (loopback only)
 * and `ralph <mode>` with the loop's flags, then writes `started`. Status,
 * iterations, events and stop go to ralph's `/v1` as curl commands over the
 * process channel (`../e2b/ralph-transport.ts`). Each read that finds more
 * iterations finished gives the sandbox the full run limit again, so a loop
 * may outlast the limit as long as each iteration fits in it. When the loop ends, its
 * result is written to `result.json` and the sandbox gets a short timeout
 * after which E2B destroys it: a loop takes no follow-up, so nothing would
 * resume it. A restart in that window is run `r2` (and so on) in the same
 * sandbox, with a terminal and a ralph name of its own; after it, the next
 * run starts in a fresh sandbox.
 *
 * Keys stay outside the sandbox (ADR-0015, rule 6): the Anthropic key and the
 * GitHub token are added to outbound requests by E2B's egress proxy; inside,
 * the agent sees placeholders. The project's scoped Dolt account and a
 * single-use Tailscale key are the only credentials it holds.
 */
import { randomUUID } from 'node:crypto';
import { HcError, type HcClient, type HcTerminal } from '#lib/hc/client.js';
import type { MissionEvent, MissionResultEvent, MissionResultStatus } from '#lib/mission-events.js';
import { claudeCode, EFFORT_PATTERN, MODEL_PATTERN } from '#lib/agent-session/claude-code.js';
import {
	AgentSession,
	parseSessionEventId,
	SESSION_LABEL,
	SessionError,
	SYNTHETIC_INDEX,
	type SessionTiming,
	type TurnMark
} from '#lib/agent-session/session.js';
import type { E2bSettings } from '../env.js';
import { RALPH_STOP_REASONS, type RalphStopReason } from '#lib/ralph.js';
import {
	AGENT_BUSY_MESSAGE,
	LOOP_ALREADY_RESTARTED_MESSAGE,
	LOOP_NOT_RUNNING_MESSAGE,
	NOT_A_LOOP_SANDBOX_MESSAGE,
	RUN_NOT_CANCELLABLE_MESSAGE,
	type AgentFollowUpRun,
	type AgentLaunch,
	type AgentLaunchInput,
	type AgentLoopLaunchInput,
	type AgentLoopRestart,
	type AgentProvider,
	type AgentRunUpdate,
	type AgentStreamOptions,
	type AgentStreamOutcome,
	type LoopEnd
} from './provider.js';
import { DISPATCH_SKILLS } from './agent-skills.js';
import {
	describeRalphStop,
	RalphClient,
	RalphError,
	RalphEventMapper,
	ralphOutcome,
	type RalphFetch,
	type RalphIteration
} from './ralph.js';
import { sandboxRalphFetch, RALPH_SERVE_PORT } from '../e2b/ralph-transport.js';
import { CLAUDE_CONFIG_DIR, RUNS_DIR, SKILLS_DIR, WORK_DIR } from '../e2b/image.js';
import { connectSandboxHc } from '../e2b/hc-transport.js';
import {
	attachSandboxTerminal,
	type TerminalAttachRequest,
	type TerminalRelay
} from '../terminal-relay/relay.js';
import {
	mintGithubRepositoryToken,
	mintTailscaleAuthKey,
	parseGithubRepository,
	readDoltAccount,
	readSecretFile
} from './sandbox-credentials.js';
import { findPullRequestUrl, readGithubPullUrl, sanitizeResultSummary } from './sanitize.js';
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

const RUN_ID_PATTERN = /^r[1-9][0-9]{0,5}$/;
const SANDBOX_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEFAULT_DOLT_LOCAL_PORT = '3306';
/** Sandbox metadata key holding the CLI's session id. */
export const SESSION_METADATA = 'beadsmith_session';
/**
 * Sandbox metadata keys holding the model and effort the mission was launched
 * with, so every relaunch of its CLI (a `--resume` after the terminal went)
 * runs the same ones. Absent = the CLI's default.
 */
export const MODEL_METADATA = 'beadsmith_model';
export const EFFORT_METADATA = 'beadsmith_effort';
/** Sandbox metadata key holding a loop's ralph run name; only loop sandboxes have it. */
export const LOOP_METADATA = 'beadsmith_loop';
/** hc terminal names in a loop sandbox. */
export const LOOP_TERMINAL = 'ralph-loop';
export const SERVE_TERMINAL = 'ralph-serve';
const LOOP_NAME_PATTERN = /^bdx-(run|plan|build|reverse)-[0-9a-f]{8}$/;
const LOOP_TERMINAL_PATTERN = /^ralph-loop(-r[1-9][0-9]{0,5})?$/;

/**
 * A loop run's hc terminal. A restart is a new terminal in the same sandbox
 * (ADR-0019 rule 2), and hc keeps a finished terminal's record, so each run
 * after the first gets a name of its own rather than sharing a name with
 * the run it follows.
 */
export function loopTerminalName(run_id: string): string {
	return run_id === 'r1' ? LOOP_TERMINAL : `${LOOP_TERMINAL}-${run_id}`;
}

/**
 * A loop run's ralph name, how `/v1` addresses it. The sandbox metadata
 * holds the first run's; a restarted run adds its run id, so ralph's record
 * of the earlier run stays apart.
 */
export function loopRunName(base: string, run_id: string): string {
	return run_id === 'r1' ? base : `${base}-${run_id}`;
}

/**
 * A start claimed this long ago with no turn written means the Beadsmith
 * process that claimed it died: the CLI's startup limit (2 min) plus room.
 */
const START_STALE_S = 300;
/**
 * A starter acts on the CLI only this long after its claim: a minute short
 * of START_STALE_S, after which the next run may start without waiting for it.
 */
const START_ACT_LIMIT_MS = (START_STALE_S - 60) * 1000;
/** How long a stream waits for setup and the start before handing back to polling. */
const STREAM_START_WAIT_MS = 15 * 60_000;
/** Characters of the setup log kept for the server log when setup fails. */
const FAILURE_TAIL_BYTES = 2_000;

export interface E2bProviderDeps {
	settings: E2bSettings;
	label: string;
	driver?: SandboxDriver;
	/** Secret file reader; tests replace it. */
	read_secret?: (path: string, what: string) => Promise<string>;
	mint_tailscale_key?: () => Promise<string>;
	mint_github_token?: (repository_url: string, write: boolean) => Promise<string>;
	read_dolt_account?: (database: string) => Promise<{ user: string; password: string }>;
	/** Open an hc client on a sandbox's core; tests use a fake core. */
	connect_hc?: (sandbox: SandboxRef) => Promise<HcClient>;
	/** Reach `ralph serve` in a loop sandbox; tests use a fake ralph. */
	ralph_fetch?: (sandbox: SandboxRef) => RalphFetch;
	/** Session core timing, and `wait_ms`: how often a stream rechecks a run that has not started. */
	timing?: SessionTiming & { wait_ms?: number };
	/**
	 * Server-side diagnostics: E2B errors and the end of a failed setup's log.
	 * The browser only ever gets the fixed messages below.
	 */
	log?: (message: string) => void;
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

/** A run's files in the sandbox, as `statusCommand` reports them. */
export interface RunFiles {
	exists: boolean;
	/** Setup's exit code: written only when setup failed. */
	exit_code?: number;
	cancelled: boolean;
	/** Setup finished and the hc core is up. */
	ready: boolean;
	/** Seconds since a Beadsmith process claimed the start. */
	claim_age_s?: number;
	/**
	 * Seconds since the previous run's start was claimed, while that starter
	 * has not finished (no `start-done`, no result).
	 */
	previous_start_age_s?: number;
	turn?: TurnMark;
	/** A loop's ralph terminals are running (loops write this instead of a turn). */
	started?: boolean;
	result?: StoredResult;
}

/** `result.json`: how the run ended, and the id of its result event. */
export interface StoredResult extends Omit<AgentRunUpdate, 'status'> {
	status: MissionResultStatus;
	event_id?: string;
}

function statusCommand(run_id: string): string {
	const dir = `${RUNS_DIR}/${run_id}`;
	const prev = `${RUNS_DIR}/r${runNumber(run_id) - 1}`;
	return [
		`d='${dir}'`,
		`if [ ! -d "$d" ]; then echo missing; exit 0; fi`,
		`p='${prev}'`,
		`printf 'exit=%s\\n' "$(cat "$d/exit" 2>/dev/null)"`,
		`printf 'cancelled=%s\\n' "$([ -f "$d/cancelled" ] && echo 1)"`,
		`printf 'ready=%s\\n' "$([ -f "$d/ready" ] && echo 1)"`,
		`printf 'claimed=%s\\n' "$(stat -c %Y "$d/claim" 2>/dev/null)"`,
		`printf 'started=%s\\n' "$([ -f "$d/started" ] && echo 1)"`,
		`printf 'prev_claimed=%s\\n' "$([ -f "$p/start-done" ] || [ -f "$p/result.json" ] || stat -c %Y "$p/claim" 2>/dev/null)"`,
		`printf 'now=%s\\n' "$(date +%s)"`,
		`printf 'turn=%s\\n' "$(head -c 4096 "$d/turn.json" 2>/dev/null)"`,
		`printf 'result=%s\\n' "$(head -c 16384 "$d/result.json" 2>/dev/null)"`
	].join('; ');
}

/**
 * Mark a run cancelled; while setup still runs, stop it too. Marking first
 * means status reads `cancelled` even if the kill races the exit. Exit 3:
 * nothing to cancel (no such run, or setup already failed).
 */
function cancelCommand(run_id: string): string {
	return (
		`d='${RUNS_DIR}/${run_id}'; [ -d "$d" ] && [ ! -f "$d/exit" ] || exit 3; touch "$d/cancelled"; ` +
		`[ -f "$d/ready" ] || kill -TERM -- "-$(cat "$d/pid")" 2>/dev/null || kill -TERM "$(cat "$d/pid")" 2>/dev/null; true`
	);
}

function readInt(value: string | undefined): number | undefined {
	if (value === undefined || !/^[0-9]{1,15}$/.test(value)) return undefined;
	return Number(value);
}

function parseJson(value: string | undefined): unknown {
	if (value === undefined || value === '') return undefined;
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTurn(value: unknown): TurnMark | undefined {
	if (!isRecord(value)) return undefined;
	const { base, first_line } = value;
	if (!Number.isSafeInteger(base) || (base as number) < 0) return undefined;
	if (!Number.isSafeInteger(first_line) || (first_line as number) < 1) return undefined;
	return { base: base as number, first_line: first_line as number };
}

const RUN_STATUSES = new Set<string>(['succeeded', 'cancelled', 'failed']);

function parseLoopEnd(value: unknown): LoopEnd | undefined {
	if (!isRecord(value) || typeof value.needs_person !== 'boolean') return undefined;
	const reason = value.stop_reason;
	return {
		stop_reason: (RALPH_STOP_REASONS as readonly unknown[]).includes(reason)
			? (reason as RalphStopReason)
			: null,
		needs_person: value.needs_person
	};
}

function parseResult(value: unknown): StoredResult | undefined {
	if (!isRecord(value) || typeof value.status !== 'string' || !RUN_STATUSES.has(value.status)) {
		return undefined;
	}
	const text = (key: string) =>
		typeof value[key] === 'string' ? (value[key] as string) : undefined;
	const duration = value.duration_ms;
	const result: StoredResult = { status: value.status as MissionResultStatus };
	if (text('result_summary') !== undefined) result.result_summary = text('result_summary');
	if (text('git_pr_url') !== undefined) result.git_pr_url = text('git_pr_url');
	if (text('error_message') !== undefined) result.error_message = text('error_message');
	if (text('event_id') !== undefined) result.event_id = text('event_id');
	const loop_end = parseLoopEnd(value.loop_end);
	if (loop_end !== undefined) result.loop_end = loop_end;
	if (Number.isSafeInteger(duration) && (duration as number) >= 0) {
		result.duration_ms = duration as number;
	}
	return result;
}

/** Parse `statusCommand` output. */
export function parseRunFiles(stdout: string): RunFiles {
	if (stdout.trim() === 'missing') return { exists: false, cancelled: false, ready: false };
	const fields = new Map<string, string>();
	for (const line of stdout.split('\n')) {
		const eq = line.indexOf('=');
		if (eq > 0 && !fields.has(line.slice(0, eq))) {
			fields.set(line.slice(0, eq), line.slice(eq + 1).trim());
		}
	}
	const claimed = readInt(fields.get('claimed'));
	const now = readInt(fields.get('now'));
	const files: RunFiles = {
		exists: true,
		exit_code: readInt(fields.get('exit')),
		cancelled: fields.get('cancelled') === '1',
		ready: fields.get('ready') === '1'
	};
	if (claimed !== undefined && now !== undefined) files.claim_age_s = Math.max(0, now - claimed);
	const prev_claimed = readInt(fields.get('prev_claimed'));
	if (prev_claimed !== undefined && now !== undefined) {
		files.previous_start_age_s = Math.max(0, now - prev_claimed);
	}
	if (fields.get('started') === '1') files.started = true;
	const turn = parseTurn(parseJson(fields.get('turn')));
	if (turn !== undefined) files.turn = turn;
	const result = parseResult(parseJson(fields.get('result')));
	if (result !== undefined) files.result = result;
	return files;
}

/**
 * Setup failures `sandbox/e2b/beadsmith-run` reports by exit code, before
 * the agent starts. Details are in the run's setup.log in the sandbox.
 */
const SETUP_FAILURES: Record<number, string> = {
	10: 'The sandbox could not join the tailnet.',
	11: 'The sandbox could not clone the repository.',
	12: 'The sandbox could not open its working directory.',
	13: 'The sandbox joined the tailnet but Dolt did not answer.',
	14: 'The sandbox could not start its terminal server (hc).'
};

/** How a run ended, from its files alone; undefined while it is still going. */
export function settledUpdate(files: RunFiles): StoredResult | undefined {
	if (!files.exists) {
		return { status: 'failed', error_message: 'The sandbox has no record of this run.' };
	}
	if (files.cancelled) return { status: 'cancelled' };
	if (files.result !== undefined) return files.result;
	if (files.exit_code !== undefined) {
		return {
			status: 'failed',
			error_message:
				SETUP_FAILURES[files.exit_code] ??
				`The sandbox setup exited with code ${files.exit_code} before the agent started.`
		};
	}
	if (files.turn === undefined && !files.started && (files.claim_age_s ?? 0) > START_STALE_S) {
		return { status: 'failed', error_message: 'The agent did not start.' };
	}
	return undefined;
}

/**
 * The loop's command line (ADR-0019 rule 2): `ralph <mode>` in the
 * foreground with the mission's flags. `--name` is how Beadsmith addresses
 * the run in `/v1`. `--no-observer`: ralph's observer spends model calls on
 * summaries Beadsmith drops (ralph.ts keeps none of its events), so a Sand
 * loop does not start it. A `run` loop's prompt goes last, after `--`, so
 * it is never read as a flag.
 */
export function ralphArgv(name: string, loop: AgentLoopLaunchInput['loop']): string[] {
	const argv = ['ralph', loop.mode, '--name', name, '--no-observer'];
	if (loop.max_iterations !== undefined) argv.push('--max', String(loop.max_iterations));
	if (loop.harness !== undefined) argv.push('--harness', loop.harness);
	if (loop.model !== undefined) argv.push('--model', loop.model);
	if (loop.effort !== undefined) argv.push('--effort', loop.effort);
	if (loop.iteration_timeout_minutes !== undefined) {
		argv.push('--timeout', String(loop.iteration_timeout_minutes));
	}
	if (loop.issue_id !== undefined) argv.push('--bead', loop.issue_id);
	if (loop.mode === 'run' && loop.prompt !== undefined) argv.push('--', loop.prompt);
	return argv;
}

function parseArgv(text: string): string[] | undefined {
	const value = parseJson(text);
	return Array.isArray(value) && value.length > 0 && value.every((a) => typeof a === 'string')
		? (value as string[])
		: undefined;
}

/** Why a loop's terminal ended before ralph recorded the run. */
function loopExitMessage(exit_code: number | null | undefined): string {
	if (exit_code === 127) {
		return 'This sandbox has no ralph. Rebuild the Sand template (docs/sand-e2b.md).';
	}
	return `ralph exited${exit_code === null || exit_code === undefined ? '' : ` with code ${exit_code}`} before it recorded the loop.`;
}

/** The session core's result for a turn → what Beadsmith stores. */
export function resultUpdate(
	event: MissionResultEvent,
	error_message: string | undefined,
	redact: string
): StoredResult {
	const pr = readGithubPullUrl(findPullRequestUrl(event.text), redact);
	const update: StoredResult = { status: event.status, event_id: event.id };
	if (event.text !== undefined) update.result_summary = event.text;
	if (event.duration_ms !== undefined) update.duration_ms = event.duration_ms;
	if (pr !== undefined) update.git_pr_url = pr;
	if (event.status === 'failed') {
		update.error_message = error_message ?? event.text ?? 'The agent run failed.';
	}
	return update;
}

/** Drop the stored-only field. */
function publicUpdate(result: StoredResult): AgentRunUpdate {
	const { event_id: _, ...update } = result;
	return update;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal?.removeEventListener('abort', done);
			resolve();
		}
		signal?.addEventListener('abort', done, { once: true });
	});
}

export function createE2bProvider(deps: E2bProviderDeps): AgentProvider {
	const { settings } = deps;
	const read_secret = deps.read_secret ?? readSecretFile;
	const driver =
		deps.driver ?? createSdkDriver(() => read_secret(settings.api_key_file, 'E2B API key'));
	const connectHc = deps.connect_hc ?? connectSandboxHc;
	const ralphFetch = deps.ralph_fetch ?? sandboxRalphFetch;
	const max_run_ms = settings.max_run_minutes * 60_000;
	const idle_ms = settings.idle_minutes * 60_000;
	const wait_ms = deps.timing?.wait_ms ?? 2_000;
	/** Terminal results already read, so a paused sandbox is not resumed to re-read them. */
	const finished = new Map<string, AgentRunUpdate>();
	/** Per running loop run: how many iterations had finished when its sandbox last got more time. */
	const extended = new Map<string, number>();
	const sink = deps.log ?? ((message: string) => console.warn(message));
	// E2B errors can echo request headers; strip credential shapes first.
	const log = (message: string) => sink(sanitizeResultSummary(message, '') ?? message);

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

	/** The sandbox's CLI session id; sandboxes from before hc have none. */
	function sessionIdOf(info: SandboxInfo): string | undefined {
		const id = info.metadata[SESSION_METADATA];
		return id !== undefined && SESSION_ID_PATTERN.test(id) ? id : undefined;
	}

	/** The model and effort a mission's sandbox was launched with, when well-formed. */
	function choiceOf(info: SandboxInfo): { model?: string; effort?: string } {
		const model = info.metadata[MODEL_METADATA];
		const effort = info.metadata[EFFORT_METADATA];
		return {
			...(model !== undefined && MODEL_PATTERN.test(model) ? { model } : {}),
			...(effort !== undefined && EFFORT_PATTERN.test(effort) ? { effort } : {})
		};
	}

	/** A session on the mission's CLI; `info` must be a mission sandbox (it has a session id). */
	function newSession(
		info: SandboxInfo,
		redact: string,
		on_event: (event: MissionEvent) => void,
		options: { after?: string; on_state?: (state: string) => void } = {}
	): AgentSession {
		return new AgentSession({
			harness: claudeCode,
			launch: {
				session_id: sessionIdOf(info)!,
				cwd: WORK_DIR,
				config_dir: CLAUDE_CONFIG_DIR,
				...choiceOf(info)
			},
			redact,
			after: options.after,
			onEvent: on_event,
			onState: options.on_state,
			// The sandbox's own time limit is the run limit; the core's matches it.
			timing: { turn_ms: max_run_ms, ...deps.timing }
		});
	}

	/**
	 * Create a mission's sandbox: the project's Dolt account inside, keys at
	 * the egress, and metadata saying what it is for.
	 */
	async function createSandbox(input: {
		name: string;
		dolt_database: string;
		repository?: { url: string; starting_ref: string };
		write: boolean;
		metadata: Record<string, string>;
		on_timeout: 'pause' | 'kill';
	}): Promise<SandboxRef> {
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
			beadsmith_write: input.write ? '1' : '0',
			...input.metadata
		};
		const network = await networkFor(metadata);
		let sandbox: SandboxRef;
		try {
			sandbox = await driver.create({
				template: settings.template,
				timeout_ms: max_run_ms,
				metadata,
				network,
				on_timeout: input.on_timeout,
				envs: {
					BEADSMITH_AGENT_NAME: input.name,
					BEADSMITH_REPO_URL: input.repository?.url ?? '',
					BEADSMITH_REPO_REF: input.repository?.starting_ref ?? '',
					BEADSMITH_AUTO_CREATE_PR: input.write ? '1' : '0',
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
					// Only when the egress will replace it: a placeholder that reaches
					// GitHub unreplaced reads as "bad credentials", which misleads.
					...(network.headers['api.github.com'] === undefined
						? {}
						: { GH_TOKEN: GITHUB_PLACEHOLDER })
				}
			});
		} catch (error) {
			if (error instanceof DispatchError) throw error;
			log(`Sand mission: E2B could not create a sandbox: ${String(error)}`);
			throw new DispatchError('unavailable', `${deps.label} could not create a sandbox.`);
		}
		return sandbox;
	}

	async function startRun(sandbox: SandboxRef, run_id: string, prompt: string) {
		const dir = `${RUNS_DIR}/${run_id}`;
		const skills = Object.keys(DISPATCH_SKILLS).map((name) => `'${SKILLS_DIR}/${name}'`);
		await sandbox.exec(`mkdir -p '${dir}' ${skills.join(' ')}`);
		// The prompt names .agents/skills/<name>/SKILL.md; the checkout may not
		// have them (another repository, or none), so beadsmith-run installs these.
		for (const [name, text] of Object.entries(DISPATCH_SKILLS)) {
			await sandbox.writeFile(`${SKILLS_DIR}/${name}/SKILL.md`, text);
		}
		// Kept in the sandbox so whichever Beadsmith process starts the turn can send it.
		await sandbox.writeFile(`${dir}/prompt`, prompt);
		await sandbox.start(`beadsmith-run ${run_id}`, { BEADSMITH_TS_AUTHKEY: await mintTailscale() });
	}

	async function readRun(sandbox: SandboxRef, run_id: string): Promise<RunFiles> {
		const { stdout } = await sandbox.exec(statusCommand(run_id));
		return parseRunFiles(stdout);
	}

	async function isCancelled(sandbox: SandboxRef, run_id: string): Promise<boolean> {
		const { exit_code } = await sandbox.exec(`[ -f '${RUNS_DIR}/${run_id}/cancelled' ]`);
		return exit_code === 0;
	}

	async function writeResult(sandbox: SandboxRef, run_id: string, result: StoredResult) {
		await sandbox.writeFile(`${RUNS_DIR}/${run_id}/result.json`, JSON.stringify(result));
	}

	/**
	 * Start a ready run's turn, unless another request already claimed it:
	 * attach the session core (it follows the live CLI or launches one),
	 * send the prompt, record the turn's mark. A start that fails records a
	 * failed result instead.
	 *
	 * A cancel can land while this runs (the launch alone may take the CLI's
	 * whole startup limit) and find no terminal to end yet; the cancelled mark
	 * is all it leaves. So the mark is read before attaching, again once the
	 * CLI is attached, before the prompt goes, and once more after: whichever
	 * check sees it ends the CLI, and the run reads cancelled from the mark.
	 *
	 * Every run of a mission shares one CLI session, so a cancelled run's
	 * starter that resumed after a follow-up started would attach to the
	 * follow-up's CLI and end it. Two guards keep them apart: the next run's
	 * turn waits until this starter writes `start-done` (see `advance`), and
	 * a starter stalled past START_ACT_LIMIT_MS, when the next run stops
	 * waiting for it, leaves the CLI alone.
	 */
	async function startTurn(
		sandbox: SandboxRef,
		info: SandboxInfo,
		run_id: string,
		redact: string
	): Promise<void> {
		const dir = `${RUNS_DIR}/${run_id}`;
		const claim = await sandbox.exec(`mkdir '${dir}/claim' 2>/dev/null`);
		if (claim.exit_code !== 0) return;
		const claimed_at = Date.now();
		/** Still this run's to act on; false once the next run may have started. */
		const mine = () => Date.now() - claimed_at < START_ACT_LIMIT_MS;
		let client: HcClient | undefined;
		let session: AgentSession | undefined;
		try {
			const { stdout: prompt } = await sandbox.exec(`cat '${dir}/prompt'`);
			if ((await isCancelled(sandbox, run_id)) || !mine()) return;
			client = await connectHc(sandbox);
			session = newSession(info, redact, () => {});
			await session.attach(client);
			if (!mine()) return;
			if (await isCancelled(sandbox, run_id)) {
				if (mine()) await session.cancel();
				return;
			}
			const mark = await session.send(prompt);
			await sandbox.writeFile(`${dir}/turn.json`, JSON.stringify(mark));
			if ((await isCancelled(sandbox, run_id)) && mine()) await session.cancel();
		} catch (error) {
			log(`Sand mission ${sandbox.id}/${run_id}: the agent could not start: ${String(error)}`);
			const message =
				error instanceof SessionError && error.code === 'startup'
					? error.message
					: error instanceof SessionError && error.code === 'blocked'
						? 'The agent is waiting for a decision in its terminal.'
						: `${deps.label} could not start the agent.`;
			await writeResult(sandbox, run_id, { status: 'failed', error_message: message }).catch(
				() => undefined
			);
		} finally {
			session?.close();
			client?.close();
			// The next run's turn waits for this (see `advance`).
			await sandbox.writeFile(`${dir}/start-done`, '').catch(() => undefined);
		}
	}

	/**
	 * Attach the session core to a run's turn and report how it ended, or
	 * undefined while it runs. The end is written to `result.json`.
	 */
	async function observeTurn(
		sandbox: SandboxRef,
		info: SandboxInfo,
		run_id: string,
		turn: TurnMark,
		redact: string
	): Promise<StoredResult | undefined> {
		let result: MissionResultEvent | undefined;
		let error_message: string | undefined;
		const client = await connectHc(sandbox);
		const session = newSession(info, redact, (event) => {
			if (event.type === 'result') result ??= event;
			else if (event.type === 'error') error_message ??= event.message;
		});
		try {
			await session.attach(client, { turn, relaunch: false });
			await session.settled();
		} finally {
			session.close();
			client.close();
		}
		if (result === undefined) return undefined;
		const update = resultUpdate(result, error_message, redact);
		await writeResult(sandbox, run_id, update);
		return update;
	}

	/** Log the end of a failed setup's log, redacted. Read once: the result is cached after. */
	async function logSetupFailure(
		sandbox: SandboxRef,
		run_id: string,
		code: number,
		redact: string
	) {
		try {
			const { stdout } = await sandbox.exec(
				`tail -c ${FAILURE_TAIL_BYTES} '${RUNS_DIR}/${run_id}/setup.log' 2>/dev/null`
			);
			const tail = sanitizeResultSummary(stdout, redact) ?? '(no output)';
			log(`Sand mission ${sandbox.id}/${run_id} setup exited ${code}: ${tail}`);
		} catch (error) {
			log(
				`Sand mission ${sandbox.id}/${run_id} setup exited ${code}; log unreadable: ${String(error)}`
			);
		}
	}

	/** Stop a run: mark it cancelled, then end the CLI if its turn may have started. */
	async function stopRun(
		sandbox: SandboxRef,
		info: SandboxInfo,
		run_id: string,
		files: RunFiles
	): Promise<boolean> {
		const { exit_code } = await sandbox.exec(cancelCommand(run_id));
		if (exit_code === 3) return false;
		if (
			sessionIdOf(info) !== undefined &&
			(files.turn !== undefined || files.claim_age_s !== undefined)
		) {
			const client = await connectHc(sandbox);
			const session = newSession(info, '', () => {});
			try {
				await session.attach(client, { turn: files.turn, relaunch: false });
				await session.cancel();
			} finally {
				session.close();
				client.close();
			}
		}
		return true;
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

	/**
	 * Advance a run as far as its files allow: how it ended, or the turn to
	 * follow, or neither yet (setup running, or the start in flight).
	 */
	async function advance(
		sandbox: SandboxRef,
		info: SandboxInfo,
		run_id: string,
		redact: string
	): Promise<{ done?: StoredResult; turn?: TurnMark; files?: RunFiles }> {
		let files = await readRun(sandbox, run_id);
		if (sessionIdOf(info) === undefined && settledUpdate(files) === undefined) {
			return {
				done: {
					status: 'failed',
					error_message: "This agent's sandbox predates the terminal runtime. Start a new thread."
				}
			};
		}
		// The previous run's starter, if still going, could act on the one CLI
		// session this turn is about to use (see `startTurn`): wait for it.
		const previous_starting = (files.previous_start_age_s ?? Infinity) <= START_STALE_S;
		if (files.ready && files.turn === undefined && files.claim_age_s === undefined) {
			if (!files.cancelled && files.result === undefined && !previous_starting) {
				await startTurn(sandbox, info, run_id, redact);
				files = await readRun(sandbox, run_id);
			}
		}
		const done = settledUpdate(files);
		if (done !== undefined) {
			if (done.status === 'failed' && files.exit_code !== undefined && files.result === undefined) {
				await logSetupFailure(sandbox, run_id, files.exit_code, redact);
			}
			return { done, files };
		}
		return { turn: files.turn };
	}

	/**
	 * The last transcript line of a finished run's turn. The result's event
	 * id names it (the session core gives its own events the last line it
	 * read). A run cancelled before a result was stored has none: then the
	 * next run's turn starts after it, and with no next turn the
	 * transcript's current end is still this run's.
	 */
	async function turnEndLine(
		sandbox: SandboxRef,
		run_id: string,
		files: RunFiles
	): Promise<number | undefined> {
		const stored = parseSessionEventId(files.result?.event_id);
		if (stored !== undefined) return stored.line;
		const next = await readRun(sandbox, `r${runNumber(run_id) + 1}`);
		return next.turn === undefined ? undefined : next.turn.first_line - 1;
	}

	/**
	 * Emit a finished run's transcript events (those after `after`) by
	 * reading the transcript between its turn's first and last lines. Returns
	 * the last line read, or undefined when the run had no turn to replay.
	 * A transcript that cannot be read leaves the stream with its result only.
	 */
	async function replayTurn(
		sandbox: SandboxRef,
		info: SandboxInfo,
		run_id: string,
		files: RunFiles,
		redact: string,
		on_event: (event: MissionEvent) => Promise<void>,
		after: string | undefined
	): Promise<number | undefined> {
		if (files.turn === undefined || sessionIdOf(info) === undefined) return undefined;
		const end = await turnEndLine(sandbox, run_id, files);
		const events: MissionEvent[] = [];
		let client: HcClient | undefined;
		let last: number;
		try {
			client = await connectHc(sandbox);
			const session = newSession(info, redact, (event) => void events.push(event), { after });
			last = await session.replay(client, files.turn, end);
		} catch (error) {
			log(`Sand mission ${sandbox.id}/${run_id}: transcript replay failed: ${String(error)}`);
			return undefined;
		} finally {
			client?.close();
		}
		for (const event of events) await on_event(event);
		return last;
	}

	// ---------------------------------------------------------------- loops

	/** The loop's ralph run name; undefined for a one-shot mission's sandbox. */
	function loopNameOf(info: SandboxInfo): string | undefined {
		const name = info.metadata[LOOP_METADATA];
		return name !== undefined && LOOP_NAME_PATTERN.test(name) ? name : undefined;
	}

	/**
	 * Start `ralph serve` unless its terminal is live. hc refuses a second
	 * live terminal of the same name, which is how two starts settle.
	 */
	async function ensureServe(client: HcClient): Promise<void> {
		try {
			await client.run({
				argv: ['ralph', 'serve', '--no-web', '--port', String(RALPH_SERVE_PORT)],
				cwd: WORK_DIR,
				name: SERVE_TERMINAL,
				labels: { beadsmith: 'ralph-serve' }
			});
		} catch (error) {
			if (!(error instanceof HcError && error.kind === 'name_taken')) throw error;
		}
	}

	/**
	 * Start a ready loop, unless another request already claimed it: ralph
	 * serve, then the loop itself, both as hc terminals in the checkout. They
	 * take the core's environment, which `beadsmith-run` gave the project's
	 * Dolt account and the egress placeholders.
	 */
	async function startLoop(sandbox: SandboxRef, run_id: string): Promise<void> {
		const dir = `${RUNS_DIR}/${run_id}`;
		const claim = await sandbox.exec(`mkdir '${dir}/claim' 2>/dev/null`);
		if (claim.exit_code !== 0) return;
		let client: HcClient | undefined;
		try {
			const { stdout } = await sandbox.exec(`cat '${dir}/loop.json'`);
			const argv = parseArgv(stdout);
			if (argv === undefined) throw new Error('loop.json is not a command line');
			client = await connectHc(sandbox);
			await ensureServe(client);
			await client.run({
				argv,
				cwd: WORK_DIR,
				name: loopTerminalName(run_id),
				labels: { beadsmith: 'loop' }
			});
			await sandbox.writeFile(`${dir}/started`, '');
		} catch (error) {
			log(`Sand loop ${sandbox.id}/${run_id}: ralph could not start: ${String(error)}`);
			await writeResult(sandbox, run_id, {
				status: 'failed',
				error_message: `${deps.label} could not start ralph.`
			}).catch(() => undefined);
		} finally {
			client?.close();
		}
	}

	/** A loop run's terminal record, or undefined when hc cannot say. */
	async function loopTerminal(
		sandbox: SandboxRef,
		run_id: string
	): Promise<HcTerminal | undefined> {
		let client: HcClient | undefined;
		try {
			client = await connectHc(sandbox);
			return await client.get(loopTerminalName(run_id));
		} catch {
			return undefined;
		} finally {
			client?.close();
		}
	}

	/** Restart `ralph serve` after its terminal ended; a failure waits for the next read. */
	async function reviveServe(sandbox: SandboxRef): Promise<void> {
		let client: HcClient | undefined;
		try {
			client = await connectHc(sandbox);
			await ensureServe(client);
		} catch (error) {
			log(`Sand loop ${sandbox.id}: ralph serve could not restart: ${String(error)}`);
		} finally {
			client?.close();
		}
	}

	type LoopStep =
		| { done: StoredResult; iterations?: RalphIteration[] }
		| { running: true; iterations?: RalphIteration[] };

	/** Advance a loop through setup and its start; `started` once ralph runs. */
	async function advanceLoop(
		sandbox: SandboxRef,
		run_id: string,
		redact: string
	): Promise<{ done?: StoredResult; started: boolean }> {
		let files = await readRun(sandbox, run_id);
		if (files.ready && !files.started && files.claim_age_s === undefined) {
			if (!files.cancelled && files.result === undefined) {
				await startLoop(sandbox, run_id);
				files = await readRun(sandbox, run_id);
			}
		}
		const done = settledUpdate(files);
		if (done !== undefined) {
			if (done.status === 'failed' && files.exit_code !== undefined && files.result === undefined) {
				await logSetupFailure(sandbox, run_id, files.exit_code, redact);
			}
			return { done, started: files.started === true };
		}
		return { started: files.started === true };
	}

	/**
	 * Ask ralph how a started loop is going. While it runs: its finished
	 * iterations. Once it has ended: the mission's result, written to
	 * `result.json` so later reads need not ask ralph again.
	 */
	async function observeLoop(
		sandbox: SandboxRef,
		run_id: string,
		name: string,
		redact: string,
		event_id?: string
	): Promise<LoopStep> {
		const ralph = new RalphClient(ralphFetch(sandbox), redact);
		let detail;
		try {
			detail = await ralph.getRun(name);
		} catch (error) {
			if (!(error instanceof RalphError)) throw error;
			const terminal = await loopTerminal(sandbox, run_id);
			if (error.status === 404 && terminal?.state === 'finished') {
				// ralph ended without recording the loop (not installed, bad flags).
				const done: StoredResult = {
					status: 'failed',
					error_message: loopExitMessage(terminal.exit_code)
				};
				await writeResult(sandbox, run_id, done);
				return { done };
			}
			// Not recorded yet, or serve is not answering.
			if (error.status === 0) await reviveServe(sandbox);
			return { running: true };
		}
		const { run, iterations } = detail;
		if (run.status === 'running' && run.alive) return { running: true, iterations };
		const terminal = await loopTerminal(sandbox, run_id);
		const report = await ralph.getReport(name).catch(() => undefined);
		const outcome = ralphOutcome({ stop_reason: run.stop_reason, exit_code: terminal?.exit_code });
		const summary = [
			describeRalphStop(run.stop_reason, report?.iterations ?? iterations.length),
			...(report?.needs_person ?? []).map((line) => `- ${line}`)
		].join('\n');
		const done: StoredResult = {
			status: outcome.status,
			result_summary: summary,
			loop_end: {
				stop_reason: run.stop_reason,
				needs_person: outcome.needs_person || (report?.needs_person.length ?? 0) > 0
			}
		};
		if (report !== undefined) done.duration_ms = report.duration_ms;
		if (outcome.status === 'failed') done.error_message = summary;
		if (event_id !== undefined) done.event_id = event_id;
		await writeResult(sandbox, run_id, done);
		return { done, iterations };
	}

	/** A loop has ended: E2B destroys its sandbox after the idle window. */
	async function retireLoop(sandbox: SandboxRef): Promise<void> {
		for (const key of extended.keys()) {
			if (key.startsWith(`${sandbox.id}/`)) extended.delete(key);
		}
		await sandbox.setTimeout(idle_ms).catch(() => undefined);
	}

	/**
	 * A loop may run for longer than the run limit, as long as it keeps
	 * finishing iterations: each time a reader sees ralph alive with more
	 * finished iterations than at the last extension, the sandbox gets the
	 * full run limit again from now. One iteration still has to fit in the
	 * run limit, so a loop stuck in an iteration (or a dead ralph) is cut off
	 * there rather than kept alive and billed. ralph's own iteration limit
	 * and iteration timeout bound an honest loop; E2B's longest sandbox
	 * session bounds the rest. The first sight of a run after Beadsmith
	 * starts counts as progress, so a restart costs at most one extension.
	 *
	 * Extension, not pause and resume: a paused sandbox loses its tailnet
	 * node and the agent's open model connection mid-iteration, and nothing
	 * would resume it unasked. The dispatch follower keeps reading a loop
	 * until it ends (`dispatch/service.ts`), so the extension happens even
	 * with no browser open.
	 */
	async function extendLoop(sandbox: SandboxRef, run_id: string, finished_count: number) {
		const key = `${sandbox.id}/${run_id}`;
		const last = extended.get(key);
		if (last !== undefined && finished_count <= last) return;
		try {
			await sandbox.setTimeout(max_run_ms);
			extended.set(key, finished_count);
		} catch (error) {
			log(`Sand loop ${sandbox.id}: could not extend the run limit: ${String(error)}`);
		}
	}

	/** Stop a loop now: ralph records the operator stop, then its terminal goes. */
	async function stopLoop(
		sandbox: SandboxRef,
		run_id: string,
		name: string,
		files: RunFiles
	): Promise<boolean> {
		const { exit_code } = await sandbox.exec(cancelCommand(run_id));
		if (exit_code === 3) return false;
		if (files.started === true || files.claim_age_s !== undefined) {
			await new RalphClient(ralphFetch(sandbox), '')
				.stop(name, { graceful: false })
				.catch(() => undefined);
			let client: HcClient | undefined;
			try {
				client = await connectHc(sandbox);
				await client.kill(loopTerminalName(run_id));
			} catch {
				// Already finished, or never started: the cancelled mark decides.
			} finally {
				client?.close();
			}
		}
		await retireLoop(sandbox);
		return true;
	}

	/**
	 * A started, unsettled loop's sandbox and ralph client, for steer and
	 * graceful stop. Anything else (gone, not a loop, still in setup, ended)
	 * is a conflict: the control has nothing to act on.
	 */
	async function runningLoop(
		agent_id: string,
		run_id: string
	): Promise<{ ralph: RalphClient; name: string }> {
		requireRunId(run_id);
		const info = await driver.info(requireSandboxId(agent_id));
		const base = info === undefined ? undefined : loopNameOf(info);
		if (info === undefined || base === undefined || info.state === 'paused') {
			throw new DispatchError('conflict', LOOP_NOT_RUNNING_MESSAGE);
		}
		const sandbox = await connectOrGone(agent_id, idle_ms);
		const files = await readRun(sandbox, run_id);
		if (files.started !== true || settledUpdate(files) !== undefined) {
			throw new DispatchError('conflict', LOOP_NOT_RUNNING_MESSAGE);
		}
		return { ralph: new RalphClient(ralphFetch(sandbox), ''), name: loopRunName(base, run_id) };
	}

	/** ralph refused a control: 404/409 mean the run is not running; anything else, unreachable. */
	function loopControlError(error: unknown, what: string): DispatchError {
		if (error instanceof DispatchError) return error;
		if (error instanceof RalphError && (error.status === 404 || error.status === 409)) {
			return new DispatchError('conflict', LOOP_NOT_RUNNING_MESSAGE);
		}
		log(`Sand loop ${what} failed: ${String(error)}`);
		return new DispatchError('unavailable', `${deps.label} could not reach the loop.`);
	}

	/** Write a loop run's command line and start its setup; the first reader then starts ralph. */
	async function startLoopRun(
		sandbox: SandboxRef,
		run_id: string,
		base: string,
		loop: AgentLoopLaunchInput['loop']
	): Promise<void> {
		const dir = `${RUNS_DIR}/${run_id}`;
		await sandbox.exec(`mkdir -p '${dir}'`);
		await sandbox.writeFile(
			`${dir}/loop.json`,
			JSON.stringify(ralphArgv(loopRunName(base, run_id), loop))
		);
		await sandbox.start(`beadsmith-run ${run_id}`, { BEADSMITH_TS_AUTHKEY: await mintTailscale() });
	}

	/** A loop in a sandbox of its own, starting at `run_id` (r1, or the next run of a restart). */
	async function launchLoopSandbox(
		input: AgentLoopLaunchInput,
		run_id: string
	): Promise<AgentLoopRestart> {
		const base = `bdx-${input.loop.mode}-${randomUUID().slice(0, 8)}`;
		// Every loop mode writes Beads or code, so its checkout can push.
		const sandbox = await createSandbox({
			name: input.name,
			dolt_database: input.dolt_database,
			repository: input.repository,
			write: true,
			metadata: { [LOOP_METADATA]: base },
			// Nothing resumes a loop's sandbox, so its timeout destroys it.
			on_timeout: 'kill'
		});
		try {
			await startLoopRun(sandbox, run_id, base, input.loop);
		} catch (error) {
			await sandbox.kill().catch(() => undefined);
			if (error instanceof DispatchError) throw error;
			log(`Sand loop ${sandbox.id}: setup could not start: ${String(error)}`);
			throw new DispatchError('unavailable', `${deps.label} could not start the loop.`);
		}
		return { agent_id: sandbox.id, run_id };
	}

	/**
	 * Start run `run_id` in a loop's live sandbox. The checkout is already
	 * there, so `beadsmith-run` only rejoins the tailnet and readies hc. The
	 * sandbox gets a fresh GitHub token (they last an hour) and the full run
	 * limit back. A previous run the sandbox still counts as working was
	 * already reported ended (the service restarts only an ended mission), so
	 * it is stopped first rather than left running beside the new one.
	 */
	async function restartInSandbox(
		sandbox: SandboxRef,
		info: SandboxInfo,
		base: string,
		run_id: string,
		loop: AgentLoopLaunchInput['loop']
	): Promise<void> {
		const latest = await latestRunId(sandbox);
		if (latest !== undefined && runNumber(latest) >= runNumber(run_id)) {
			throw new DispatchError('conflict', LOOP_ALREADY_RESTARTED_MESSAGE);
		}
		if (latest !== undefined) {
			const files = await readRun(sandbox, latest);
			if (settledUpdate(files) === undefined) {
				await stopLoop(sandbox, latest, loopRunName(base, latest), files);
			}
		}
		try {
			await sandbox.updateNetwork(await networkFor(info.metadata));
			await sandbox.setTimeout(max_run_ms);
			await startLoopRun(sandbox, run_id, base, loop);
		} catch (error) {
			await retireLoop(sandbox);
			if (error instanceof DispatchError) throw error;
			log(`Sand loop ${sandbox.id}: restart could not start: ${String(error)}`);
			throw new DispatchError('unavailable', `${deps.label} could not restart the loop.`);
		}
	}

	/** getRun for a loop sandbox. */
	async function getLoopRun(
		sandbox: SandboxRef,
		info: SandboxInfo,
		run_id: string,
		name: string
	): Promise<AgentRunUpdate> {
		const redact = await redactionFor(info);
		const step = await advanceLoop(sandbox, run_id, redact);
		if (step.done !== undefined) {
			await retireLoop(sandbox);
			return publicUpdate(step.done);
		}
		if (!step.started) return { status: 'running' };
		const observed = await observeLoop(sandbox, run_id, name, redact);
		const iterations =
			observed.iterations === undefined || observed.iterations.length === 0
				? {}
				: { iterations: observed.iterations };
		if ('running' in observed) {
			// Iterations come back only when ralph reports the run alive.
			if (observed.iterations !== undefined) {
				await extendLoop(sandbox, run_id, observed.iterations.length);
			}
			return { status: 'running', ...iterations };
		}
		await retireLoop(sandbox);
		return { ...publicUpdate(observed.done), ...iterations };
	}

	/** streamMissionEvents for a loop sandbox: ralph's events, mapped. */
	async function streamLoop(
		sandbox: SandboxRef,
		info: SandboxInfo,
		run_id: string,
		name: string,
		on_event: (event: MissionEvent) => Promise<void>,
		options: AgentStreamOptions
	): Promise<AgentStreamOutcome> {
		const redact = await redactionFor(info);
		const signal = options.signal;
		const last =
			options.last_event_id !== undefined && /^[0-9]{1,15}$/.test(options.last_event_id)
				? options.last_event_id
				: undefined;

		/** A loop that ended before this stream saw it end: its stored result, once. */
		const finish = async (done: StoredResult): Promise<AgentStreamOutcome> => {
			const seen = last === undefined ? 0 : Number(last);
			const stored =
				done.event_id !== undefined && /^[0-9]{1,15}$/.test(done.event_id)
					? Number(done.event_id)
					: undefined;
			if (stored !== undefined && seen >= stored) return 'terminal';
			await on_event({
				type: 'result',
				id: String(stored ?? seen + 1),
				status: done.status,
				...(done.result_summary === undefined ? {} : { text: done.result_summary }),
				...(done.duration_ms === undefined ? {} : { duration_ms: done.duration_ms })
			});
			return 'terminal';
		};

		const deadline = Date.now() + STREAM_START_WAIT_MS;
		for (;;) {
			if (signal?.aborted === true) return 'disconnected';
			const step = await advanceLoop(sandbox, run_id, redact);
			if (step.done !== undefined) return finish(step.done);
			if (step.started) break;
			if (Date.now() > deadline) return 'disconnected';
			await delay(wait_ms, signal);
		}

		const ralph = new RalphClient(ralphFetch(sandbox), redact);
		const mapper = new RalphEventMapper(redact);
		let result_id: string | undefined;
		let outcome: AgentStreamOutcome;
		try {
			outcome = await ralph.streamEvents(
				name,
				async (entry) => {
					const event = mapper.map(entry);
					if (event === undefined) return;
					if (event.type === 'result') result_id = event.id;
					await on_event(event);
				},
				{ last_event_id: last, signal }
			);
		} catch {
			return 'disconnected';
		}
		if (outcome !== 'terminal') return outcome;
		// ralph ended the stream: record the result (with the id the browser saw).
		const observed = await observeLoop(sandbox, run_id, name, redact, result_id).catch(
			() => undefined
		);
		if (observed === undefined || 'running' in observed) return 'disconnected';
		if (result_id === undefined) await finish(observed.done);
		await retireLoop(sandbox);
		return 'terminal';
	}

	return {
		id: 'e2b',
		label: deps.label,

		/**
		 * The admin relay: a loop's ralph terminal, or the mission's CLI (the
		 * terminal labelled with its session id). Never launches anything.
		 */
		attachTerminal(agent_id: string, request: TerminalAttachRequest): Promise<TerminalRelay> {
			return attachSandboxTerminal(
				{ driver, connect_hc: connectHc, idle_ms },
				requireSandboxId(agent_id),
				(live, info) => {
					if (loopNameOf(info) !== undefined) {
						// Only the current run's terminal is live; earlier runs' have finished.
						return live.findLast((terminal) => LOOP_TERMINAL_PATTERN.test(terminal.name ?? ''));
					}
					const session_id = sessionIdOf(info);
					if (session_id === undefined) return undefined;
					return live.find((terminal) => terminal.labels[SESSION_LABEL] === session_id);
				},
				request
			);
		},

		async launch(input: AgentLaunchInput): Promise<AgentLaunch> {
			const sandbox = await createSandbox({
				name: input.name,
				dolt_database: input.dolt_database,
				repository: input.repository,
				write: input.auto_create_pr,
				metadata: {
					[SESSION_METADATA]: randomUUID(),
					...(input.model === undefined ? {} : { [MODEL_METADATA]: input.model }),
					...(input.effort === undefined ? {} : { [EFFORT_METADATA]: input.effort })
				},
				on_timeout: 'pause'
			});
			try {
				await startRun(sandbox, 'r1', input.prompt);
			} catch (error) {
				// Do not leave a sandbox behind that will never report.
				await sandbox.kill().catch(() => undefined);
				if (error instanceof DispatchError) throw error;
				log(`Sand mission ${sandbox.id}: the agent could not start: ${String(error)}`);
				throw new DispatchError('unavailable', `${deps.label} could not start the agent.`);
			}
			return { agent_id: sandbox.id, run_id: 'r1' };
		},

		launchLoop(input: AgentLoopLaunchInput): Promise<AgentLaunch> {
			return launchLoopSandbox(input, 'r1');
		},

		/**
		 * A new run of an ended loop (ADR-0019 rules 2 and 5). In its own
		 * sandbox while E2B still has it (the idle window after the loop
		 * ended), keeping the checkout and anything not pushed; once E2B has
		 * destroyed it, in a fresh sandbox from the project's checkout, under
		 * the same mission with the run numbering carried on.
		 */
		async restartLoop(
			agent_id: string,
			after_run_id: string,
			input: AgentLoopLaunchInput
		): Promise<AgentLoopRestart> {
			const run_id = `r${runNumber(requireRunId(after_run_id)) + 1}`;
			const info = await driver.info(requireSandboxId(agent_id));
			if (info !== undefined) {
				const base = loopNameOf(info);
				if (base === undefined) throw new DispatchError('conflict', NOT_A_LOOP_SANDBOX_MESSAGE);
				let sandbox: SandboxRef | undefined;
				try {
					sandbox = await driver.connect(agent_id, max_run_ms);
				} catch {
					// Destroyed between the two calls: start fresh below.
				}
				if (sandbox !== undefined) {
					await restartInSandbox(sandbox, info, base, run_id, input.loop);
					return { agent_id, run_id };
				}
			}
			return launchLoopSandbox(input, run_id);
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
			const loop = loopNameOf(info);
			if (loop !== undefined) {
				const update = await getLoopRun(sandbox, info, run_id, loopRunName(loop, run_id));
				if (update.status !== 'running') finished.set(key, update);
				return update;
			}
			const redact = await redactionFor(info);
			const step = await advance(sandbox, info, run_id, redact);
			const done =
				step.done ??
				(step.turn === undefined
					? undefined
					: await observeTurn(sandbox, info, run_id, step.turn, redact));
			if (done === undefined) return { status: 'running' };
			const update = publicUpdate(done);
			finished.set(key, update);
			// Finished: wait briefly for a follow-up, then pause (lifecycle onTimeout).
			await sandbox.setTimeout(idle_ms).catch(() => undefined);
			return update;
		},

		async createRun(agent_id: string, prompt: string): Promise<AgentFollowUpRun> {
			const info = await driver.info(requireSandboxId(agent_id));
			if (info === undefined) {
				throw new DispatchError('conflict', "This agent's sandbox is gone. Start a new thread.");
			}
			if (loopNameOf(info) !== undefined) {
				// A one-shot agent in the loop's checkout would run outside ralph.
				throw new DispatchError('conflict', 'A loop takes no follow-up.');
			}
			if (sessionIdOf(info) === undefined) {
				throw new DispatchError(
					'conflict',
					"This agent's sandbox predates the terminal runtime. Start a new thread."
				);
			}
			const sandbox = await connectOrGone(agent_id, max_run_ms);
			const latest = await latestRunId(sandbox);
			if (latest !== undefined) {
				const files = await readRun(sandbox, latest);
				if (settledUpdate(files) === undefined) {
					// A run cut off by the time limit was already reported failed;
					// resuming would wake it, so stop it rather than call the agent busy.
					if (info.state !== 'paused') throw new DispatchError('conflict', AGENT_BUSY_MESSAGE);
					await stopRun(sandbox, info, latest, files);
				}
			}
			const run_id = `r${latest === undefined ? 1 : runNumber(latest) + 1}`;
			// Fresh GitHub token (they last an hour) and the full run limit again.
			await sandbox.updateNetwork(await networkFor(info.metadata));
			await sandbox.setTimeout(max_run_ms);
			await startRun(sandbox, run_id, prompt);
			return { run_id };
		},

		async cancelRun(agent_id: string, run_id: string): Promise<void> {
			requireRunId(run_id);
			const info = await driver.info(requireSandboxId(agent_id));
			if (info === undefined) throw new DispatchError('conflict', RUN_NOT_CANCELLABLE_MESSAGE);
			const sandbox = await connectOrGone(agent_id, idle_ms);
			const files = await readRun(sandbox, run_id);
			const loop = loopNameOf(info);
			if (loop !== undefined) {
				const name = loopRunName(loop, run_id);
				if (settledUpdate(files) !== undefined || !(await stopLoop(sandbox, run_id, name, files))) {
					throw new DispatchError('conflict', RUN_NOT_CANCELLABLE_MESSAGE);
				}
				return;
			}
			if (settledUpdate(files) !== undefined || !(await stopRun(sandbox, info, run_id, files))) {
				throw new DispatchError('conflict', RUN_NOT_CANCELLABLE_MESSAGE);
			}
			await sandbox.setTimeout(idle_ms).catch(() => undefined);
		},

		async steerRun(agent_id: string, run_id: string, text: string): Promise<void> {
			try {
				const { ralph, name } = await runningLoop(agent_id, run_id);
				await ralph.steer(name, text);
			} catch (error) {
				throw loopControlError(error, 'steer');
			}
		},

		async stopRunAfterIteration(agent_id: string, run_id: string): Promise<void> {
			let state: Awaited<ReturnType<RalphClient['stop']>>;
			try {
				const { ralph, name } = await runningLoop(agent_id, run_id);
				state = await ralph.stop(name, { graceful: true });
			} catch (error) {
				throw loopControlError(error, 'graceful stop');
			}
			// not_running / already_gone: it ended on its own; the next status read says how.
			if (state !== 'stopping') throw new DispatchError('conflict', LOOP_NOT_RUNNING_MESSAGE);
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
			const loop = loopNameOf(info);
			if (loop !== undefined) {
				return streamLoop(sandbox, info, run_id, loopRunName(loop, run_id), on_event, options);
			}
			const redact = await redactionFor(info);
			const signal = options.signal;
			const seen = parseSessionEventId(options.last_event_id);

			/**
			 * A run that ended before the stream got to follow it: its turn's
			 * transcript replayed, then its stored result.
			 */
			const finish = async (done: StoredResult, files?: RunFiles): Promise<AgentStreamOutcome> => {
				const replayed =
					files === undefined
						? undefined
						: await replayTurn(
								sandbox,
								info,
								run_id,
								files,
								redact,
								on_event,
								options.last_event_id
							);
				const stored = parseSessionEventId(done.event_id);
				// Without a stored id, the result sorts after the replayed lines and the client's last id.
				const line = Math.max(seen?.line ?? 0, replayed ?? 0);
				const index = seen?.line === line ? seen.index + 1 : 0;
				const id =
					done.event_id !== undefined && stored !== undefined
						? done.event_id
						: `${line}.${Math.max(SYNTHETIC_INDEX, index)}`;
				const already =
					stored !== undefined &&
					seen !== undefined &&
					(seen.line > stored.line || (seen.line === stored.line && seen.index >= stored.index));
				if (!already) {
					await on_event({
						type: 'result',
						id,
						status: done.status,
						...(done.result_summary === undefined ? {} : { text: done.result_summary }),
						...(done.duration_ms === undefined ? {} : { duration_ms: done.duration_ms })
					});
				}
				return 'terminal';
			};

			// Wait out setup and the start; each pass may claim the start itself.
			const deadline = Date.now() + STREAM_START_WAIT_MS;
			let turn: TurnMark | undefined;
			for (;;) {
				if (signal?.aborted === true) return 'disconnected';
				const step = await advance(sandbox, info, run_id, redact);
				if (step.done !== undefined) return finish(step.done, step.files);
				if (step.turn !== undefined) {
					turn = step.turn;
					break;
				}
				if (Date.now() > deadline) return 'disconnected';
				await delay(wait_ms, signal);
			}

			// Follow the turn until the session core reports its end.
			let queue = Promise.resolve();
			let result: MissionResultEvent | undefined;
			let error_message: string | undefined;
			let stop!: () => void;
			const stopped = new Promise<void>((resolve) => (stop = resolve));
			const client = await connectHc(sandbox);
			const session = newSession(
				info,
				redact,
				(event) => {
					if (event.type === 'error') error_message ??= event.message;
					queue = queue.then(() => on_event(event));
					if (event.type === 'result') {
						result ??= event;
						stop();
					}
				},
				{
					after: options.last_event_id,
					on_state: (state) => {
						if (state === 'disconnected' || state === 'ended') stop();
					}
				}
			);
			const abort = () => stop();
			signal?.addEventListener('abort', abort, { once: true });
			try {
				await session.attach(client, { turn, relaunch: false });
				await stopped;
				await session.settled();
			} catch {
				return 'disconnected';
			} finally {
				signal?.removeEventListener('abort', abort);
				session.close();
				client.close();
				await queue.catch(() => undefined);
			}
			if (result === undefined) return 'disconnected';
			await writeResult(sandbox, run_id, resultUpdate(result, error_message, redact)).catch(
				() => undefined
			);
			return 'terminal';
		}
	};
}
