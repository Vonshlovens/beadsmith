import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createCrewMcpHandler } from '../crew/mcp.js';
import { defineTool, type CrewContext, type CrewTool } from '../crew/registry.js';
import type { InteractiveCommand, SandboxRef } from '../e2b/sandbox.js';
import {
	CREW_MCP_CONFIG_PATH,
	CREW_RELAY_PATH,
	CREW_SOCKET_PATH,
	CREW_BRIDGE_LIMITS,
	CREW_BUSY_MESSAGE,
	crewMcpConfig,
	FRAME_MAX_CHARS,
	FrameReader,
	MATE_AGENTS_MD,
	prepareChatSandbox,
	RELAY_MAX_RESTARTS,
	RELAY_SOURCE,
	startCrewBridge,
	TextTail,
	type RelayFrame
} from './crew-bridge.js';
import { MATE_WORKDIR } from '../e2b/image.js';

const SESSION = '0e7c1a52-3f0b-4b7e-9a51-2a3c4d5e6f70';
const CTX: CrewContext = {
	account_id: 'u_owner',
	actor: 'owner@example.test',
	role: 'admin',
	chat_id: 'mc_one',
	scope: null
};

const whoami = defineTool({
	name: 'whoami',
	description: 'Who the call acts as.',
	input: z.object({}),
	async handler(ctx) {
		return { account_id: ctx.account_id, chat_id: ctx.chat_id };
	}
});

/** The relay's serve side as the bridge sees it. */
class FakeRelay implements InteractiveCommand {
	stdin: string[] = [];
	killed = false;
	#exit: (code: number | null) => void = () => undefined;
	readonly #done = new Promise<number | null>((resolve) => (this.#exit = resolve));
	constructor(
		readonly command: string,
		readonly out: (chunk: string) => void,
		readonly err: (chunk: string) => void
	) {}
	async sendStdin(data: string) {
		this.stdin.push(data);
	}
	async closeStdin() {}
	async kill() {
		this.killed = true;
		this.#exit(null);
	}
	exit(code: number) {
		this.#exit(code);
	}
	wait() {
		return this.#done;
	}
	/** Replies written back, parsed. */
	replies(): { conn: number; message: Record<string, unknown> }[] {
		return this.stdin
			.join('')
			.split('\n')
			.filter((line) => line !== '')
			.map((line) => {
				const frame = JSON.parse(line) as { conn: number; line: string };
				return { conn: frame.conn, message: JSON.parse(frame.line) };
			});
	}
}

function fakeSandbox() {
	const relays: FakeRelay[] = [];
	const files = new Map<string, string>();
	const sandbox: SandboxRef = {
		id: 'sbx',
		async exec() {
			return { exit_code: 0, stdout: '' };
		},
		async interactive(command, options) {
			const relay = new FakeRelay(command, options.on_stdout, options.on_stderr);
			relays.push(relay);
			return relay;
		},
		async writeFile(path, content) {
			files.set(path, content);
		},
		async start() {},
		async follow() {},
		async setTimeout() {},
		async updateNetwork() {},
		async kill() {}
	};
	return { sandbox, relays, files };
}

async function until(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error('timed out');
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function call(id: number, name: string): string {
	return JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name } });
}

