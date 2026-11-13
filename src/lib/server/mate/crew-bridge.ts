/**
 * The Sand chat bridge for crew tools (ADR-0020 rule 2).
 *
 * A chat's Claude Code cannot reach Beadsmith over the network, and must not
 * hold anything that could. Instead, when the runner starts or resumes a
 * chat's sandbox, it writes a small relay script and an MCP config into the
 * sandbox and starts the relay over the E2B commands API, the same
 * authenticated channel that carries Claude Code's own stdin and stdout:
 *
 *     Claude Code ─stdio─▶ relay "stdio" ─unix socket─▶ relay "serve"
 *         ─stdout frame─▶ Beadsmith (crew MCP handler, as the chat owner)
 *         ─stdin frame──▶ relay "serve" ─▶ socket ─▶ Claude Code
 *
 * Frames are one JSON object per line, `{"conn": <n>, "line": "<JSON-RPC>"}`,
 * where `conn` numbers the stdio-side connection inside the sandbox. The
 * bridge carries no authority: Beadsmith decides who is calling from the
 * sandbox it started for that session, never from anything in a frame.
 * Everything from the sandbox is untrusted, so frames are bounded and
 * validated, and a bad one is dropped and logged.
 *
 * Nothing here needs a template rebuild: the relay, its config and First
 * Mate's standing instructions are written on every create and resume.
 */
import { z } from 'zod';
import { shellQuote } from '#lib/mate-runner/spawn.js';
import type { CrewMcpHandler } from '../crew/mcp.js';
import type { CrewContext } from '../crew/registry.js';
import { MATE_WORKDIR } from '../e2b/image.js';
import type { InteractiveCommand, SandboxRef } from '../e2b/sandbox.js';

/** Bridge files, beside the chat's working tree. */
export const CREW_DIR = `${MATE_WORKDIR}/.crew`;
export const CREW_RELAY_PATH = `${CREW_DIR}/relay.cjs`;
export const CREW_SOCKET_PATH = `${CREW_DIR}/crew.sock`;
export const CREW_MCP_CONFIG_PATH = `${CREW_DIR}/mcp.json`;
/** MCP server name; Claude Code exposes its tools as `mcp__crew__<tool>`. */
export const CREW_MCP_SERVER = 'crew';

/**
 * Longest frame either side accepts. A JSON-RPC request from Claude Code is
 * small; replies are bounded by `RESULT_MAX_CHARS` (24,000) well inside this.
 * Anything longer is a broken or hostile relay, not a real call.
 */
export const FRAME_MAX_CHARS = 256 * 1024;
/** Relay restarts per chat process before the bridge gives up. */
export const RELAY_MAX_RESTARTS = 5;
const RELAY_RESTART_DELAY_MS = 1_000;
/**
 * Bounds on one chat's crew requests. Everything from the sandbox is
 * untrusted, so a prompt-injected or compromised agent may write requests
 * straight to its relay; these keep one chat from flooding shared SQLite,
 * Dolt and host memory. They apply to every request (reads and todo writes
 * too), on top of each tool's own limits such as the mission-launch limiter.
 * A request past a bound gets a short JSON-RPC error, never a queue slot.
 */
export interface CrewBridgeLimits {
	/** Requests being handled at once. */
	max_active: number;
	/** Admitted requests waiting for a handler. */
	max_queued: number;
	/** Requests admitted in a burst (token bucket size). */
	burst: number;
	/** Requests admitted per second after a burst (refill rate). */
	per_second: number;
	/** Reply bytes waiting on a slow or stalled relay; replies past this are dropped. */
	max_outbox_chars: number;
}

export const CREW_BRIDGE_LIMITS: CrewBridgeLimits = {
	max_active: 4,
	max_queued: 32,
	burst: 60,
	per_second: 10,
	max_outbox_chars: 1024 * 1024
};

/** The refusal a request past a bound gets. */
export const CREW_BUSY_MESSAGE = 'Crew tools are busy in this chat. Try again in a moment.';

