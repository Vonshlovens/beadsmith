/**
 * E2B sandboxes as Beadsmith uses them ("Sand"; ADR-0017, docs/sand-e2b.md):
 * a small driver interface over the E2B SDK, shared by the dispatch provider
 * (`dispatch/e2b-provider.ts`) and the First Mate chat runner
 * (`mate/e2b-runner.ts`), and the egress plan that keeps keys outside the
 * sandbox.
 *
 * Each sandbox is its own Firecracker microVM on E2B's side, so none of this
 * needs a KVM host of ours. Model and GitHub credentials never enter a
 * sandbox: E2B's egress proxy adds them as headers to HTTPS requests for
 * named hosts (ADR-0015, rule 6). Inside, agents see placeholders.
 */
import { ALL_TRAFFIC, CommandExitError, NotFoundError, Sandbox } from 'e2b';

/** Placeholders the egress proxy overwrites; harmless if printed. */
export const ANTHROPIC_PLACEHOLDER = 'sk-ant-api03-placeholder-added-by-e2b-egress';
export const OAUTH_PLACEHOLDER = 'sk-ant-oat01-placeholder-added-by-e2b-egress';
export const GITHUB_PLACEHOLDER = 'placeholder-added-by-e2b-egress';

/**
 * How Claude Code reaches the model: an Anthropic API key (`x-api-key`) or a
 * Claude subscription token (`CLAUDE_CODE_OAUTH_TOKEN`, sent as a bearer
 * token). Either way the value lives only in Beadsmith's secret file and in
 * E2B's egress rules.
 */
export interface ModelCredential {
	kind: 'api_key' | 'oauth_token';
	value: string;
}

/** Settings shared by every E2B use: paths, never secret values. */
export interface E2bBaseSettings {
	/** `BDX_E2B_API_KEY_FILE`. */
	api_key_file: string;
	/** `BDX_E2B_TEMPLATE`: built from `sandbox/e2b/build-template.ts`. */
	template: string;
	/** `BDX_E2B_ANTHROPIC_API_KEY_FILE`, or */
	anthropic_api_key_file?: string;
	/** `BDX_E2B_CLAUDE_OAUTH_TOKEN_FILE` (used when no API key file is set). */
	claude_oauth_token_file?: string;
	/** `BDX_E2B_ALLOW_OUT`: optional egress allowlist; unset leaves HTTP(S) open. */
	allow_out?: string[];
}

/** Read the configured model credential. */
export async function readModelCredential(
	settings: E2bBaseSettings,
	read_secret: (path: string, what: string) => Promise<string>
): Promise<ModelCredential> {
	if (settings.anthropic_api_key_file !== undefined) {
		return {
			kind: 'api_key',
			value: await read_secret(settings.anthropic_api_key_file, 'Anthropic API key')
		};
	}
	return {
		kind: 'oauth_token',
		value: await read_secret(settings.claude_oauth_token_file ?? '', 'Claude OAuth token')
	};
}

/** The env Claude Code needs to try the model at all; values are placeholders. */
export function modelPlaceholderEnvs(kind: ModelCredential['kind']): Record<string, string> {
	return kind === 'api_key'
		? { ANTHROPIC_API_KEY: ANTHROPIC_PLACEHOLDER }
		: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH_PLACEHOLDER };
}

/** Egress for one sandbox: open HTTP(S) by default, keys added per host. */
export interface SandboxNetwork {
	allow_out: string[];
	deny_out: string[];
	/** Host → headers E2B's egress sets on every HTTPS request to it. */
	headers: Record<string, Record<string, string>>;
}

/** Build the egress plan. Rule hosts must also be in allowOut for rules to apply. */
export function buildSandboxNetwork(
	settings: Pick<E2bBaseSettings, 'allow_out'>,
	model: ModelCredential,
	github_token?: string
): SandboxNetwork {
	const headers: SandboxNetwork['headers'] = {
		'api.anthropic.com':
			model.kind === 'api_key'
				? { 'x-api-key': model.value }
				: { authorization: `Bearer ${model.value}` }
	};
	if (github_token !== undefined) {
		// git sends Basic auth to github.com; gh and the REST API use a bearer token.
		headers['github.com'] = {
			authorization: `Basic ${Buffer.from(`x-access-token:${github_token}`).toString('base64')}`
		};
		headers['api.github.com'] = { authorization: `Bearer ${github_token}` };
	}
	return {
		// '*' allows HTTP and TLS to any host by name, which is all Tailscale
		// needs (control plane and DERP relays run over 443); other ports and
		// raw IPs stay closed. An operator allowlist replaces '*'.
		allow_out: [...Object.keys(headers), ...(settings.allow_out ?? ['*'])],
		deny_out: [ALL_TRAFFIC],
		headers
	};
}

export interface SandboxCreateInput {
	template: string;
	timeout_ms: number;
	metadata: Record<string, string>;
	envs: Record<string, string>;
	network: SandboxNetwork;
}

/** A process with stdin open, for a long-lived agent. */
export interface InteractiveCommand {
	sendStdin(data: string): Promise<void>;
	closeStdin(): Promise<void>;
	kill(): Promise<void>;
	/** Resolves with the exit code (null when the connection was lost). */
	wait(): Promise<number | null>;
}