describe('FrameReader', () => {
	it('reassembles frames split across chunks', () => {
		const frames: RelayFrame[] = [];
		const reader = new FrameReader(
			(frame) => frames.push(frame),
			() => undefined
		);
		const text = `${JSON.stringify({ conn: 1, line: 'a' })}\n${JSON.stringify({ conn: 2, line: 'b' })}\n`;
		reader.push(text.slice(0, 7));
		reader.push(text.slice(7, 30));
		reader.push(text.slice(30));
		expect(frames).toEqual([
			{ conn: 1, line: 'a' },
			{ conn: 2, line: 'b' }
		]);
	});

	it('drops malformed and oversized frames and keeps going', () => {
		const frames: RelayFrame[] = [];
		const drops: string[] = [];
		const reader = new FrameReader(
			(frame) => frames.push(frame),
			(reason) => drops.push(reason)
		);
		reader.push('not json\n');
		reader.push(`${JSON.stringify({ conn: 0, line: 'x' })}\n`);
		reader.push(`${JSON.stringify({ conn: 1, line: 'x', extra: true })}\n`);
		reader.push(`${JSON.stringify({ conn: 1, line: 5 })}\n`);
		// Oversized with no newline yet: dropped as it grows, the rest skipped.
		reader.push('x'.repeat(FRAME_MAX_CHARS + 1));
		reader.push(`${'y'.repeat(100)}\n`);
		reader.push(`${JSON.stringify({ conn: 3, line: 'ok' })}\n`);
		expect(frames).toEqual([{ conn: 3, line: 'ok' }]);
		expect(drops).toEqual([
			'frame is not JSON',
			'malformed frame',
			'malformed frame',
			'malformed frame',
			'oversized frame'
		]);
	});
});

describe('TextTail', () => {
	it('keeps only the end', () => {
		const tail = new TextTail(5);
		tail.push('abc');
		tail.push('defgh');
		expect(tail.text).toBe('defgh');
	});
});

describe('prepareChatSandbox', () => {
	it('writes the relay, its MCP config and the standing instructions', async () => {
		const { sandbox, files } = fakeSandbox();
		await prepareChatSandbox(sandbox);
		expect(files.get(CREW_RELAY_PATH)).toBe(RELAY_SOURCE);
		expect(JSON.parse(files.get(CREW_MCP_CONFIG_PATH)!)).toEqual({
			mcpServers: {
				crew: { type: 'stdio', command: 'node', args: [CREW_RELAY_PATH, 'stdio', CREW_SOCKET_PATH] }
			}
		});
		const agents = files.get(`${MATE_WORKDIR}/AGENTS.md`)!;
		expect(agents).toBe(MATE_AGENTS_MD);
		expect(agents).not.toMatch(/model access only/i);
		expect(agents).toContain('mcp__crew__');
		expect(agents).toMatch(/only through missions/);
	});
});

describe('startCrewBridge', () => {
	it('answers tool calls as the chat owner on the frame connection', async () => {
		const { sandbox, relays } = fakeSandbox();
		const seen: string[] = [];
		const bridge = await startCrewBridge({
			sandbox,
			session_id: SESSION,
			deps: {
				handler: createCrewMcpHandler({ tools: [whoami], log: () => undefined }),
				async context(session_id) {
					seen.push(session_id);
					return CTX;
				}
			},
			log: () => undefined
		});
		const [relay] = relays;
		expect(relay.command).toBe(`'node' '${CREW_RELAY_PATH}' 'serve' '${CREW_SOCKET_PATH}'`);
		const frame = `${JSON.stringify({ conn: 4, line: call(7, 'whoami') })}\n`;
		relay.out(frame.slice(0, 20));
		relay.out(frame.slice(20));
		// A notification gets no reply.
		relay.out(
			`${JSON.stringify({ conn: 4, line: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })}\n`
		);
		await until(() => relay.stdin.length === 1);
		expect(seen).toContain(SESSION);
		const [reply] = relay.replies();
		expect(reply.conn).toBe(4);
		expect(reply.message).toMatchObject({ jsonrpc: '2.0', id: 7 });
		const text = (reply.message.result as { content: { text: string }[] }).content[0].text;
		expect(JSON.parse(text)).toEqual({ account_id: 'u_owner', chat_id: 'mc_one' });
		bridge.stop();
		expect(relay.killed).toBe(true);
	});

	it('refuses calls from a session with no owner and logs dropped frames', async () => {
		const { sandbox, relays } = fakeSandbox();
		const logs: string[] = [];
		await startCrewBridge({
			sandbox,
			session_id: SESSION,
			deps: {
				handler: createCrewMcpHandler({ tools: [whoami], log: () => undefined }),
				context: async () => undefined
			},
			log: (message) => logs.push(message)
		});
		const [relay] = relays;
		relay.out('garbage\n');
		relay.out(`${'z'.repeat(FRAME_MAX_CHARS + 10)}\n`);
		relay.out(`${JSON.stringify({ conn: 1, line: call(9, 'whoami') })}\n`);
		await until(() => relay.stdin.length === 1);
		expect(relay.replies()[0].message).toMatchObject({
			id: 9,
			error: { message: 'This chat can no longer use crew tools.' }
		});
		expect(logs.filter((line) => line.includes('dropped a relay frame'))).toHaveLength(2);
		// Logs name the session by a short prefix only.
		expect(logs.join('\n')).not.toContain(SESSION);
	});

	it('restarts a relay that exits, a bounded number of times', async () => {
		const { sandbox, relays } = fakeSandbox();
		const logs: string[] = [];
		const bridge = await startCrewBridge({
			sandbox,
			session_id: SESSION,
			deps: { handler: createCrewMcpHandler({ tools: [] }), context: async () => CTX },
			log: (message) => logs.push(message),
			restart_delay_ms: 1
		});
		relays[0].err('node: boom\n');
		relays[0].exit(1);
		await until(() => relays.length === 2);
		expect(logs[0]).toContain('relay exited (1): node: boom');
		for (let i = 1; i <= RELAY_MAX_RESTARTS; i++) {
			await until(() => relays.length === i + 1);
			relays[i].exit(1);
		}
		await until(() => logs.some((line) => line.includes('giving up')));
		expect(relays).toHaveLength(RELAY_MAX_RESTARTS + 1);
		bridge.stop();
	});

	it('does not restart a relay it stopped', async () => {
		const { sandbox, relays } = fakeSandbox();
		const bridge = await startCrewBridge({
			sandbox,
			session_id: SESSION,
			deps: { handler: createCrewMcpHandler({ tools: [] }), context: async () => CTX },
			log: () => undefined,
			restart_delay_ms: 1
		});
		bridge.stop();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(relays).toHaveLength(1);
	});
});

