/**
 * One First Mate chat's Claude Code process.
 *
 * The process is long-lived: it reads user messages from stdin and writes
 * events to stdout whenever it has something to say, including after a turn
 * the user did not just start (the first mate reporting back). If it exits,
 * the next message starts a new one that resumes the same Claude Code
 * session, so the conversation survives runner restarts and crashes.
 */

import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { ClaudeStreamMapper, interruptLine, userInputLine } from './claude-stream.js';
import type { ChatLog } from './event-log.js';

/** The parts of a child process the session uses (a fake in tests). */
export interface AgentProcess {
	stdin: Writable;
	stdout: Readable;
	stderr: Readable;
	kill(signal?: NodeJS.Signals): boolean;
	once(event: 'exit', listener: (code: number | null) => void): unknown;
}

export interface AgentLaunch {
	session_id: string;
	/** Resume an existing Claude Code session instead of creating it. */
	resume: boolean;
	scope: string | null;
}

export type SpawnAgent = (launch: AgentLaunch) => AgentProcess;

const STOP_GRACE_MS = 5_000;

export class AgentSession {
	readonly #log: ChatLog;
	readonly #spawn: SpawnAgent;
	#process: AgentProcess | undefined;
	#mapper = new ClaudeStreamMapper();
	#busy = false;
	#stopping = false;
	/** When the process last did anything, for evicting idle sessions. */
	last_active = Date.now();

	constructor(log: ChatLog, spawn: SpawnAgent) {
		this.#log = log;
		this.#spawn = spawn;
	}

	get running(): boolean {
		return this.#process !== undefined;
	}

	/** A turn is under way: a message was sent and its `result` has not arrived. */
	get busy(): boolean {
		return this.#busy;
	}

	/** Send one user message, starting (or resuming) the process if needed. */
	send(prompt: string): void {
		const meta = this.#log.meta;
		if (meta === undefined) throw new Error('chat has no session');
		const process = this.#process ?? this.#start();
		this.#busy = true;
		this.last_active = Date.now();
		process.stdin.write(userInputLine(prompt, meta.session_id));
	}

	/** Interrupt the running turn; the process and session survive. */
	interrupt(): void {
		if (this.#process === undefined || !this.#busy) return;
		this.#mapper.markInterrupted();
		this.#process.stdin.write(interruptLine(randomUUID()));
	}

	/** End the process: close stdin, then kill it if it lingers. */
	stop(): void {
		const process = this.#process;
		if (process === undefined) return;
		this.#stopping = true;
		process.stdin.end();
		const timer = setTimeout(() => process.kill('SIGTERM'), STOP_GRACE_MS);
		timer.unref();
		process.once('exit', () => clearTimeout(timer));
	}

	#start(): AgentProcess {
		const meta = this.#log.meta;
		if (meta === undefined) throw new Error('chat has no session');
		const process = this.#spawn({
			session_id: meta.session_id,
			resume: meta.started,
			scope: meta.scope
		});
		this.#process = process;
		this.#mapper = new ClaudeStreamMapper();
		this.#stopping = false;

		// A write after the process died must not crash the runner; the exit
		// handler reports it.
		process.stdin.on('error', () => undefined);
		const lines = createInterface({ input: process.stdout, crlfDelay: Infinity });
		lines.on('line', (line) => this.#onLine(line));
		// Keep stderr drained so the process never blocks on a full pipe; it
		// is not forwarded anywhere, because it can carry anything.
		process.stderr.resume();
		process.once('exit', (code) => this.#onExit(process, code));
		return process;
	}

	#onLine(line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return;
		}
		this.last_active = Date.now();
		const meta = this.#log.meta;
		if (
			meta !== undefined &&
			!meta.started &&
			typeof parsed === 'object' &&
			parsed !== null &&
			(parsed as { type?: unknown }).type === 'system'
		) {
			this.#log.setMeta({ ...meta, started: true });
		}
		for (const draft of this.#mapper.map(parsed)) {
			if (draft.type === 'result') this.#busy = false;
			this.#log.append(draft);
		}
	}

	#onExit(process: AgentProcess, code: number | null): void {
		if (this.#process !== process) return;
		this.#process = undefined;
		if (this.#busy && !this.#stopping) {
			this.#log.append({
				type: 'error',
				message:
					code === 0
						? 'The agent ended its session in the middle of a turn.'
						: 'The agent stopped unexpectedly. Send a message to resume the conversation.'
			});
		}
		this.#busy = false;
	}
}
