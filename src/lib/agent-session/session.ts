/**
 * The interactive agent session core (ADR-0021 rules 2 and 3): one agent CLI
 * in one hc terminal, driven over an {@link HcClient}, with its transcript
 * mapped to MissionEvents. First Mate chats and repo-worker missions both run
 * on it, on Sand and on the forge runner; only the channel under the client
 * differs.
 *
 * Lifecycle:
 *
 * - **start** subscribes to the terminal's facts (by a label naming the
 *   session, before the terminal exists, so nothing is missed), runs the CLI
 *   and waits for its first `idle`. A CLI that reports `blocked` before its
 *   first turn is stopped and the launch fails: a first-run dialog is the
 *   sandbox image's job, never answered blindly.
 * - **send** pastes a message with `terminal.send` (the prompt never goes on
 *   the command line). A turn is complete when hc's turn counter has moved
 *   past the one `send` reported and the status is `done`, `idle` or `error`,
 *   and the transcript has been read to its end-of-turn record (or a short
 *   settle time passed). The startup `idle` is never a turn end. `blocked`
 *   mid-turn is surfaced through {@link SessionState}, never answered.
 * - **interrupt** presses the stop key; the turn ends as `cancelled`.
 *   **cancel** kills the terminal's program.
 * - **reconnect** after the channel was lost (a paused sandbox, a dropped SSH
 *   session) re-attaches to the terminal if it still runs, or starts a new
 *   one with the CLI's resume flag. A turn whose terminal was lost ends as
 *   failed.
 *
 * Event ids are `<transcript line>.<index>`, ordered, so a stream resumed
 * with Last-Event-ID (`after`) skips what the client has. The session's own
 * events (a turn's `result`, an `error`) take indexes from
 * {@link SYNTHETIC_INDEX} on the last line read, so they sort after that
 * line's events and before the next line's.
 *
 * Plain JavaScript only, like the hc client: the forge mate runner and the
 * Beadsmith server both use it.
 */

import { HcError, type HcClient, type HcNotification, type HcSubscription } from '../hc/client.js';
import type { MissionEvent, MissionResultStatus } from '../mission-events.js';
import { sanitizeResultSummary } from '../server/dispatch/sanitize.js';
import type { AgentHarness, HarnessLaunch, TranscriptMapper } from './claude-code.js';

/** The label every session terminal carries, valued with the CLI's session id. */
export const SESSION_LABEL = 'beadsmith-session';
/** First index of the session's own events on a transcript line. */
export const SYNTHETIC_INDEX = 9000;

/**
 * - `starting`: the CLI is launching.
 * - `idle`: ready for a message.
 * - `working`: a turn is under way.
 * - `blocked`: the CLI is waiting for a decision (a question or a prompt).
 * - `disconnected`: the channel to hc is gone; {@link AgentSession.reconnect}.
 * - `ended`: the program is gone (cancelled or finished).
 */
export type SessionState = 'starting' | 'idle' | 'working' | 'blocked' | 'disconnected' | 'ended';

export type SessionErrorCode = 'conflict' | 'blocked' | 'ended' | 'startup' | 'unavailable';