describe('relay script', () => {
	const children: ChildProcessWithoutNullStreams[] = [];
	afterEach(() => {
		for (const child of children.splice(0)) child.kill();
	});

	function lines(child: ChildProcessWithoutNullStreams): string[] {
		const out: string[] = [];
		let buffer = '';
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			buffer += chunk;
			let at: number;
			while ((at = buffer.indexOf('\n')) !== -1) {
				out.push(buffer.slice(0, at));
				buffer = buffer.slice(at + 1);
			}
		});
		return out;
	}

	it('carries JSON-RPC lines between the stdio side and frames', async () => {
		// Short path: unix socket paths are limited to about 100 bytes.
		const dir = mkdtempSync(join(tmpdir(), 'crw-'));
		const script = join(dir, 'relay.cjs');
		const socket = join(dir, 's.sock');
		writeFileSync(script, RELAY_SOURCE);
		expect(crewMcpConfig()).toContain(CREW_RELAY_PATH);

		const serve = spawn(process.execPath, [script, 'serve', socket]);
		children.push(serve);
		const frames = lines(serve);
		const stdio = spawn(process.execPath, [script, 'stdio', socket]);
		children.push(stdio);
		const replies = lines(stdio);

		const request = call(1, 'whoami');
		stdio.stdin.write(`${request}\n`);
		await until(() => frames.length === 1);
		const frame = JSON.parse(frames[0]) as { conn: number; line: string };
		expect(frame.line).toBe(request);

		serve.stdin.write(
			`${JSON.stringify({ conn: frame.conn, line: '{"jsonrpc":"2.0","id":1}' })}\n`
		);
		// A frame for a connection that does not exist goes nowhere.
		serve.stdin.write(`${JSON.stringify({ conn: 999, line: 'lost' })}\n`);
		await until(() => replies.length === 1);
		expect(replies).toEqual(['{"jsonrpc":"2.0","id":1}']);
	});
});

