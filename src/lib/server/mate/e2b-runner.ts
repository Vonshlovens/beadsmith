/**
 * First Mate chats in E2B sandboxes ("Sand"; ADR-0017, docs/sand-e2b.md).
 *
 * This is the mate runner's own core (`src/lib/mate-runner/server.ts`: chat
 * logs, one long-lived Claude Code process per chat, message dedupe,
 * interrupt, resume after a restart), run inside Beadsmith with an E2B
 * spawner instead of SSH. Each chat gets its own sandbox, found again by its
 * session id in the sandbox metadata. A quiet chat's sandbox pauses after
 * `BDX_E2B_MATE_IDLE_MINUTES` (not billed for compute); the next message
 * resumes it and the same Claude Code session continues.
 *
 * Like the forge guest (ADR-0016), a chat sandbox has model access only: no
 * Beads, repository or tailnet access. The model credential never enters it;
 * E2B's egress adds it to requests for api.anthropic.com.
 */
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { encodeMissionEvent, type MissionEvent } from '#lib/mission-events.js';
import { ChatStore } from '#lib/mate-runner/event-log.js';
import { createRunnerCore, RunnerFault, type RunnerCore } from '#lib/mate-runner/server.js';
import type { AgentLaunch, AgentProcess, SpawnAgent } from '#lib/mate-runner/session.js';
import { claudeArgs, shellQuote } from '#lib/mate-runner/spawn.js';
import type { E2bMateSettings } from '../env.js';
import { readSecretFile } from '../dispatch/sandbox-credentials.js';
import {
	buildSandboxNetwork,
	createSdkDriver,
	modelPlaceholderEnvs,
	readModelCredential,
	type InteractiveCommand,
	type SandboxDriver,
	type SandboxRef
} from '../e2b/sandbox.js';
import {
	MateRunnerError,
	toMateEvent,
	type MateRunner,
	type MateRunnerErrorCode
} from './runner.js';

/** The chat agent's working directory in the template (its AGENTS.md lives there). */
export const MATE_WORKDIR = '/home/user/mate';
const SESSION_KEY = 'beadsmith_mate_session';
/** Extend the sandbox's idle timeout at most this often while the agent is active. */
const KEEPALIVE_EVERY_MS = 60_000;

export interface E2bMateDeps {
	settings: E2bMateSettings;
	driver?: SandboxDriver;
	read_secret?: (path: string, what: string) => Promise<string>;
	now?: () => number;
}

/**
 * A Claude Code process in a chat's sandbox, shaped like a child process for
 * `AgentSession`. Writes before the process starts are queued in order.
 */
class SandboxAgentProcess extends EventEmitter implements AgentProcess {
	readonly stdin: Writable;
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	#command: InteractiveCommand | undefined;
	#queue: Promise<void> = Promise.resolve();
	#killed = false;
	#on_activity: () => void;
	#started: Promise<void> | undefined;
	#resolveStarted: (() => void) | undefined;

	constructor(on_activity: () => void) {
		super();
		this.#on_activity = on_activity;
		this.stdin = new Writable({
			write: (chunk: Buffer | string, _encoding, callback) => {
				const data = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
				this.#on_activity();
				this.#queue = this.#queue.then(async () => {
					await this.#ready();
					await this.#command?.sendStdin(data);
				});
				this.#queue.then(
					() => callback(),
					(error: Error) => callback(error)
				);
			},
			final: (callback) => {
				this.#queue = this.#queue.then(async () => {
					await this.#ready();
					await this.#command?.closeStdin();
				});
				this.#queue.then(
					() => callback(),
					() => callback()
				);
			}
		});
	}

	#ready(): Promise<void> {
		this.#started ??= new Promise((resolve) => {
			this.#resolveStarted = resolve;
		});
		return this.#started;
	}

	attach(command: InteractiveCommand): void {
		this.#command = command;
		void this.#ready();
		this.#resolveStarted?.();
		if (this.#killed) void command.kill().catch(() => undefined);
		void command.wait().then((code) => this.exited(code));
	}

	output(chunk: string): void {
		this.#on_activity();
		this.stdout.write(chunk);
	}

	exited(code: number | null): void {
		this.stdout.end();
		this.stderr.end();
		this.emit('exit', code);
	}

	failed(error: Error): void {
		void this.#ready();
		this.#resolveStarted?.();
		this.stdout.end();
		this.stderr.end();
		this.emit('error', error);
	}

	kill(): boolean {
		this.#killed = true;
		void this.#command?.kill().catch(() => undefined);
		return true;
	}
}