export class SessionError extends Error {
	name = 'SessionError';
	readonly code: SessionErrorCode;
	constructor(code: SessionErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}

export interface SessionTiming {
	/** Transcript poll while a turn runs (default 1 s). */
	poll_ms?: number;
	/** Time for the CLI to reach its first prompt (default 2 min). */
	startup_ms?: number;
	/** After hc says the turn ended, wait this long for the transcript's end record (default 10 s). */
	settle_ms?: number;
	/** A turn longer than this is stopped and failed (default 4 h). */
	turn_ms?: number;
}

export interface AgentSessionOptions {
	harness: AgentHarness;
	/** The launch, minus `resume`, which the session decides. */
	launch: Omit<HarnessLaunch, 'resume'>;
	/** Labels naming the chat or mission (ADR-0021 rule 2); the session adds {@link SESSION_LABEL}. */
	labels?: Record<string, string>;
	/** Environment for the CLI. Nothing secret: the sandbox supplies credentials. */
	env?: Record<string, string>;
	/** A secret to scrub from every event (the project's Dolt password on Sand missions). */
	redact?: string;
	/** Resume the event stream after this id (Last-Event-ID). */
	after?: string;
	onEvent(event: MissionEvent): void;
	onState?(state: SessionState): void;
	timing?: SessionTiming;
}

/** Parse a session event id; undefined for anything else. */
export function parseSessionEventId(
	value: string | undefined
): { line: number; index: number } | undefined {
	const match = value === undefined ? null : /^(0|[1-9][0-9]{0,8})\.([0-9]{1,4})$/.exec(value);
	if (match === null) return undefined;
	return { line: Number(match[1]), index: Number(match[2]) };
}

const TURN_END = new Set(['done', 'idle', 'error']);
const READ_LIMIT = 1000;

/**
 * Where a turn starts, enough for {@link AgentSession.attach} to restore it
 * on another connection or in another process: hc's turn counter when the
 * message went in, and the transcript line the turn's events start on.
 */
export interface TurnMark {
	base: number;
	first_line: number;
}

interface PendingTurn {
	/** hc's turn counter when the message was sent. */
	base: number;
	interrupted: boolean;
	closing: boolean;
	timer?: ReturnType<typeof setTimeout>;
}

interface Startup {
	resolve(): void;
	reject(error: SessionError): void;
	timer: ReturnType<typeof setTimeout>;
}

function unref(timer: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
	(timer as { unref?: () => void }).unref?.();
	return timer;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => unref(setTimeout(resolve, ms)));
}

export class AgentSession {
	readonly #options: AgentSessionOptions;
	readonly #labels: Record<string, string>;
	readonly #transcript: string;
	readonly #redact: string;
	readonly #poll_ms: number;
	readonly #startup_ms: number;
	readonly #settle_ms: number;
	readonly #turn_ms: number;
	readonly #after: { line: number; index: number } | undefined;

	#mapper: TranscriptMapper;
	#client: HcClient | undefined;
	#subscription: HcSubscription | undefined;
	#terminal: string | undefined;
	#state: SessionState = 'starting';
	#status: string | null = null;
	#turn = 0;
	#finished = false;
	#cancelled = false;
	#pending: PendingTurn | undefined;
	#startup: Startup | undefined;
	#poll: ReturnType<typeof setTimeout> | undefined;

	/** Next transcript line to read (from 1). */
	#next_line = 1;
	#last_line = 0;
	#next_synthetic = SYNTHETIC_INDEX;
	#drain_chain: Promise<void> = Promise.resolve();
	/** A turn being closed or the session being ended, for {@link settled}. */
	#closing: Promise<void> = Promise.resolve();