describe('crew request limits', () => {
	/** A read tool that holds every call until released, counting how many run at once. */
	function heldTool() {
		const state = { running: 0, peak: 0, started: 0, release: () => undefined as void };
		let gate = Promise.withResolvers<void>();
		state.release = () => {
			gate.resolve();
			gate = Promise.withResolvers<void>();
		};
		const tool = defineTool({
			name: 'list_todos',
			description: 'A read that waits.',
			input: z.object({}),
			async handler() {
				state.started += 1;
				state.running += 1;
				state.peak = Math.max(state.peak, state.running);
				await gate.promise;
				state.running -= 1;
				return { ok: true };
			}
		});
		return { tool, state };
	}

	async function bridgeWith(tool: CrewTool, extra = {}) {
		const { sandbox, relays } = fakeSandbox();
		const logs: string[] = [];
		const clock = { ms: 0 };
		const bridge = await startCrewBridge({
			sandbox,
			session_id: SESSION,
			deps: {
				handler: createCrewMcpHandler({
					tools: tool === whoami ? [whoami] : [tool, whoami],
					log: () => undefined
				}),
				context: async () => CTX
			},
			log: (message) => logs.push(message),
			now: () => clock.ms,
			...extra
		});
		return { bridge, relay: relays[0], logs, clock };
	}

	function send(relay: FakeRelay, from: number, count: number, name = 'list_todos') {
		for (let id = from; id < from + count; id += 1) {
			relay.out(`${JSON.stringify({ conn: 1, line: call(id, name) })}\n`);
		}
	}

	function busy(relay: FakeRelay) {
		return relay
			.replies()
			.filter(
				(r) => (r.message.error as { message?: string } | undefined)?.message === CREW_BUSY_MESSAGE
			);
	}

	it('keeps a burst of 1,000 requests inside the handler and queue bounds', async () => {
		const { tool, state } = heldTool();
		const { relay, logs } = await bridgeWith(tool);
		const { max_active, max_queued } = CREW_BRIDGE_LIMITS;

		send(relay, 1, 1000);
		await until(() => state.started === max_active);
		await until(() => relay.replies().length === 1000 - max_active - max_queued);
		expect(busy(relay)).toHaveLength(1000 - max_active - max_queued);
		expect(state.peak).toBe(max_active);

		// Released, the queued requests run, never more than the bound at once.
		while (state.started < max_active + max_queued || state.running > 0) {
			state.release();
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		await until(() => relay.replies().length === 1000);
		expect(state.started).toBe(max_active + max_queued);
		expect(state.peak).toBe(max_active);
		// Every request got exactly one answer.
		expect(new Set(relay.replies().map((r) => r.message.id)).size).toBe(1000);
		// Refusals are logged, not one line each.
		expect(logs.filter((line) => line.includes('refused a crew request')).length).toBeLessThan(15);
	});

	it('admits at the refill rate once the burst is spent', async () => {
		const { tool, state } = heldTool();
		const { relay, clock } = await bridgeWith(tool, {
			limits: { burst: 5, per_second: 2, max_active: 100, max_queued: 0 }
		});
		send(relay, 1, 8);
		await until(() => relay.replies().length === 3 && state.started === 5);
		clock.ms = 1000;
		send(relay, 100, 3);
		await until(() => relay.replies().length === 4 && state.started === 7);
		expect(busy(relay)).toHaveLength(4);
		state.release();
	});

	it('bounds replies to a relay that stops reading and keeps handlers free', async () => {
		const { relay: stalled_relay, logs } = await (async () => {
			const context = await bridgeWith(whoami, {
				limits: { max_outbox_chars: 2_000 }
			});
			// Every write hangs.
			context.relay.sendStdin = () => new Promise<void>(() => undefined);
			return context;
		})();
		send(stalled_relay, 1, 50, 'whoami');
		await until(() => logs.some((line) => line.includes('the relay is not reading')));
		expect(logs.filter((line) => line.includes('the relay is not reading'))).toHaveLength(1);

		// Another chat's bridge is unaffected.
		const { tool, state } = heldTool();
		const other = await bridgeWith(tool);
		send(other.relay, 1, 1, 'whoami');
		await until(() => other.relay.replies().length === 1);
		expect(other.relay.replies()[0].message).toMatchObject({ id: 1, result: {} });
		expect(state.started).toBe(0);
	});
});