/** One running sandbox. */
export interface SandboxRef {
	readonly id: string;
	/** Run to completion; never throws on a non-zero exit. */
	exec(
		command: string,
		envs?: Record<string, string>
	): Promise<{ exit_code: number; stdout: string }>;
	/** Start in the background and return; the process outlives this call. */
	start(command: string, envs: Record<string, string>): Promise<void>;
	/** Run, passing stdout chunks along, until it exits or `signal` aborts. */
	follow(command: string, on_stdout: (chunk: string) => void, signal?: AbortSignal): Promise<void>;
	/** Start with stdin open; output goes to the callbacks. */
	interactive(
		command: string,
		options: {
			cwd?: string;
			envs?: Record<string, string>;
			on_stdout: (chunk: string) => void;
			on_stderr: (chunk: string) => void;
		}
	): Promise<InteractiveCommand>;
	writeFile(path: string, content: string): Promise<void>;
	setTimeout(timeout_ms: number): Promise<void>;
	updateNetwork(network: SandboxNetwork): Promise<void>;
	kill(): Promise<void>;
}

export interface SandboxInfo {
	id: string;
	state: 'running' | 'paused';
	metadata: Record<string, string>;
}

/** The E2B calls Beadsmith makes, behind an interface for tests. */
export interface SandboxDriver {
	create(input: SandboxCreateInput): Promise<SandboxRef>;
	/** Connect, resuming a paused sandbox. Throws when it is gone. */
	connect(id: string, timeout_ms: number): Promise<SandboxRef>;
	/** State and metadata without resuming; undefined when the sandbox is gone. */
	info(id: string): Promise<SandboxInfo | undefined>;
	/** Running or paused sandboxes whose metadata includes every pair given. */
	find(metadata: Record<string, string>): Promise<SandboxInfo[]>;
}

/** SDK shape of a network plan: each header set is one transform rule on its host. */
function toSdkNetwork(network: SandboxNetwork) {
	return {
		allowOut: network.allow_out,
		denyOut: network.deny_out,
		rules: Object.fromEntries(
			Object.entries(network.headers).map(([host, headers]) => [host, [{ transform: { headers } }]])
		)
	};
}

/** Error text from E2B is never surfaced: callers map failures to fixed messages. */
export class SandboxUnavailableError extends Error {
	constructor() {
		super('E2B could not be reached.');
		this.name = 'SandboxUnavailableError';
	}
}

/** The real driver over the E2B SDK. */
export function createSdkDriver(api_key: () => Promise<string>): SandboxDriver {
	function wrap(sandbox: Sandbox): SandboxRef {
		return {
			id: sandbox.sandboxId,
			async exec(command, envs) {
				try {
					const result = await sandbox.commands.run(command, { envs, timeoutMs: 60_000 });
					return { exit_code: result.exitCode, stdout: result.stdout };
				} catch (error) {
					if (error instanceof CommandExitError) {
						return { exit_code: error.exitCode, stdout: error.stdout };
					}
					throw error;
				}
			},
			async start(command, envs) {
				const handle = await sandbox.commands.run(command, {
					background: true,
					envs,
					timeoutMs: 0,
					retainOutput: false
				});
				await handle.disconnect();
			},
			async follow(command, on_stdout, signal) {
				const handle = await sandbox.commands.run(command, {
					background: true,
					timeoutMs: 0,
					retainOutput: false,
					onStdout: on_stdout
				});
				const abort = () => void handle.kill().catch(() => undefined);
				signal?.addEventListener('abort', abort, { once: true });
				try {
					await handle.wait();
				} catch (error) {
					if (!(error instanceof CommandExitError)) throw error;
				} finally {
					signal?.removeEventListener('abort', abort);
				}
			},
			async interactive(command, options) {
				const handle = await sandbox.commands.run(command, {
					background: true,
					stdin: true,
					timeoutMs: 0,
					retainOutput: false,
					cwd: options.cwd,
					envs: options.envs,
					onStdout: options.on_stdout,
					onStderr: options.on_stderr
				});
				return {
					sendStdin: (data) => handle.sendStdin(data),
					closeStdin: () => handle.closeStdin(),
					kill: async () => {
						await handle.kill();
					},
					async wait() {
						try {
							return (await handle.wait()).exitCode;
						} catch (error) {
							return error instanceof CommandExitError ? error.exitCode : null;
						}
					}
				};
			},
			async writeFile(path, content) {
				await sandbox.files.write(path, content);
			},
			async setTimeout(timeout_ms) {
				await sandbox.setTimeout(timeout_ms);
			},
			async updateNetwork(network) {
				await sandbox.updateNetwork(toSdkNetwork(network));
			},
			async kill() {
				await sandbox.kill();
			}
		};
	}

	return {
		async create(input) {
			const sandbox = await Sandbox.create(input.template, {
				apiKey: await api_key(),
				timeoutMs: input.timeout_ms,
				metadata: input.metadata,
				envs: input.envs,
				network: toSdkNetwork(input.network),
				// Pause, not kill, so the next message or follow-up resumes the session.
				lifecycle: { onTimeout: 'pause' }
			});
			return wrap(sandbox);
		},
		async connect(id, timeout_ms) {
			return wrap(await Sandbox.connect(id, { apiKey: await api_key(), timeoutMs: timeout_ms }));
		},
		async info(id) {
			try {
				const info = await Sandbox.getInfo(id, { apiKey: await api_key() });
				return {
					id: info.sandboxId,
					state: info.state === 'paused' ? 'paused' : 'running',
					metadata: info.metadata
				};
			} catch (error) {
				if (error instanceof NotFoundError) return undefined;
				throw new SandboxUnavailableError();
			}
		},
		async find(metadata) {
			try {
				const pages = Sandbox.list({
					apiKey: await api_key(),
					query: { metadata, state: ['running', 'paused'] }
				});
				const found: SandboxInfo[] = [];
				while (pages.hasNext && found.length < 100) {
					for (const info of await pages.nextItems()) {
						found.push({
							id: info.sandboxId,
							state: info.state === 'paused' ? 'paused' : 'running',
							metadata: info.metadata
						});
					}
				}
				return found;
			} catch {
				throw new SandboxUnavailableError();
			}
		}
	};
}