/** Stderr kept for the server log when a process exits badly (inside the 4,000-character log line). */
export const STDERR_TAIL_CHARS = 2_000;

/**
 * The relay, dependency-free CommonJS for the template's Node. `serve` owns
 * the unix socket and speaks frames on stdout and stdin; `stdio` is what
 * Claude Code launches as the MCP server, and reconnects if the serve side
 * restarts, so a relay restart does not cost the chat its tools.
 */
export const RELAY_SOURCE = `'use strict';
// Beadsmith crew tools relay (written by Beadsmith; see ADR-0020).
const net = require('node:net');
const fs = require('node:fs');
const MAX = ${FRAME_MAX_CHARS};
const [mode, socketPath] = process.argv.slice(2);

function lines(stream, onLine) {
	let buffer = '';
	let skipping = false;
	stream.setEncoding('utf8');
	stream.on('data', (chunk) => {
		buffer += chunk;
		let at;
		while ((at = buffer.indexOf('\\n')) !== -1) {
			const line = buffer.slice(0, at);
			buffer = buffer.slice(at + 1);
			if (skipping) {
				skipping = false;
			} else if (line.length > MAX) {
				process.stderr.write('crew relay: dropped an oversized line\\n');
			} else if (line.trim().length > 0) {
				onLine(line);
			}
		}
		if (buffer.length > MAX) {
			buffer = '';
			skipping = true;
			process.stderr.write('crew relay: dropped an oversized line\\n');
		}
	});
}

if (mode === 'serve') {
	try {
		fs.unlinkSync(socketPath);
	} catch {}
	const conns = new Map();
	let next = 1;
	const server = net.createServer((socket) => {
		const conn = next++;
		conns.set(conn, socket);
		const drop = () => conns.delete(conn);
		socket.on('close', drop);
		socket.on('error', drop);
		lines(socket, (line) => process.stdout.write(JSON.stringify({ conn, line }) + '\\n'));
	});
	server.listen(socketPath, () => fs.chmodSync(socketPath, 0o600));
	lines(process.stdin, (text) => {
		let frame;
		try {
			frame = JSON.parse(text);
		} catch {
			return;
		}
		const socket = frame && conns.get(frame.conn);
		if (socket && typeof frame.line === 'string') socket.write(frame.line + '\\n');
	});
	process.stdin.on('end', () => process.exit(0));
} else if (mode === 'stdio') {
	let socket;
	let pending = [];
	let failures = 0;
	const connect = () => {
		const s = net.createConnection(socketPath);
		s.on('connect', () => {
			socket = s;
			failures = 0;
			for (const chunk of pending) s.write(chunk);
			pending = [];
		});
		s.on('data', (chunk) => process.stdout.write(chunk));
		s.on('error', () => undefined);
		s.on('close', () => {
			if (socket === s) socket = undefined;
			if (++failures > 150) process.exit(1);
			setTimeout(connect, 200);
		});
	};
	process.stdin.on('data', (chunk) => {
		if (socket) socket.write(chunk);
		else if (pending.length < 64) pending.push(chunk);
	});
	process.stdin.on('end', () => process.exit(0));
	connect();
} else {
	process.stderr.write('usage: relay.cjs serve|stdio <socket>\\n');
	process.exit(2);
}
`;

/** The `--mcp-config` file: Claude Code starts the relay's stdio side. */
export function crewMcpConfig(): string {
	return `${JSON.stringify(
		{
			mcpServers: {
				[CREW_MCP_SERVER]: {
					type: 'stdio',
					command: 'node',
					args: [CREW_RELAY_PATH, 'stdio', CREW_SOCKET_PATH]
				}
			}
		},
		null,
		2
	)}\n`;
}

/**
 * First Mate's standing instructions on Sand, written on every create and
 * resume so they change with Beadsmith rather than with the template. They
 * supersede the template's "model access only" text, which predates crew
 * tools.
 */
