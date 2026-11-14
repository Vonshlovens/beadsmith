/**
 * First Mate chats in E2B sandboxes ("Sand"; ADR-0018, docs/sand-e2b.md).
 *
 * This is the mate runner's own core (`src/lib/mate-runner/server.ts`: chat
 * logs, interactive Claude Code in an hc terminal per chat driven by the
 * session core, message dedupe and queueing, interrupt, resume after a
 * restart), run inside Beadsmith with a connector that reaches the chat's
 * sandbox over the E2B process channel instead of SSH (ADR-0021 rule 1).
 * Each chat gets its own sandbox, found again by its session id in the
 * sandbox metadata. A quiet chat's sandbox pauses after
 * `BDX_E2B_MATE_IDLE_MINUTES` (not billed for compute); the next message
 * resumes it and the same Claude Code session continues.
 *
 * A chat sandbox has no Beads, repository or tailnet access and holds no
 * credential: E2B's egress adds the model credential to requests for
 * api.anthropic.com. What First Mate can see and do in Beadsmith comes
 * through crew tools (ADR-0020), relayed over the E2B process channel by
 * `crew-bridge.ts` and run here as the chat's owner.
 */
import { encodeMissionEvent, type MissionEvent } from '#lib/mission-events.js';
import { ChatStore } from '#lib/mate-runner/event-log.js';
import { createRunnerCore, RunnerFault, type RunnerCore } from '#lib/mate-runner/server.js';
import { isChatTerminal, type ConnectAgent } from '#lib/mate-runner/session.js';
import type { SessionTiming } from '#lib/agent-session/session.js';
import type { HcClient } from '#lib/hc/client.js';
import type { E2bMateSettings } from '../env.js';
import { createCrewMcpHandler } from '../crew/mcp.js';
import { getMateStore } from '../state/db.js';
import { readSecretFile } from '../dispatch/sandbox-credentials.js';
import { sanitizeResultSummary } from '../dispatch/sanitize.js';
import {
	buildSandboxNetwork,
	createSdkDriver,
	modelPlaceholderEnvs,
	readModelCredential,
	type SandboxDriver,
	type SandboxRef
} from '../e2b/sandbox.js';
import { CLAUDE_CONFIG_DIR, MATE_WORKDIR } from '../e2b/image.js';
import { connectSandboxHc } from '../e2b/hc-transport.js';
import {
	attachSandboxTerminal,
	RELAY_GONE_MESSAGE,
	RELAY_NOT_STARTED_MESSAGE,
	RELAY_UNAVAILABLE_MESSAGE,
	TerminalRelayError
} from '../terminal-relay/relay.js';
import {
	CREW_MCP_CONFIG_PATH,
	prepareChatSandbox,
	startCrewBridge,
	stopRelayCommand,
	type CrewBridge,
	type CrewBridgeDeps
} from './crew-bridge.js';
import {
	MateRunnerError,
	toMateEvent,
	type MateRunner,
	type MateRunnerErrorCode
} from './runner.js';

const SESSION_KEY = 'beadsmith_mate_session';
/** Extend the sandbox's idle timeout at most this often while the agent is active. */
const KEEPALIVE_EVERY_MS = 60_000;

export interface E2bMateDeps {
	settings: E2bMateSettings;
	driver?: SandboxDriver;
	read_secret?: (path: string, what: string) => Promise<string>;
	now?: () => number;
	/** Crew tools for the chat; defaults to the production handler and chat store. */
	crew?: CrewBridgeDeps;
	/** Reach a sandbox's hc core; defaults to the `beadsmith-hc` carrier. */
	connect_hc?: ConnectSandboxHc;
	/** Session timing (tests shorten it). */
	timing?: SessionTiming;
	/**
	 * Server-side diagnostics (E2B errors, stderr tails). Never shown in the
	 * browser, which gets fixed messages only.
	 */
	log?: (message: string) => void;
}

/**
 * Production crew tools: the full tool list, acting as whoever owns the chat
 * behind a session, looked up in `state.db` on every call, with each answered
 * call kept for the chat's owner.
 */
export function defaultCrewBridgeDeps(): CrewBridgeDeps {
	return {
		handler: createCrewMcpHandler({
			// The owner's record of what Beadsmith did for the chat (ADR-0020).
			record: async (ctx, call) => (await getMateStore()).recordCrewCall(ctx.chat_id, call)
		}),
		async context(session_id) {
			const caller = await (await getMateStore()).crewCaller(session_id);
			if (caller === undefined) return undefined;
			return {
				account_id: caller.owner_id,
				actor: caller.owner_email,
				role: caller.role,
				chat_id: caller.chat_id,
				scope: caller.scope
			};
		}
	};
}

/** Open an hc client on a sandbox's core (the E2B process channel). */
export type ConnectSandboxHc = (sandbox: SandboxRef) => Promise<HcClient>;

/**
 * Reach each chat's own sandbox and its hc core. Every connect (a chat's
 * first message, or the first after a restart, an eviction or a lost
 * channel) refreshes the relay, MCP config and instructions, ends a CLI left
 * from before (it was talking to the old relay) and starts the crew relay,
 * so the session core's launch resumes the conversation against the new one.
 */
