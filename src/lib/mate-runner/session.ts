/**
 * One First Mate chat's agent: interactive Claude Code in an hc terminal,
 * driven by the session core (ADR-0021, `src/lib/agent-session/`).
 *
 * The CLI lives between turns, so a follow-up is the next message to the same
 * running process and the agent keeps its context. Messages that arrive while
 * a turn runs (the admin typing ahead, a crew notice) wait in order and go in
 * when the turn ends: mate runner contract v1 has no "busy" answer.
 *
 * The chat holds no channel while it has nothing to say. The first message
 * after the runner started, evicted the chat or lost its channel connects
 * again and attaches the session core, which follows the live terminal
 * labelled with this session or launches the CLI (resuming its transcript
 * when one exists), so the conversation survives runner restarts, a lost
 * guest and a new sandbox.
 */

import { claudeCode, type HarnessLaunch } from '../agent-session/claude-code.js';
import {
	AgentSession,
	SessionError,
	type SessionState,
	type SessionTiming
} from '../agent-session/session.js';
import type { HcClient } from '../hc/client.js';
import type { MissionEvent } from '../mission-events.js';
import type { ChatLog, MissionEventDraft } from './event-log.js';
import { scopePrompt } from './spawn.js';

/** The label naming the Beadsmith chat on its terminal (ADR-0021 rule 2). */
export const CHAT_LABEL = 'beadsmith-chat';

/** An open channel to the hc core a chat's agent runs under. */
export interface AgentConnection {
	client: HcClient;
	/** Where and how the CLI runs there. */
	launch: Pick<HarnessLaunch, 'cwd' | 'config_dir' | 'command' | 'mcp_config'>;
	/** The agent is active (a message or an event): keep its machine awake. */
	touch?(): void;
	/** Release what the connector set up beside the client (the crew relay on Sand). */
	release?(): void;
}

/** Open a channel to the hc core of the chat with this CLI session id. */
export type ConnectAgent = (session_id: string) => Promise<AgentConnection>;

export interface ChatAgentOptions {
	timing?: SessionTiming;
	/** Keep-alive while a turn runs with nothing to show (default 60 s). */
	touch_ms?: number;
	/** Server-side diagnostics; never shown in the chat. */
	log?: (message: string) => void;
}

const START_FAILED = 'The agent could not start. Send a message to try again.';
const BLOCKED = 'The agent is waiting for a decision in its terminal; this message was not sent.';
const LOST = 'The connection to the agent was lost in the middle of a turn.';

function unref(timer: ReturnType<typeof setInterval>): ReturnType<typeof setInterval> {
	(timer as { unref?: () => void }).unref?.();
	return timer;
}

export class ChatAgent {
	readonly #log: ChatLog;
	readonly #connect: ConnectAgent;
	readonly #options: ChatAgentOptions;
	#connection: AgentConnection | undefined;
	#session: AgentSession | undefined;
	/** Messages accepted but not yet sent, oldest first. */
	readonly #queue: string[] = [];
	/** A message taken from the queue whose turn has not ended. */
	#in_flight = false;
	/** Interrupt arrived while the in-flight message was still being sent. */
	#interrupt_next = false;
	#turn_end: (() => void) | undefined;
	#pumping = false;
	#stopping = false;
	#stop_promise: Promise<void> | undefined;
	#keepalive: ReturnType<typeof setInterval> | undefined;
	/** When the agent last did anything, for evicting idle chats. */
	last_active = Date.now();

	constructor(log: ChatLog, connect: ConnectAgent, options: ChatAgentOptions = {}) {
		this.#log = log;
		this.#connect = connect;
		this.#options = options;
	}

	/** The chat holds a channel and a CLI (or is opening one). */
	get running(): boolean {
		return this.#session !== undefined || this.#pumping;
	}

	/** A message is queued or its turn is under way. */
	get busy(): boolean {
		return this.#in_flight || this.#queue.length > 0;
	}

	/** Refuses while the chat is being stopped. */
	prepare(): void {
		if (this.#stopping) throw new Error('session is stopping');
	}

	/**
	 * Accept one user message. It goes to the agent as soon as no turn is
	 * under way; `scope`, when given, is a changed project for the chat and is
	 * stated ahead of the message.
	 */
	send(prompt: string, scope?: string | null): void {
		this.prepare();
		if (this.#log.meta === undefined) throw new Error('chat has no session');
		const context =
			scope === undefined
				? ''
				: `${scope === null ? 'This chat now covers every available Beads project.' : scopePrompt(scope)}

`;
		this.#queue.push(context + prompt);
		this.#savePending();
		this.#touch();
		void this.#pump();
	}

	/**
	 * Stop the turn under way; the CLI keeps running. Messages still waiting
	 * are dropped too: stop means stop. The turn ends with a `cancelled`
	 * result, or one is written for messages that never reached the agent.
	 */
	async interrupt(): Promise<void> {
		const dropped = this.#queue.splice(0).length;
		const session = this.#session;
		if (this.#in_flight && session?.busy) {
			this.#savePending();
			await session.interrupt().catch(() => undefined);
			return;
		}
		if (this.#in_flight) {
			// Still opening the channel or sending: the pump stops it.
			this.#interrupt_next = true;
			this.#savePending();
			return;
		}
		if (dropped > 0) this.#append({ type: 'result', status: 'cancelled' });
		this.#savePending();
	}

	/** End the CLI and the channel. Queued messages are dropped. */
	stop(): Promise<void> {
		this.#stop_promise ??= this.#stop().finally(() => {
			this.#stopping = false;
			this.#stop_promise = undefined;
		});
		return this.#stop_promise;
	}