export const MATE_AGENTS_MD = `# First Mate

You are First Mate, the operator's liaison for their Beads projects in
Beadsmith. The operator talks to you; you find out what is going on, capture
and route work, start worker agents for them and report back.

## What you can use

- **Crew tools** (\`mcp__${CREW_MCP_SERVER}__*\`): Beadsmith's own view of every
  project the operator can see, acting as the operator who owns this chat.
  Use them for projects, ready work, issues, missions and todos. Start with
  \`list_projects\` for project ids. Results are compact JSON; long text is
  cut and says so.
- **Todos** are the operator's own list: \`create_todo\`, \`update_todo\` and
  \`complete_todo\` change it directly; \`route_todo\` files one into a
  project as a Beads issue.
- **Missions** start agents: \`file_issue\`, \`comment_issue\`,
  \`tackle_issue\` and \`discuss_issue\` start one, \`follow_up_mission\`
  continues a finished one and \`cancel_mission\` stops one. Use
  \`show_mission\` to see how one is going. Launches per chat are rate
  limited; a retried call returns the mission it already started.
- This sandbox has no Beads database, repository, tailnet or credentials of
  its own. Do not look for any, and never try to get around a network
  boundary.

## How to work

- Answer from the crew tools, not from memory. Say when a result was cut or
  a tool failed, and what the tool said.
- Changes to Beads happen only through missions: a File, comment, Tackle or
  discuss mission runs its own agent in its own sandbox. Never claim to have
  changed an issue yourself.
- Ask the operator before launching more than one mission at a time, or
  anything costly (Tackle starts a repository worker that can open a pull
  request).
- When you launch a mission, tell the operator which operation, project,
  issue and mission it was. Report its outcome when you learn it.
- If a crew tool you need is missing or refuses, say so plainly and suggest
  what the operator can do in Beadsmith instead.
`;

/**
 * Write the bridge files and standing instructions into a chat's sandbox.
 * Runs on create and on resume: a sandbox from before an upgrade gets the
 * current relay and text.
 * @param sandbox The chat's sandbox.
 */
export async function prepareChatSandbox(sandbox: SandboxRef): Promise<void> {
	await sandbox.writeFile(`${MATE_WORKDIR}/AGENTS.md`, MATE_AGENTS_MD);
	await sandbox.writeFile(CREW_RELAY_PATH, RELAY_SOURCE);
	await sandbox.writeFile(CREW_MCP_CONFIG_PATH, crewMcpConfig());
}

/** Shell command that stops a previous relay left running in a resumed sandbox. */
export function stopRelayCommand(): string {
	return `pkill -f -- ${shellQuote(`${CREW_RELAY_PATH} serve`)} 2>/dev/null; true`;
}

const frame_schema = z.strictObject({
	conn: z
		.number()
		.int()
		.min(1)
		.max(2 ** 31),
	line: z.string().max(FRAME_MAX_CHARS)
});

export type RelayFrame = z.infer<typeof frame_schema>;

/**
 * Split relay stdout into frames. Lines longer than `FRAME_MAX_CHARS`, with
 * or without their newline yet, are skipped whole; lines that are not a
 * valid frame are reported to `on_drop`.
 */
export class FrameReader {
	#buffer = '';
	#skipping = false;
	readonly #on_frame: (frame: RelayFrame) => void;
	readonly #on_drop: (reason: string) => void;

	constructor(on_frame: (frame: RelayFrame) => void, on_drop: (reason: string) => void) {
		this.#on_frame = on_frame;
		this.#on_drop = on_drop;
	}

