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
import { scopePrompt } from './spawn.js';
import type { ChatLog } from './event-log.js';

/** The parts of a child process the session uses (a fake in tests). */
export interface AgentProcess {
	stdin: Writable;
	stdout: Readable;
	stderr: Readable;
	kill(signal?: NodeJS.Signals): boolean;
	once(event: 'exit', listener: (code: number | null) => void): unknown;
	once(event: 'error', listener: (error: Error) => void): unknown;
}

export interface AgentLaunch {
	session_id: string;
	/** Resume an existing Claude Code session instead of creating it. */
	resume: boolean;
	scope: string | null;
	/**
	 * An MCP config file in the agent's environment (`--mcp-config`). The Sand
	 * runner sets it for crew tools (ADR-0020); other spawners leave it unset.
	 */
	mcp_config?: string;
}

export type SpawnAgent = (launch: AgentLaunch) => AgentProcess;

const STOP_GRACE_MS = 5_000;

export class AgentSession {
	readonly #log: ChatLog;
	readonly #spawn: SpawnAgent;
	#process: AgentProcess | undefined;
	#mapper = new ClaudeStreamMapper();
	#pending = 0;
	#stopping = false;
	#stopPromise: Promise<void> | undefined;
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
		return this.#pending > 0;
	}

	/** Send one user message, starting (or resuming) the process if needed. */
	prepare(): void {
		if (this.#stopping) throw new Error('session is stopping');
		if (this.#process === undefined) this.#start();
	}

	send(prompt: string, scope?: string | null): void {
		const meta = this.#log.meta;
		if (meta === undefined) throw new Error('chat has no session');
		this.prepare();
		const process = this.#process!;
		this.#pending += 1;
		this.#log.setMeta({ ...meta, pending: this.#pending });
		this.last_active = Date.now();
		const context =
			scope === undefined
				? ''
				: `${scope === null ? 'This chat now covers every available Beads project.' : scopePrompt(scope)}

`;
		process.stdin.write(userInputLine(context + prompt, meta.session_id));
	}

	/** Interrupt the running turn; the process and session survive. */
	interrupt(): void {
		if (this.#process === undefined || !this.busy) return;
		this.#mapper.markInterrupted();
		this.#process.stdin.write(interruptLine(randomUUID()));
	}

	/** End the process: close stdin, then kill it if it lingers. */
	stop(): Promise<void> {
		if (this.#stopPromise !== undefined) return this.#stopPromise;
		const process = this.#process;
		if (process === undefined) return Promise.resolve();
		this.#stopping = true;
		this.#stopPromise = new Promise<void>((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const done = () => {
				clearTimeout(timer);
				resolve();
			};
			process.once('exit', done);
			process.once('error', done);
			timer = setTimeout(() => {
				process.kill('SIGTERM');
				if (this.#process === process) {
					timer = setTimeout(() => process.kill('SIGKILL'), STOP_GRACE_MS);
					timer.unref();
				}
			}, STOP_GRACE_MS);
			timer.unref();
			process.stdin.end();
		});
		return this.#stopPromise;
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
		this.#stopPromise = undefined;

		// A write after the process died must not crash the runner; the exit
		// handler reports it.
		process.stdin.on('error', () => {
			// Keep the slot occupied until exit confirms the child is gone.
			void this.stop();
		});
		process.once('error', () => this.#onExit(process, 1));
		const lines = createInterface({ input: process.stdout, crlfDelay: Infinity });
		lines.on('line', (line) => {
			if (this.#process === process && !this.#stopping) this.#onLine(line);
		});
		process.once('exit', () => lines.close());
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
			(parsed as { type?: unknown }).type === 'system' &&
			(parsed as { subtype?: unknown }).subtype === 'init'
		) {
			this.#log.setMeta({ ...meta, started: true });
		}
		for (const draft of this.#mapper.map(parsed)) {
			if (draft.type === 'result') this.#pending = Math.max(0, this.#pending - 1);
			else this.#pending = Math.max(1, this.#pending);
			this.#log.append(draft);
			if (this.#log.meta !== undefined)
				this.#log.setMeta({ ...this.#log.meta, pending: this.#pending });
		}
	}

	#onExit(process: AgentProcess, code: number | null): void {
		if (this.#process !== process) return;
		this.#process = undefined;
		if (this.busy) {
			this.#log.append({
				type: 'error',
				message:
					code === 0
						? 'The agent ended its session in the middle of a turn.'
						: 'The agent stopped unexpectedly. Send a message to resume the conversation.'
			});
		}
		this.#pending = 0;
		if (this.#log.meta !== undefined) this.#log.setMeta({ ...this.#log.meta, pending: 0 });
		this.#stopping = false;
	}
}