	async #stop(): Promise<void> {
		this.#stopping = true;
		this.#queue.splice(0);
		const session = this.#session;
		if (session !== undefined) {
			// A turn under way ends as cancelled; a channel already gone fails quietly.
			await session.cancel().catch(() => undefined);
		}
		this.#drop();
		this.#endTurn();
		this.#savePending();
	}

	// ── the queue ───────────────────────────────────────────────────────

	async #pump(): Promise<void> {
		if (this.#pumping) return;
		this.#pumping = true;
		try {
			while (this.#queue.length > 0 && !this.#stopping) {
				const text = this.#queue.shift()!;
				this.#in_flight = true;
				this.#interrupt_next = false;
				const ended = new Promise<void>((resolve) => (this.#turn_end = resolve));
				let session: AgentSession;
				try {
					session = await this.#open();
				} catch (error) {
					this.#diagnose('the agent could not start', error);
					const message =
						error instanceof SessionError && error.code === 'startup'
							? error.message
							: START_FAILED;
					this.#failWaiting(message);
					continue;
				}
				if (this.#interrupt_next || this.#stopping) {
					this.#finishTurn({ type: 'result', status: 'cancelled' });
					continue;
				}
				try {
					await session.send(text);
				} catch (error) {
					if (error instanceof SessionError && error.code === 'blocked') {
						this.#finishTurn({ type: 'error', message: BLOCKED });
					} else if (this.#in_flight) {
						// A lost channel has already ended the turn (#onState).
						this.#diagnose('a message could not be sent', error);
						this.#drop();
						this.#finishTurn({ type: 'error', message: START_FAILED });
					}
					continue;
				}
				if (this.#interrupt_next) await session.interrupt().catch(() => undefined);
				this.#startKeepalive();
				await ended;
			}
		} finally {
			this.#pumping = false;
			this.#stopKeepalive();
		}
	}

	/** The chat's live session, connecting and attaching first when there is none. */
	async #open(): Promise<AgentSession> {
		if (this.#session !== undefined) return this.#session;
		const meta = this.#log.meta;
		if (meta === undefined) throw new Error('chat has no session');
		const connection = await this.#connect(meta.session_id);
		const session: AgentSession = new AgentSession({
			harness: claudeCode,
			launch: {
				session_id: meta.session_id,
				...connection.launch,
				...(meta.model === undefined ? {} : { model: meta.model }),
				...(meta.effort === undefined ? {} : { effort: meta.effort }),
				...(meta.scope === null ? {} : { append_system_prompt: scopePrompt(meta.scope) })
			},
			labels: { [CHAT_LABEL]: this.#log.chat_id },
			onEvent: (event) => this.#onEvent(session, event),
			onState: (state) => this.#onState(session, state),
			timing: this.#options.timing
		});
		this.#connection = connection;
		this.#session = session;
		try {
			if (this.#stopping) throw new Error('the chat is stopping');
			await session.attach(connection.client);
		} catch (error) {
			if (this.#session === session) this.#drop();
			throw error;
		}
		return session;
	}

	/** Let go of the session and its channel, leaving the terminal as it is. */
	#drop(): void {
		const session = this.#session;
		const connection = this.#connection;
		this.#session = undefined;
		this.#connection = undefined;
		session?.close();
		connection?.client.close();
		connection?.release?.();
	}

	#onEvent(session: AgentSession, event: MissionEvent): void {
		if (this.#session !== session) return;
		this.#touch();
		const { id: _id, ...draft } = event;
		if (event.type === 'result') {
			this.#finishTurn(draft as MissionEventDraft);
		} else {
			this.#append(draft as MissionEventDraft);
		}
	}

	#onState(session: AgentSession, state: SessionState): void {
		if (this.#session !== session) return;
		if (state === 'ended') {
			// The CLI exited; the core has closed any turn. The next message relaunches it.
			this.#drop();
			this.#endTurn();
		} else if (state === 'disconnected') {
			this.#drop();
			if (this.#in_flight) this.#finishTurn({ type: 'error', message: LOST });
		}
	}

	// ── turns and the log ───────────────────────────────────────────────

	/** Record the event that ends the in-flight message's turn. */
	#finishTurn(draft: MissionEventDraft): void {
		this.#append(draft);
		if (!this.#in_flight) return;
		this.#in_flight = false;
		this.#savePending();
		this.#endTurn();
	}

	/** Every queued message fails with `message` (the agent could not start). */
	#failWaiting(message: string): void {
		this.#queue.splice(0);
		this.#finishTurn({ type: 'error', message });
	}

	#endTurn(): void {
		this.#in_flight = false;
		const resolve = this.#turn_end;
		this.#turn_end = undefined;
		resolve?.();
	}

	#append(draft: MissionEventDraft): void {
		if (this.#log.meta === undefined) return;
		this.#log.append(draft);
	}

	#savePending(): void {
		const meta = this.#log.meta;
		if (meta === undefined) return;
		const pending = this.#queue.length + (this.#in_flight ? 1 : 0);
		if ((meta.pending ?? 0) !== pending) this.#log.setMeta({ ...meta, pending });
	}

	// ── keeping the machine awake ───────────────────────────────────────

	#touch(): void {
		this.last_active = Date.now();
		this.#connection?.touch?.();
	}

	#startKeepalive(): void {
		if (this.#keepalive !== undefined || this.#connection?.touch === undefined) return;
		this.#keepalive = unref(setInterval(() => this.#touch(), this.#options.touch_ms ?? 60_000));
	}

	#stopKeepalive(): void {
		clearInterval(this.#keepalive);
		this.#keepalive = undefined;
	}

	#diagnose(what: string, error: unknown): void {
		const detail = error instanceof Error ? error.message : String(error);
		this.#options.log?.(`chat ${this.#log.chat_id}: ${what}: ${detail}`);
	}
}