	push(chunk: string): void {
		this.#buffer += chunk;
		let at: number;
		while ((at = this.#buffer.indexOf('\n')) !== -1) {
			const line = this.#buffer.slice(0, at);
			this.#buffer = this.#buffer.slice(at + 1);
			if (this.#skipping) {
				this.#skipping = false;
				continue;
			}
			this.#line(line);
		}
		if (this.#buffer.length > FRAME_MAX_CHARS) {
			this.#buffer = '';
			this.#skipping = true;
			this.#on_drop('oversized frame');
		}
	}

	#line(line: string): void {
		if (line.trim().length === 0) return;
		if (line.length > FRAME_MAX_CHARS) {
			this.#on_drop('oversized frame');
			return;
		}
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			this.#on_drop('frame is not JSON');
			return;
		}
		const frame = frame_schema.safeParse(value);
		if (!frame.success) {
			this.#on_drop('malformed frame');
			return;
		}
		this.#on_frame(frame.data);
	}
}

/** Keep the last `max` characters of a stream, for a server-side log line. */
export class TextTail {
	#text = '';
	constructor(readonly max: number = STDERR_TAIL_CHARS) {}
	push(chunk: string): void {
		this.#text = (this.#text + chunk).slice(-this.max);
	}
	get text(): string {
		return this.#text.trim();
	}
}

export interface CrewBridgeDeps {
	handler: CrewMcpHandler;
	/**
	 * Who the session's tool calls act as, looked up on every frame so a
	 * deleted chat, a ban or a demotion applies at once. Undefined refuses.
	 */
	context(session_id: string): Promise<CrewContext | undefined>;
}

export interface CrewBridge {
	/** Stop the relay and stop restarting it. Idempotent. */
	stop(): void;
}

/** A short, non-identifying label for log lines. */
function sessionLabel(session_id: string): string {
	return session_id.slice(0, 8);
}

/** The JSON-RPC id of a request line, or null; used only to address a refusal. */
function requestId(line: string): string | number | null | undefined {
	try {
		const value: unknown = JSON.parse(line);
		if (value === null || typeof value !== 'object' || !('id' in value)) return undefined;
		const id = value.id;
		return typeof id === 'string' || typeof id === 'number' ? id : null;
	} catch {
		return null;
	}
}

/**
 * Start the relay's serve side in a chat's sandbox and answer its frames.
 * Call after `prepareChatSandbox`. The relay is restarted if it exits, up to
 * `RELAY_MAX_RESTARTS` times, until `stop()`.
 */