	constructor(options: AgentSessionOptions) {
		this.#options = options;
		this.#labels = { ...options.labels, [SESSION_LABEL]: options.launch.session_id };
		this.#transcript = options.harness.transcriptPath(options.launch);
		this.#redact = options.redact ?? '';
		this.#mapper = options.harness.mapper(this.#redact);
		this.#poll_ms = options.timing?.poll_ms ?? 1_000;
		this.#startup_ms = options.timing?.startup_ms ?? 120_000;
		this.#settle_ms = options.timing?.settle_ms ?? 10_000;
		this.#turn_ms = options.timing?.turn_ms ?? 4 * 60 * 60_000;
		this.#after = parseSessionEventId(options.after);
		if (this.#after !== undefined) {
			// Re-read the line the client stopped in; map() ids filter what it has.
			this.#next_line = Math.max(1, this.#after.line);
			this.#last_line = this.#after.line;
			if (this.#after.index >= SYNTHETIC_INDEX) this.#next_synthetic = this.#after.index + 1;
		}
	}

	get state(): SessionState {
		return this.#state;
	}

	/** The hc terminal's address, once launched. */
	get terminal(): string | undefined {
		return this.#terminal;
	}

	/** A turn is under way: a message was sent and its result has not been emitted. */
	get busy(): boolean {
		return this.#pending !== undefined;
	}

	/**
	 * Launch the CLI in a new terminal and wait for its prompt. `resume`
	 * continues an existing CLI session. With `prompt`, send it as the first
	 * message once the CLI is ready.
	 */
	async start(
		client: HcClient,
		options: { resume?: boolean; prompt?: string } = {}
	): Promise<void> {
		if (this.#client !== undefined) throw new SessionError('conflict', 'session already started');
		await this.#bind(client);
		await this.#launch(options.resume === true);
		if (options.prompt !== undefined) await this.send(options.prompt);
	}

	/**
	 * Send a message to the running CLI. Refused while a turn is under way
	 * (`conflict`), while the CLI waits for a decision (`blocked`) and once the
	 * session has ended. Returns the turn's {@link TurnMark}.
	 */
	async send(text: string): Promise<TurnMark> {
		const client = this.#ready();
		if (this.#pending !== undefined || this.#state === 'starting') {
			throw new SessionError('conflict', 'the agent is working on a turn');
		}
		if (this.#state === 'blocked') {
			throw new SessionError('blocked', 'the agent is waiting for a decision');
		}
		// Anything left from the previous turn belongs to it, not to this one.
		await this.#drain();
		this.#mapper.beginTurn();
		const first_line = this.#next_line;
		const pending: PendingTurn = { base: this.#turn, interrupted: false, closing: false };
		this.#pending = pending;
		try {
			const sent = await client.send(this.#terminal!, text);
			pending.base = sent.turn;
		} catch (error) {
			this.#pending = undefined;
			if (error instanceof HcError && error.kind === 'blocked') {
				this.#setState('blocked');
				throw new SessionError('blocked', 'the agent is waiting for a decision');
			}
			throw this.#unavailable(error);
		}
		const mark = { base: pending.base, first_line };
		// A fast turn can end before the reply to `send` arrives.
		if (this.#pending !== pending || pending.closing) return mark;
		pending.timer = unref(setTimeout(() => void this.#turnTimedOut(pending), this.#turn_ms));
		this.#setState(this.#workingState());
		this.#schedulePoll();
		this.#evaluate();
		return mark;
	}

	/** Press the CLI's stop key. The turn ends as `cancelled`; the CLI keeps running. */
	async interrupt(): Promise<void> {
		const pending = this.#pending;
		if (pending === undefined || pending.closing) return;
		const client = this.#ready();
		pending.interrupted = true;
		try {
			await client.interrupt(this.#terminal!);
		} catch (error) {
			throw this.#unavailable(error);
		}
		this.#evaluate();
	}

	/** End the CLI (`terminal.kill`). A turn under way ends as `cancelled`. */
	async cancel(): Promise<void> {
		if (this.#state === 'ended') return;
		this.#cancelled = true;
		const client = this.#client;
		if (client !== undefined && this.#terminal !== undefined && !this.#finished) {
			try {
				await client.kill(this.#terminal);
			} catch (error) {
				if (!(
					error instanceof HcError &&
					(error.kind === 'finished' || error.kind === 'not_found')
				))
					throw this.#unavailable(error);
			}
		}
		await this.#end('cancelled');
	}

	/**
	 * Pick the session up on a new connection after the old one was lost.
	 * The terminal is re-attached if it still runs; otherwise a turn under
	 * way fails and a new terminal resumes the CLI session, ready for the
	 * next message.
	 */
	async reconnect(client: HcClient): Promise<void> {
		if (this.#state === 'ended') throw new SessionError('ended', 'the session has ended');
		this.#detach();
		await this.#bind(client);
		await this.#follow(client, true);
	}

	/**
	 * Take up a session this object did not start: Beadsmith restarted, or
	 * dropped the session between turns. Follows the live terminal that
	 * carries this session's label, or launches the CLI again when none runs
	 * (resuming it when its transcript exists, so a session that never got a
	 * message starts fresh).
	 *
	 * `turn` restores a turn that was under way (the mark {@link send}
	 * returned). Without it, reading starts at the transcript's current end,
	 * so earlier turns are not replayed as if they were new.
	 *
	 * `relaunch: false` is for a caller that only wants to know how a turn
	 * went: with no live terminal it fails the turn and ends the session
	 * instead of starting the CLI again.
	 */
	async attach(
		client: HcClient,
		options: { turn?: TurnMark; relaunch?: boolean } = {}
	): Promise<void> {
		if (this.#client !== undefined || this.#terminal !== undefined || this.#state === 'ended') {
			throw new SessionError('conflict', 'session already started');
		}
		await this.#bind(client);
		let lines: number | undefined;
		try {
			lines = (await client.readFile(this.#transcript, { offset: 1, limit: 1 })).lines;
		} catch (error) {
			if (!(error instanceof HcError && error.kind === 'not_found')) {
				this.#detach();
				this.#client = undefined;
				throw this.#unavailable(error);
			}
		}
		const turn = options.turn;
		if (turn !== undefined) {
			this.#seek(turn.first_line);
			const pending: PendingTurn = { base: turn.base, interrupted: false, closing: false };
			pending.timer = unref(setTimeout(() => void this.#turnTimedOut(pending), this.#turn_ms));
			this.#pending = pending;
		} else {
			this.#seek((lines ?? 0) + 1);
		}
		await this.#follow(client, lines !== undefined, options.relaunch ?? true);
	}

	/**
	 * Resolves once nothing is in flight: the transcript read so far, and any
	 * turn being closed (which can wait up to the settle time for the
	 * transcript's end record). A caller taking a snapshot awaits it after
	 * {@link attach} to see whether the turn has ended.
	 */
	async settled(): Promise<void> {
		for (;;) {
			const closing = this.#closing;
			await Promise.all([closing, this.#drain_chain]);
			if (closing === this.#closing) return;
		}
	}

	/**
	 * Stop following the terminal without ending it. The client stays open,
	 * and a turn under way is left to run: this object reports nothing more.
	 */
	close(): void {
		this.#detach();
		this.#client = undefined;
		clearTimeout(this.#pending?.timer);
	}

	/** Read the transcript from `line` on, as the start of a turn. */
	#seek(line: number): void {
		this.#next_line = Math.max(1, line);
		this.#last_line = this.#next_line - 1;
		this.#next_synthetic = SYNTHETIC_INDEX;
		this.#mapper.beginTurn();
	}

	/**
	 * Follow this session's live terminal on a bound client, or launch the
	 * CLI in a new one (`resume`: continue its session). A turn under way
	 * whose terminal is gone fails first; without `relaunch` the session
	 * then ends.
	 */
	async #follow(client: HcClient, resume: boolean, relaunch = true): Promise<void> {
		const live = (await this.#call(() => client.list({ labels: this.#labels }))).find(
			(t) => t.state === 'live' && (this.#terminal === undefined || t.address === this.#terminal)
		);
		if (live !== undefined) {
			this.#terminal = live.address;
			this.#finished = false;
			this.#status = live.status?.state ?? null;
			this.#turn = live.turn ?? this.#turn;
			this.#setState(this.#pending === undefined ? this.#idleState() : this.#workingState());
			if (this.#pending !== undefined) this.#schedulePoll();
			this.#evaluate();
			return;
		}
		if (this.#pending !== undefined) {
			await this.#drain();
			await this.#failTurn('The agent terminal was lost in the middle of a turn.');
		}
		if (!relaunch) {
			this.#finished = true;
			await this.#end('failed');
			return;
		}
		this.#finished = false;
		await this.#launch(resume);
	}

	// ── connection ──────────────────────────────────────────────────────

	async #bind(client: HcClient): Promise<void> {
		this.#client = client;
		client.onClose(() => {
			if (this.#client !== client) return;
			this.#detach();
			this.#client = undefined;
			if (this.#state !== 'ended') this.#setState('disconnected');
		});
		this.#subscription = await this.#call(() =>
			client.subscribe({ labels: this.#labels }, (notification) =>
				this.#onNotification(notification)
			)
		);
	}

	#detach(): void {
		this.#subscription?.close();
		this.#subscription = undefined;
		this.#stopPoll();
		if (this.#startup !== undefined) {
			const startup = this.#startup;
			this.#startup = undefined;
			clearTimeout(startup.timer);
			startup.reject(new SessionError('unavailable', 'the connection to the agent was lost'));
		}
	}

	async #launch(resume: boolean): Promise<void> {
		const client = this.#client!;
		this.#setState('starting');
		const ready = new Promise<void>((resolve, reject) => {
			this.#startup = {
				resolve,
				reject,
				timer: unref(
					setTimeout(
						() => this.#failStartup('The agent did not reach its prompt in time.'),
						this.#startup_ms
					)
				)
			};
		});
		// A rejection before anyone awaits it must not surface as unhandled.
		ready.catch(() => {});
		try {
			const launch = { ...this.#options.launch, resume };
			const record = await client.run({
				argv: this.#options.harness.argv(launch),
				cwd: launch.cwd,
				env: this.#options.env,
				labels: this.#labels
			});
			this.#terminal = record.address;
			this.#finished = record.state !== 'live';
			this.#turn = record.turn ?? 0;
			if (record.status) this.#status = record.status.state;
		} catch (error) {
			const startup = this.#startup;
			this.#startup = undefined;
			if (startup !== undefined) clearTimeout(startup.timer);
			throw error instanceof Error && !(error instanceof HcError)
				? new SessionError('startup', error.message)
				: this.#unavailable(error);
		}
		this.#evaluate();
		await ready;
	}

	#failStartup(message: string): void {
		const startup = this.#startup;
		if (startup === undefined) return;
		this.#startup = undefined;
		clearTimeout(startup.timer);
		const terminal = this.#terminal;
		const client = this.#client;
		this.#detach();
		this.#setState('ended');
		if (client !== undefined && terminal !== undefined && !this.#finished) {
			client.kill(terminal).catch(() => {});
		}
		startup.reject(new SessionError('startup', message));
	}

	// ── facts ───────────────────────────────────────────────────────────

	#onNotification(notification: HcNotification): void {
		if (notification.method === 'missed') {
			const record = notification.terminals.find((t) => t.address === this.#terminal);
			if (record !== undefined) {
				this.#status = record.status?.state ?? null;
				this.#turn = record.turn ?? this.#turn;
				if (record.state !== 'live') this.#onFinished();
			}
		} else if (notification.method === 'event') {
			if (this.#terminal !== undefined && notification.terminal !== this.#terminal) return;
			const data = notification.data ?? {};
			if (notification.type === 'status') {
				const status = data.status as { state?: unknown } | null | undefined;
				this.#status = typeof status?.state === 'string' ? status.state : null;
			} else if (notification.type === 'turn') {
				if (typeof data.turn === 'number') this.#turn = Math.max(this.#turn, data.turn);
			} else if (notification.type === 'finished') {
				this.#onFinished();
				return;
			}
		} else {
			return;
		}
		this.#evaluate();
	}

	#evaluate(): void {
		if (this.#terminal === undefined || this.#state === 'ended') return;
		if (this.#startup !== undefined) {
			if (this.#status === 'blocked') {
				this.#failStartup(
					'The agent stopped at a prompt before its first turn. The sandbox image must pre-accept the CLI first-run dialogs.'
				);
			} else if (this.#status === 'idle' || this.#status === 'done') {
				const startup = this.#startup;
				this.#startup = undefined;
				clearTimeout(startup.timer);
				this.#setState('idle');
				startup.resolve();
			}
			return;
		}
		const pending = this.#pending;
		if (pending === undefined) {
			if (this.#state !== 'disconnected') this.#setState(this.#idleState());
			return;
		}
		if (pending.closing) return;
		const turn_over =
			this.#status !== null &&
			TURN_END.has(this.#status) &&
			// An interrupted CLI may stop without counting a turn.
			(this.#turn > pending.base || pending.interrupted);
		if (turn_over) {
			this.#closing = this.#completeTurn(pending, this.#status === 'error');
			return;
		}
		this.#setState(this.#workingState());
		void this.#drain();
	}

	#onFinished(): void {
		if (this.#finished) return;
		this.#finished = true;
		if (this.#startup !== undefined) {
			this.#failStartup('The agent exited before reaching its prompt.');
			return;
		}
		if (this.#cancelled) return;
		this.#closing = this.#end('failed');
	}

	// ── turns ───────────────────────────────────────────────────────────

	async #completeTurn(pending: PendingTurn, errored: boolean): Promise<void> {
		pending.closing = true;
		clearTimeout(pending.timer);
		await this.#drain();
		const deadline = Date.now() + this.#settle_ms;
		while (!this.#mapper.turn.ended && Date.now() < deadline && this.#client !== undefined) {
			await delay(Math.min(this.#poll_ms, Math.max(1, deadline - Date.now())));
			await this.#drain();
		}
		if (this.#pending !== pending) return;
		if (this.#client === undefined) {
			// Lost the channel while settling: reconnect decides how the turn ends.
			pending.closing = false;
			return;
		}
		const facts = this.#mapper.turn;
		let status: MissionResultStatus = 'succeeded';
		if (pending.interrupted) status = 'cancelled';
		else if (errored || facts.api_error) status = 'failed';
		this.#emitResult(status);
		this.#pending = undefined;
		this.#stopPoll();
		if (this.#state !== 'disconnected') this.#setState(this.#idleState());
	}

	async #failTurn(message: string): Promise<void> {
		if (this.#pending === undefined) return;
		clearTimeout(this.#pending.timer);
		this.#emitSynthetic({ type: 'error', message });
		this.#emitResult('failed');
		this.#pending = undefined;
		this.#stopPoll();
	}

	async #turnTimedOut(pending: PendingTurn): Promise<void> {
		if (this.#pending !== pending || pending.closing) return;
		pending.closing = true;
		this.#cancelled = true;
		const client = this.#client;
		if (client !== undefined && this.#terminal !== undefined && !this.#finished) {
			await client.kill(this.#terminal).catch(() => {});
		}
		await this.#drain();
		await this.#failTurn('The agent turn took too long and was stopped.');
		await this.#end('failed');
	}

	/** The program is gone: read what it left, close any turn, stop following. */
	async #end(status: MissionResultStatus): Promise<void> {
		if (this.#state === 'ended') return;
		await this.#drain();
		if (this.#pending !== undefined) {
			if (status === 'cancelled') {
				clearTimeout(this.#pending.timer);
				this.#emitResult('cancelled');
				this.#pending = undefined;
			} else {
				await this.#failTurn('The agent exited in the middle of a turn.');
			}
		}
		this.#detach();
		this.#setState('ended');
	}

	#emitResult(status: MissionResultStatus): void {
		const facts = this.#mapper.turn;
		const text = sanitizeResultSummary(facts.last_text, this.#redact);
		this.#emitSynthetic({
			type: 'result',
			status,
			...(text === undefined ? {} : { text }),
			...(facts.duration_ms === undefined ? {} : { duration_ms: facts.duration_ms })
		});
		this.#mapper.beginTurn();
	}

	#emitSynthetic(
		event:
			| { type: 'error'; message: string }
			| { type: 'result'; status: MissionResultStatus; text?: string; duration_ms?: number }
	): void {
		const id = `${this.#last_line}.${this.#next_synthetic++}`;
		this.#options.onEvent({ ...event, id } as MissionEvent);
	}

	// ── transcript ──────────────────────────────────────────────────────

	/** Read the transcript to its end; calls run one after another. */
	#drain(): Promise<void> {
		this.#drain_chain = this.#drain_chain.then(() => this.#readTranscript());
		return this.#drain_chain;
	}

	async #readTranscript(): Promise<void> {
		for (;;) {
			const client = this.#client;
			if (client === undefined) return;
			let chunk;
			try {
				chunk = await client.readFile(this.#transcript, {
					offset: this.#next_line,
					limit: READ_LIMIT
				});
			} catch {
				// Not written yet, or the channel is going away: the next poll retries.
				return;
			}
			if (chunk.last < this.#next_line) return;
			const lines = chunk.text.split('\n');
			if (lines.at(-1) === '') lines.pop();
			for (let i = 0; i < lines.length; i++) {
				const line_number = chunk.first + i;
				const line = lines[i];
				const is_file_end = line_number >= chunk.lines;
				if (is_file_end && !chunk.text.endsWith('\n') && !parses(line)) {
					// The CLI is still writing this line; read it again next time.
					return;
				}
				this.#emitLine(line, line_number);
				this.#next_line = line_number + 1;
			}
			if (chunk.last >= chunk.lines) return;
		}
	}

	#emitLine(line: string, line_number: number): void {
		const events = this.#mapper.map(line, line_number);
		if (line_number > this.#last_line) {
			this.#last_line = line_number;
			this.#next_synthetic = SYNTHETIC_INDEX;
		}
		const after = this.#after;
		for (const event of events) {
			if (after !== undefined) {
				const id = parseSessionEventId(event.id);
				if (
					id !== undefined &&
					(id.line < after.line || (id.line === after.line && id.index <= after.index))
				) {
					continue;
				}
			}
			this.#options.onEvent(event);
		}
	}

	#schedulePoll(): void {
		if (this.#poll !== undefined) return;
		const tick = () => {
			this.#poll = undefined;
			if (this.#pending === undefined || this.#client === undefined) return;
			void this.#drain().then(() => this.#schedulePoll());
		};
		this.#poll = unref(setTimeout(tick, this.#poll_ms));
	}

	#stopPoll(): void {
		clearTimeout(this.#poll);
		this.#poll = undefined;
	}

	// ── helpers ─────────────────────────────────────────────────────────

	#ready(): HcClient {
		if (this.#state === 'ended') throw new SessionError('ended', 'the session has ended');
		if (this.#client === undefined || this.#terminal === undefined) {
			throw new SessionError('unavailable', 'the agent is not connected');
		}
		return this.#client;
	}

	#idleState(): SessionState {
		return this.#status === 'blocked' ? 'blocked' : 'idle';
	}

	#workingState(): SessionState {
		return this.#status === 'blocked' ? 'blocked' : 'working';
	}

	#setState(state: SessionState): void {
		if (this.#state === state || this.#state === 'ended') return;
		this.#state = state;
		this.#options.onState?.(state);
	}

	async #call<T>(fn: () => Promise<T>): Promise<T> {
		try {
			return await fn();
		} catch (error) {
			throw this.#unavailable(error);
		}
	}

	#unavailable(error: unknown): SessionError {
		if (error instanceof SessionError) return error;
		const kind = error instanceof HcError ? ` (${error.kind})` : '';
		return new SessionError('unavailable', `the agent terminal is unavailable${kind}`);
	}
}

function parses(line: string): boolean {
	try {
		JSON.parse(line);
		return true;
	} catch {
		return false;
	}
}