/** Spawn each chat's Claude Code in that chat's own sandbox. */
export function e2bSpawner(
	deps: Required<Omit<E2bMateDeps, 'now'>> & { now: () => number }
): SpawnAgent {
	const { settings, driver, read_secret, now } = deps;
	const idle_ms = settings.idle_minutes * 60_000;
	const known = new Map<string, string>();

	async function sandboxFor(session_id: string): Promise<{ sandbox: SandboxRef; fresh: boolean }> {
		let id = known.get(session_id);
		if (id === undefined) {
			const [found] = await driver.find({ [SESSION_KEY]: session_id });
			id = found?.id;
		}
		if (id !== undefined) {
			try {
				const sandbox = await driver.connect(id, idle_ms);
				known.set(session_id, sandbox.id);
				return { sandbox, fresh: false };
			} catch {
				known.delete(session_id);
			}
		}
		const model = await readModelCredential(settings, read_secret);
		const sandbox = await driver.create({
			template: settings.template,
			timeout_ms: idle_ms,
			metadata: { beadsmith: '1', [SESSION_KEY]: session_id },
			envs: modelPlaceholderEnvs(model.kind),
			network: buildSandboxNetwork(settings, model)
		});
		known.set(session_id, sandbox.id);
		return { sandbox, fresh: true };
	}

	return (launch: AgentLaunch) => {
		let last_keepalive = 0;
		let sandbox: SandboxRef | undefined;
		const keepalive = () => {
			const at = now();
			if (sandbox === undefined || at - last_keepalive < KEEPALIVE_EVERY_MS) return;
			last_keepalive = at;
			void sandbox.setTimeout(idle_ms).catch(() => undefined);
		};
		const process = new SandboxAgentProcess(keepalive);
		void (async () => {
			try {
				const found = await sandboxFor(launch.session_id);
				sandbox = found.sandbox;
				// A new sandbox has no session to resume: start it under the same id.
				const args = claudeArgs(found.fresh ? { ...launch, resume: false } : launch);
				// After a pause, the previous process for this chat may still be there.
				await sandbox.exec(
					`pkill -f -- ${shellQuote(`claude .*${launch.session_id}`)} 2>/dev/null; true`
				);
				const command = await sandbox.interactive(['claude', ...args].map(shellQuote).join(' '), {
					cwd: MATE_WORKDIR,
					on_stdout: (chunk) => process.output(chunk),
					on_stderr: () => undefined
				});
				process.attach(command);
			} catch {
				process.failed(new Error('The sandbox could not start the agent.'));
			}
		})();
		return process;
	};
}

function toRunnerError(error: unknown): MateRunnerError {
	if (error instanceof MateRunnerError) return error;
	if (error instanceof RunnerFault) {
		const code: MateRunnerErrorCode =
			error.status === 400
				? 'bad_request'
				: error.status === 404
					? 'not_found'
					: error.status === 409
						? 'conflict'
						: 'unavailable';
		return new MateRunnerError(code, error.message);
	}
	return new MateRunnerError('unavailable', 'The Sand chat runner failed.');
}

/** A `MateRunner` for chats in E2B sandboxes, in this process. */
export function createE2bMateRunner(deps: E2bMateDeps): MateRunner & { close(): Promise<void> } {
	const read_secret = deps.read_secret ?? readSecretFile;
	const driver =
		deps.driver ?? createSdkDriver(() => read_secret(deps.settings.api_key_file, 'E2B API key'));
	const store = new ChatStore(deps.settings.state_dir);
	const core: RunnerCore = createRunnerCore({
		store,
		spawn: e2bSpawner({
			settings: deps.settings,
			driver,
			read_secret,
			now: deps.now ?? Date.now
		}),
		max_live_sessions: deps.settings.max_sessions
	});

	return {
		async sendMessage(chat_id, input) {
			try {
				return await core.sendMessage(chat_id, { ...input });
			} catch (error) {
				throw toRunnerError(error);
			}
		},

		streamEvents(chat_id, after, on_event, signal) {
			return new Promise((resolve, reject) => {
				let queue = Promise.resolve();
				let unsubscribe: () => void = () => undefined;
				const stop = () => {
					unsubscribe();
					void queue.then(() => resolve('aborted'));
				};
				try {
					unsubscribe = core.follow(chat_id, after, (event: MissionEvent) => {
						// The same bounds and scrubbing the HTTP client applies.
						const clean = toMateEvent(
							{ id: event.id, data: JSON.stringify(encodeMissionEvent(event)) },
							''
						);
						if (clean === undefined) return;
						queue = queue
							.then(() => on_event(clean))
							.catch((error: unknown) => {
								unsubscribe();
								reject(toRunnerError(error));
							});
					});
				} catch (error) {
					reject(toRunnerError(error));
					return;
				}
				if (signal.aborted) stop();
				else signal.addEventListener('abort', stop, { once: true });
			});
		},

		async interrupt(chat_id) {
			try {
				core.interrupt(chat_id);
			} catch (error) {
				throw toRunnerError(error);
			}
		},

		async deleteChat(chat_id) {
			let session_id: string | undefined;
			try {
				session_id = store.get(chat_id).meta?.session_id;
			} catch (error) {
				throw toRunnerError(error);
			}
			// The sandbox first: if it cannot be removed, the chat stays on both
			// sides and the delete can be retried (docs/first-mate.md).
			if (session_id !== undefined) {
				try {
					for (const found of await driver.find({ [SESSION_KEY]: session_id })) {
						await (await driver.connect(found.id, 60_000)).kill();
					}
				} catch {
					throw new MateRunnerError('unavailable', "The chat's sandbox could not be removed yet.");
				}
			}
			try {
				await core.deleteChat(chat_id);
			} catch (error) {
				throw toRunnerError(error);
			}
		},

		async health() {
			try {
				await read_secret(deps.settings.api_key_file, 'E2B API key');
				return true;
			} catch {
				return false;
			}
		},

		close: () => core.close()
	};
}