export async function startCrewBridge(options: {
	sandbox: SandboxRef;
	session_id: string;
	deps: CrewBridgeDeps;
	log: (message: string) => void;
	restart_delay_ms?: number;
	limits?: Partial<CrewBridgeLimits>;
	/** Milliseconds clock for the admission rate; tests pass a fixed one. */
	now?: () => number;
}): Promise<CrewBridge> {
	const { sandbox, session_id, deps, log } = options;
	const label = sessionLabel(session_id);
	const restart_delay_ms = options.restart_delay_ms ?? RELAY_RESTART_DELAY_MS;
	const limits: CrewBridgeLimits = { ...CREW_BRIDGE_LIMITS, ...options.limits };
	const now = options.now ?? Date.now;
	let stopped = false;
	let restarts = 0;
	let command: InteractiveCommand | undefined;

	// Replies go out in order through one writer. The outbox is bounded in
	// characters, so a relay that stops reading cannot grow it without limit.
	const outbox: { target: InteractiveCommand; frame: string }[] = [];
	let outbox_chars = 0;
	let flushing = false;
	let dropped_replies = 0;

	function reply(target: InteractiveCommand, conn: number, message: unknown): void {
		const frame = `${JSON.stringify({ conn, line: JSON.stringify(message) })}\n`;
		if (outbox_chars + frame.length > limits.max_outbox_chars) {
			if (dropped_replies % 100 === 0) {
				log(`crew bridge ${label}: the relay is not reading; dropped a reply`);
			}
			dropped_replies += 1;
			return;
		}
		outbox.push({ target, frame });
		outbox_chars += frame.length;
		void flush();
	}

	async function flush(): Promise<void> {
		if (flushing) return;
		flushing = true;
		try {
			for (let next = outbox.shift(); next !== undefined; next = outbox.shift()) {
				try {
					await next.target.sendStdin(next.frame);
				} catch {
					log(`crew bridge ${label}: a reply could not reach the relay`);
				} finally {
					outbox_chars -= next.frame.length;
				}
			}
		} finally {
			flushing = false;
		}
	}

	// Admission: a token bucket for the rate, then a handler slot or a bounded queue.
	let tokens = limits.burst;
	let refilled_at = now();
	let active = 0;
	const waiting: { target: InteractiveCommand; frame: RelayFrame }[] = [];
	let refused = 0;

	function refuse(target: InteractiveCommand, frame: RelayFrame, why: string): void {
		if (refused % 100 === 0) {
			log(`crew bridge ${label}: refused a crew request (${why}; ${refused + 1} so far)`);
		}
		refused += 1;
		const id = requestId(frame.line);
		if (id === undefined) return;
		reply(target, frame.conn, {
			jsonrpc: '2.0',
			id,
			error: { code: -32000, message: CREW_BUSY_MESSAGE }
		});
	}

	function admit(target: InteractiveCommand, frame: RelayFrame): void {
		const at = now();
		tokens = Math.min(limits.burst, tokens + ((at - refilled_at) / 1000) * limits.per_second);
		refilled_at = at;
		if (tokens < 1) {
			refuse(target, frame, 'rate');
			return;
		}
		tokens -= 1;
		if (active < limits.max_active) {
			run(target, frame);
		} else if (waiting.length < limits.max_queued) {
			waiting.push({ target, frame });
		} else {
			refuse(target, frame, 'queue full');
		}
	}

	function run(target: InteractiveCommand, frame: RelayFrame): void {
		active += 1;
		void answer(target, frame)
			.catch(() => log(`crew bridge ${label}: a crew request failed`))
			.finally(() => {
				active -= 1;
				const next = waiting.shift();
				if (next !== undefined && !stopped) run(next.target, next.frame);
			});
	}

	async function answer(target: InteractiveCommand, frame: RelayFrame): Promise<void> {
		const ctx = await deps.context(session_id).catch(() => undefined);
		if (ctx === undefined) {
			const id = requestId(frame.line);
			if (id === undefined) return;
			reply(target, frame.conn, {
				jsonrpc: '2.0',
				id,
				error: { code: -32603, message: 'This chat can no longer use crew tools.' }
			});
			return;
		}
		const response = await deps.handler.handleText(ctx, frame.line);
		if (response !== undefined) reply(target, frame.conn, response);
	}

	async function start(): Promise<void> {
		const stderr = new TextTail();
		let current: InteractiveCommand | undefined;
		const reader = new FrameReader(
			(frame) => {
				if (current !== undefined && !stopped) admit(current, frame);
			},
			(reason) => log(`crew bridge ${label}: dropped a relay frame (${reason})`)
		);
		current = await sandbox.interactive(
			['node', CREW_RELAY_PATH, 'serve', CREW_SOCKET_PATH].map(shellQuote).join(' '),
			{
				cwd: MATE_WORKDIR,
				on_stdout: (chunk) => reader.push(chunk),
				on_stderr: (chunk) => stderr.push(chunk)
			}
		);
		command = current;
		if (stopped) {
			void current.kill().catch(() => undefined);
			return;
		}
		void current.wait().then((code) => {
			if (stopped) return;
			log(
				`crew bridge ${label}: relay exited (${code ?? 'connection lost'})${
					stderr.text === '' ? '' : `: ${stderr.text}`
				}`
			);
			if (restarts >= RELAY_MAX_RESTARTS) {
				log(`crew bridge ${label}: relay restarted ${restarts} times; giving up`);
				return;
			}
			restarts += 1;
			setTimeout(() => {
				if (stopped) return;
				start().catch((error: unknown) =>
					log(`crew bridge ${label}: relay could not restart: ${String(error)}`)
				);
			}, restart_delay_ms);
		});
	}

	await start();
	return {
		stop() {
			if (stopped) return;
			stopped = true;
			waiting.length = 0;
			void command?.kill().catch(() => undefined);
		}
	};
}
