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
 *
 * The context slides (ADR-0024 rule 7). When a turn ends with the CLI's live
 * context past {@link SLIDE_TOKENS}, the runner sends a turn of its own
 * asking for a carry-over note, keeps the note in the chat's meta, ends that
 * CLI and starts the next message in a fresh CLI session (the next window)
 * with the note in its system prompt. The maintenance turn's events stay out
 * of the chat log; the next turn opens with a short `thinking` line saying
 * the context was renewed. Beadsmith's view of the chat does not change.
 */

import { createHash } from 'node:crypto';
import { claudeCode, type HarnessLaunch } from '../agent-session/claude-code.js';
import {
	AgentSession,
	SESSION_LABEL,
	SessionError,
	type SessionState,
	type SessionTiming
} from '../agent-session/session.js';
import type { HcClient } from '../hc/client.js';
import type { MissionEvent } from '../mission-events.js';
import type { ChatLog, ChatMeta, MissionEventDraft } from './event-log.js';
import { scopePrompt } from './spawn.js';

/** The label naming the Beadsmith chat on its terminal (ADR-0021 rule 2). */
export const CHAT_LABEL = 'beadsmith-chat';
/**
 * The label naming the chat's own session id on every window's terminal, so
 * the terminal relay and a reconnect find the live CLI whatever its window.
 */
export const CHAT_SESSION_LABEL = 'beadsmith-chat-session';

/** Whether a terminal is the CLI of the chat with this session id, in any window. */
export function isChatTerminal(labels: Record<string, string>, session_id: string): boolean {
	return labels[CHAT_SESSION_LABEL] === session_id || labels[SESSION_LABEL] === session_id;
}

/** A turn ending with at least this much live context slides the window (ADR-0024). */
export const SLIDE_TOKENS = 100_000;
/** Longest carry-over note kept, in characters (ADR-0024). */
export const CARRY_OVER_MAX = 8_000;

/** The runner's own turn asking the outgoing window for its carry-over note. */
export const CARRY_OVER_PROMPT = `[Beadsmith runner, not the captain] Your context is getting long, so this chat will continue in a fresh session after this turn. Write the carry-over note that fresh session will start from. It replaces this conversation for you, so include what you need and nothing else:

- In flight: what you are doing right now and the next step.
- Decided: decisions and answers the captain gave that still matter.
- Open threads: questions waiting on the captain, things you promised to do.
- Pointers: bead ids, mission ids, meta folder paths, files, and memory keys worth looking up again.

If you have the remember or meta_write tools, save anything durable there first; the note is for this chat only. Do not start new work. Reply with only the note, in plain Markdown, under ${CARRY_OVER_MAX - 1_000} characters.`;

const RENEWED = 'Context renewed: this reply continues from my carry-over note.';

/**
 * The CLI session id of a chat's window: the chat's own for window 0, and
 * a UUID derived from it and the window number after that.
 */
export function windowSessionId(session_id: string, window: number): string {
	if (window <= 0) return session_id;
	const hex = createHash('sha256').update(`${session_id}/window/${window}`).digest('hex');
	// Shaped as a version 4 UUID, lowercase, like Beadsmith's session ids.
	const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The appended system prompt for a window: the scope, then the carry-over note. */
export function windowPrompt(meta: Pick<ChatMeta, 'scope' | 'carry_over'>): string | undefined {
	const parts: string[] = [];
	if (meta.scope !== null) parts.push(scopePrompt(meta.scope));
	if (meta.carry_over !== undefined && meta.carry_over.length > 0) {
		parts.push(
			`This chat continues from an earlier session of yours. The captain sees one continuous chat, so carry on without announcing a restart. Your carry-over note from that session:\n\n<carry-over-note>\n${meta.carry_over}\n</carry-over-note>`
		);
	}
	return parts.length === 0 ? undefined : parts.join('\n\n');
}

/** A carry-over reply as kept: control characters out, bounded. */
export function carryOverNote(text: string | undefined): string | undefined {
	if (text === undefined) return undefined;
	const note = [...text.replace(/\r\n?/g, '\n')]
		.filter((c) => c === '\n' || c === '\t' || (c >= ' ' && c !== '\u007f'))
		.join('')
		.trim();
	if (note.length === 0) return undefined;
	return note.length > CARRY_OVER_MAX ? `${note.slice(0, CARRY_OVER_MAX - 1)}…` : note;
}

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
	/** Live context tokens at which a turn's end slides the window (default {@link SLIDE_TOKENS}). */
	slide_tokens?: number;
	/** Server-side diagnostics; never shown in the chat. */
	log?: (message: string) => void;
}