export function e2bConnector(deps: Required<E2bMateDeps>): ConnectAgent {
	const { settings, driver, read_secret, now, crew, log, connect_hc } = deps;
	const idle_ms = settings.idle_minutes * 60_000;
	const known = new Map<string, string>();

	async function sandboxFor(session_id: string): Promise<SandboxRef> {
		let id = known.get(session_id);
		if (id === undefined) {
			const [found] = await driver.find({ [SESSION_KEY]: session_id });
			id = found?.id;
		}
		if (id !== undefined) {
			try {
				const sandbox = await driver.connect(id, idle_ms);
				known.set(session_id, sandbox.id);
				return sandbox;
			} catch (error) {
				log(`Sand chat ${label(session_id)}: could not resume ${id}, creating: ${String(error)}`);
				known.delete(session_id);
			}
		}
		const model = await readModelCredential(settings, read_secret);
		let sandbox: SandboxRef;
		try {
			sandbox = await driver.create({
				template: settings.template,
				timeout_ms: idle_ms,
				metadata: { beadsmith: '1', [SESSION_KEY]: session_id },
				envs: modelPlaceholderEnvs(model.kind),
				network: buildSandboxNetwork(settings, model)
			});
		} catch (error) {
			log(`Sand chat ${label(session_id)}: E2B could not create a sandbox: ${String(error)}`);
			throw error;
		}
		known.set(session_id, sandbox.id);
		return sandbox;
	}

	return async (session_id) => {
		let client: HcClient | undefined;
		let bridge: CrewBridge | undefined;
		try {
			const sandbox = await sandboxFor(session_id);
			await prepareChatSandbox(sandbox);
			// hc connect starts the core on first use, with the sandbox's environment.
			client = await connect_hc(sandbox);
			// Every window's CLI of this chat (ADR-0024 rule 7), and one from before windows.
			for (const terminal of await client.list({})) {
				if (terminal.state === 'live' && isChatTerminal(terminal.labels, session_id)) {
					await client.kill(terminal.address);
				}
			}
			await sandbox.exec(stopRelayCommand());
			// Without the relay the chat still talks; its crew tool calls fail
			// and the agent says so, which beats no chat at all.
			bridge = await startCrewBridge({ sandbox, session_id, deps: crew, log }).catch(
				(error: unknown) => {
					log(`Sand chat ${label(session_id)}: crew relay did not start: ${String(error)}`);
					return undefined;
				}
			);
			let last_keepalive = 0;
			return {
				client,
				launch: {
					cwd: MATE_WORKDIR,
					config_dir: CLAUDE_CONFIG_DIR,
					mcp_config: CREW_MCP_CONFIG_PATH
				},
				// A quiet chat's sandbox pauses after the idle time; activity extends it.
				touch() {
					const at = now();
					if (at - last_keepalive < KEEPALIVE_EVERY_MS) return;
					last_keepalive = at;
					void sandbox.setTimeout(idle_ms).catch(() => undefined);
				},
				release: () => bridge?.stop()
			};
		} catch (error) {
			client?.close();
			bridge?.stop();
			log(`Sand chat ${label(session_id)}: the agent could not start: ${String(error)}`);
			throw new Error('The sandbox could not start the agent.');
		}
	};
}

/** A short, non-identifying label for log lines. */
function label(session_id: string): string {
	return session_id.slice(0, 8);
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
	// E2B errors can echo request headers; every line is stripped of credential shapes.
	const log = deps.log ?? ((message: string) => console.warn(message));
	const clean = (message: string) => log(sanitizeResultSummary(message, '') ?? message);
	const core: RunnerCore = createRunnerCore({
		store,
		connect: e2bConnector({
			settings: deps.settings,
			driver,
			read_secret,
			now: deps.now ?? Date.now,
			crew: deps.crew ?? defaultCrewBridgeDeps(),
			log: clean,
			connect_hc: deps.connect_hc ?? connectSandboxHc,
			timing: deps.timing ?? {}
		}),
		max_live_sessions: deps.settings.max_sessions,
		agent: { timing: deps.timing, log: clean }
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
				await core.interrupt(chat_id);
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

		async attachTerminal(chat_id, request) {
			let session_id: string | undefined;
			try {
				session_id = store.get(chat_id).meta?.session_id;
			} catch {
				throw new TerminalRelayError('unavailable', RELAY_UNAVAILABLE_MESSAGE);
			}
			if (session_id === undefined)
				throw new TerminalRelayError('conflict', RELAY_NOT_STARTED_MESSAGE);
			let found;
			try {
				[found] = await driver.find({ [SESSION_KEY]: session_id });
			} catch {
				throw new TerminalRelayError('unavailable', RELAY_UNAVAILABLE_MESSAGE);
			}
			if (found === undefined) throw new TerminalRelayError('conflict', RELAY_GONE_MESSAGE);
			const owned = session_id;
			return attachSandboxTerminal(
				{
					driver,
					connect_hc: deps.connect_hc ?? connectSandboxHc,
					idle_ms: deps.settings.idle_minutes * 60_000
				},
				found.id,
				(live) => live.find((terminal) => isChatTerminal(terminal.labels, owned)),
				request
			);
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