/** The runner's carry-over turn and what it produced. */
interface Maintenance {
	session: AgentSession;
	succeeded: boolean;
	/** The turn's last assistant text, raw. */
	text?: string;
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
	/** The window's context is past the threshold: write a carry-over note before the next message. */
	#slide_due = false;
	/** The runner's carry-over turn is under way; its events stay out of the log. */
	#maintenance: Maintenance | undefined;
	/** The next turn is the first of a new window: say so in the chat. */
	#renewed = false;
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

	/** A message is queued or a turn (the captain's or the runner's) is under way. */
	get busy(): boolean {
		return this.#in_flight || this.#queue.length > 0 || this.#maintenance !== undefined;
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
		if (this.#maintenance !== undefined) {
			// Stop the carry-over turn; the window stays as it is.
			this.#slide_due = false;
			if (dropped > 0) this.#append({ type: 'result', status: 'cancelled' });
			this.#savePending();
			await session?.interrupt().catch(() => undefined);
			return;
		}
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
			while ((this.#queue.length > 0 || this.#slide_due) && !this.#stopping) {
				if (this.#slide_due) {
					this.#slide_due = false;
					await this.#slide();
					continue;
				}
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
				if (this.#renewed) {
					this.#renewed = false;
					this.#append({ type: 'thinking', text: RENEWED });
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
		// The chat's home and sandbox follow its own session id; the CLI is the window's.
		const connection = await this.#connect(meta.session_id);
		const system = windowPrompt(meta);
		const session: AgentSession = new AgentSession({
			harness: claudeCode,
			launch: {
				session_id: windowSessionId(meta.session_id, meta.window ?? 0),
				...connection.launch,
				...(meta.model === undefined ? {} : { model: meta.model }),
				...(meta.effort === undefined ? {} : { effort: meta.effort }),
				...(system === undefined ? {} : { append_system_prompt: system })
			},
			labels: { [CHAT_LABEL]: this.#log.chat_id, [CHAT_SESSION_LABEL]: meta.session_id },
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
		const maintenance = this.#maintenance;
		if (maintenance !== undefined && maintenance.session === session) {
			// The runner's own turn: nothing of it goes in the chat.
			if (event.type === 'result') {
				maintenance.succeeded = event.status === 'succeeded';
				maintenance.text = session.last_turn?.last_text;
				this.#endTurn();
			}
			return;
		}
		const { id: _id, ...draft } = event;
		if (event.type === 'result') {
			// After a stop the captain wants quiet: the next long turn slides instead.
			const tokens = session.last_turn?.context_tokens ?? 0;
			if (event.status !== 'cancelled' && tokens >= (this.#options.slide_tokens ?? SLIDE_TOKENS)) {
				this.#slide_due = true;
			}
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
			else if (this.#maintenance !== undefined) this.#endTurn();
		}
	}

	// ── sliding the window ──────────────────────────────────────────────

	/**
	 * Ask the live CLI for a carry-over note, keep it, and end that CLI so
	 * the next message opens the next window. Anything short of a note (a
	 * lost channel, an interrupt, an empty reply) leaves the window as it
	 * is; the next long turn asks again.
	 */
	async #slide(): Promise<void> {
		const session = this.#session;
		const meta = this.#log.meta;
		if (session === undefined || meta === undefined || session.busy) return;
		const maintenance: Maintenance = { session, succeeded: false };
		this.#maintenance = maintenance;
		const ended = new Promise<void>((resolve) => (this.#turn_end = resolve));
		try {
			await session.send(CARRY_OVER_PROMPT);
			this.#startKeepalive();
			await ended;
		} catch (error) {
			this.#diagnose('the carry-over turn could not be sent', error);
			this.#turn_end = undefined;
		} finally {
			this.#maintenance = undefined;
		}
		const note = maintenance.succeeded ? carryOverNote(maintenance.text) : undefined;
		const current = this.#log.meta;
		if (note === undefined || current === undefined || this.#stopping) {
			if (!this.#stopping) this.#diagnose('no carry-over note', 'the window stays');
			return;
		}
		this.#log.setMeta({ ...current, window: (current.window ?? 0) + 1, carry_over: note });
		this.#renewed = true;
		// The old window's CLI is done; its transcript stays where it ran.
		if (this.#session === session) {
			await session.cancel().catch(() => undefined);
			this.#drop();
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
