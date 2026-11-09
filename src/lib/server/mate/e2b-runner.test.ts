import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createCrewMcpHandler } from '../crew/mcp.js';
import { defineTool, type CrewContext } from '../crew/registry.js';
import type { MissionEvent } from '#lib/mission-events.js';
import type {
	InteractiveCommand,
	SandboxCreateInput,
	SandboxDriver,
	SandboxRef
} from '../e2b/sandbox.js';
import { OAUTH_PLACEHOLDER } from '../e2b/sandbox.js';
import { CREW_MCP_CONFIG_PATH, CREW_RELAY_PATH, MATE_WORKDIR } from './crew-bridge.js';
import { createE2bMateRunner } from './e2b-runner.js';

const SESSION = '0e7c1a52-3f0b-4b7e-9a51-2a3c4d5e6f70';
const TOKEN = 'sk-ant-oat01-REAL-subscription-token';

/** A Claude Code stand-in: answers each stdin message with one turn. */
class FakeClaude implements InteractiveCommand {
	stdin: string[] = [];
	closed = false;
	killed = false;
	#exit: (code: number | null) => void = () => undefined;
	readonly #done = new Promise<number | null>((resolve) => (this.#exit = resolve));

	constructor(
		readonly command: string,
		readonly cwd: string | undefined,
		private readonly out: (chunk: string) => void,
		readonly err: (chunk: string) => void
	) {
		out(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: SESSION })}\n`);
	}

	async sendStdin(data: string) {
		this.stdin.push(data);
		const reply = [
			{ type: 'assistant', message: { content: [{ type: 'text', text: 'Aye, captain.' }] } },
			{ type: 'result', subtype: 'success', is_error: false, result: 'Aye, captain.' }
		];
		// Split mid-line, as a real stream would.
		const text = reply.map((line) => `${JSON.stringify(line)}\n`).join('');
		this.out(text.slice(0, 11));
		this.out(text.slice(11));
	}
	async closeStdin() {
		this.closed = true;
		this.#exit(0);
	}
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
}

/** The crew relay's serve side: frames out on stdout, replies on stdin. */
class FakeRelay implements InteractiveCommand {
	stdin: string[] = [];
	killed = false;
	#exit: (code: number | null) => void = () => undefined;
	readonly #done = new Promise<number | null>((resolve) => (this.#exit = resolve));
	constructor(
		readonly command: string,
		readonly out: (chunk: string) => void
	) {}
	async sendStdin(data: string) {
		this.stdin.push(data);
	}
	async closeStdin() {}
	async kill() {
		this.killed = true;
		this.#exit(null);
	}
	wait() {
		return this.#done;
	}
}

class FakeChatSandbox implements SandboxRef {
	commands: FakeClaude[] = [];
	relays: FakeRelay[] = [];
	/** Every file written, in order, as [path, content]. */
	writes: [string, string][] = [];
	/** Interactive commands in start order: 'relay' or 'claude'. */
	started: string[] = [];
	execs: string[] = [];
	timeouts: number[] = [];
	killed = false;
	constructor(
		readonly id: string,
		readonly metadata: Record<string, string>
	) {}
	async exec(command: string) {
		this.execs.push(command);
		return { exit_code: 0, stdout: '' };
	}
	async interactive(
		command: string,
		options: {
			cwd?: string;
			on_stdout: (chunk: string) => void;
			on_stderr: (chunk: string) => void;
		}
	) {
		if (command.includes(CREW_RELAY_PATH)) {
			const relay = new FakeRelay(command, options.on_stdout);
			this.relays.push(relay);
			this.started.push('relay');
			return relay;
		}
		const claude = new FakeClaude(command, options.cwd, options.on_stdout, options.on_stderr);
		this.commands.push(claude);
		this.started.push('claude');
		return claude;
	}
	async setTimeout(ms: number) {
		this.timeouts.push(ms);
	}
	async kill() {
		this.killed = true;
	}
	async start() {}
	async follow() {}
	async writeFile(path: string, content: string) {
		this.writes.push([path, content]);
	}
	async updateNetwork() {}
}

const whoami = defineTool({
	name: 'whoami',
	description: 'Who the call acts as.',
	input: z.object({}),
	async handler(ctx) {
		return { account_id: ctx.account_id, chat_id: ctx.chat_id };
	}
});

const OWNER: CrewContext = { account_id: 'u_owner', role: 'admin', chat_id: 'mc_one', scope: null };

function setup(options: { create_error?: Error; sandboxes?: Map<string, FakeChatSandbox> } = {}) {
	const sandboxes = options.sandboxes ?? new Map<string, FakeChatSandbox>();
	const logs: string[] = [];
	const contexts: string[] = [];
	const created: SandboxCreateInput[] = [];
	let now = 0;
	const driver: SandboxDriver = {
		async create(input) {
			if (options.create_error !== undefined) throw options.create_error;
			created.push(input);
			const sandbox = new FakeChatSandbox(`chat-sbx${sandboxes.size + 1}`, input.metadata);
			sandboxes.set(sandbox.id, sandbox);
			return sandbox;
		},
		async connect(id) {
			const sandbox = sandboxes.get(id);
			if (sandbox === undefined || sandbox.killed) throw new Error('gone');
			return sandbox;
		},
		async info(id) {
			const sandbox = sandboxes.get(id);
			return sandbox === undefined
				? undefined
				: { id, state: 'running', metadata: sandbox.metadata };
		},
		async find(query) {
			return [...sandboxes.values()]
				.filter((sandbox) => !sandbox.killed)
				.filter((sandbox) =>
					Object.entries(query).every(([key, value]) => sandbox.metadata[key] === value)
				)
				.map((sandbox) => ({
					id: sandbox.id,
					state: 'running' as const,
					metadata: sandbox.metadata
				}));
		}
	};
	const runner = createE2bMateRunner({
		settings: {
			api_key_file: '/run/secrets/e2b',
			template: 'beadsmith-agent',
			claude_oauth_token_file: '/run/secrets/claude-oauth',
			idle_minutes: 15,
			max_sessions: 3,
			state_dir: mkdtempSync(join(tmpdir(), 'bdx-sand-mate-'))
		},
		driver,
		read_secret: async () => TOKEN,
		now: () => (now += 61_000),
		crew: {
			handler: createCrewMcpHandler({ tools: [whoami], log: () => undefined }),
			async context(session_id) {
				contexts.push(session_id);
				return session_id === SESSION ? OWNER : undefined;
			}
		},
		log: (message) => logs.push(message)
	});
	return { runner, sandboxes, created, logs, contexts };
}

async function until(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error('timed out');
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function collect(
	runner: ReturnType<typeof setup>['runner'],
	chat: string,
	until: (events: MissionEvent[]) => boolean
): Promise<MissionEvent[]> {
	const events: MissionEvent[] = [];
	const ac = new AbortController();
	const done = runner.streamEvents(
		chat,
		undefined,
		(event) => {
			events.push(event);
			if (until(events)) ac.abort();
		},
		ac.signal
	);
	await Promise.race([
		done,
		new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 2_000))
	]);
	return events;
}

describe('Sand First Mate runner', () => {
	it('runs a chat in its own sandbox with the model key outside it', async () => {
		const { runner, sandboxes, created } = setup();
		const { event_id } = await runner.sendMessage('mc_one', {
			session_id: SESSION,
			message_id: 'm1',
			prompt: 'Ahoy',
			scope: null
		});
		expect(event_id).toMatch(/^e\d{9}$/);
		const events = await collect(runner, 'mc_one', (all) => all.some((e) => e.type === 'result'));
		expect(events.map((event) => event.type)).toEqual(['user', 'assistant', 'result']);
		expect(events[0]).toMatchObject({ type: 'user', text: 'Ahoy', message_id: 'm1' });
		expect(events[1]).toMatchObject({ type: 'assistant', text: 'Aye, captain.' });

		const [input] = created;
		expect(input.metadata).toMatchObject({ beadsmith_mate_session: SESSION });
		expect(input.envs).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: OAUTH_PLACEHOLDER });
		expect(JSON.stringify(input.envs)).not.toContain(TOKEN);
		expect(input.network.headers['api.anthropic.com']).toEqual({
			authorization: `Bearer ${TOKEN}`
		});
		expect(input.network.headers['github.com']).toBeUndefined();

		const claude = sandboxes.get('chat-sbx1')!.commands[0];
		expect(claude.cwd).toBe(MATE_WORKDIR);
		expect(claude.command).toContain("'--session-id' '" + SESSION + "'");
		expect(claude.stdin.join('')).toContain('Ahoy');
		// Activity keeps the sandbox from pausing mid-conversation.
		expect(sandboxes.get('chat-sbx1')!.timeouts.length).toBeGreaterThan(0);
	});

	it('keeps one process per chat and drops a repeated message id', async () => {
		const { runner, sandboxes } = setup();
		const input = { session_id: SESSION, message_id: 'm1', prompt: 'Ahoy', scope: null };
		const first = await runner.sendMessage('mc_one', input);
		expect(await runner.sendMessage('mc_one', input)).toEqual(first);
		await collect(runner, 'mc_one', (all) => all.some((e) => e.type === 'result'));
		await runner.sendMessage('mc_one', { ...input, message_id: 'm2', prompt: 'Again' });
		const sandbox = sandboxes.get('chat-sbx1')!;
		expect(sandboxes.size).toBe(1);
		expect(sandbox.commands).toHaveLength(1);
		expect(sandbox.commands[0].stdin).toHaveLength(2);
	});

	it('refuses a message for another session', async () => {
		const { runner } = setup();
		await runner.sendMessage('mc_one', {
			session_id: SESSION,
			message_id: 'm1',
			prompt: 'a',
			scope: null
		});
		await expect(
			runner.sendMessage('mc_one', {
				session_id: '11111111-2222-4333-8444-555555555555',
				message_id: 'm2',
				prompt: 'b',
				scope: null
			})
		).rejects.toMatchObject({ code: 'conflict' });
	});

	it('gives a fresh and a resumed sandbox the crew relay, its files and --mcp-config', async () => {
		const sandboxes = new Map<string, FakeChatSandbox>();
		const first = setup({ sandboxes });
		const input = { session_id: SESSION, message_id: 'm1', prompt: 'Ahoy', scope: null };
		await first.runner.sendMessage('mc_one', input);
		await collect(first.runner, 'mc_one', (all) => all.some((e) => e.type === 'result'));
		const sandbox = sandboxes.get('chat-sbx1')!;
		const expectWired = (writes: [string, string][]) => {
			expect(writes.map(([path]) => path)).toEqual([
				`${MATE_WORKDIR}/AGENTS.md`,
				CREW_RELAY_PATH,
				CREW_MCP_CONFIG_PATH
			]);
			expect(writes[0][1]).not.toMatch(/model access only/i);
		};
		expectWired(sandbox.writes);
		// The relay listens before Claude Code starts its stdio side.
		expect(sandbox.started).toEqual(['relay', 'claude']);
		expect(sandbox.commands[0].command).toContain(`'--mcp-config' '${CREW_MCP_CONFIG_PATH}'`);
		await first.runner.close();
		expect(sandbox.relays[0].killed).toBe(true);

		// A restarted Beadsmith finds the same sandbox and resumes it.
		const second = setup({ sandboxes });
		await second.runner.sendMessage('mc_one', { ...input, message_id: 'm2' });
		await until(() => sandbox.commands.length === 2);
		expect(sandboxes.size).toBe(1);
		expectWired(sandbox.writes.slice(3));
		expect(sandbox.started).toEqual(['relay', 'claude', 'relay', 'claude']);
		expect(sandbox.commands[1].command).toContain(`'--mcp-config' '${CREW_MCP_CONFIG_PATH}'`);
		// The old relay and Claude Code are stopped before new ones start.
		expect(sandbox.execs.at(-1)).toContain(`${CREW_RELAY_PATH} serve`);
		await second.runner.close();
	});

	it('runs a relayed tool call as the chat owner and replies on the relay', async () => {
		const { runner, sandboxes, contexts } = setup();
		await runner.sendMessage('mc_one', {
			session_id: SESSION,
			message_id: 'm1',
			prompt: 'Who am I?',
			scope: null
		});
		await collect(runner, 'mc_one', (all) => all.some((e) => e.type === 'result'));
		const relay = sandboxes.get('chat-sbx1')!.relays[0];
		const line = JSON.stringify({
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/call',
			params: { name: 'whoami', arguments: {} }
		});
		relay.out('{"conn":2,"line":"oversized frames are dropped' + 'x'.repeat(300_000) + '"}\n');
		relay.out(`${JSON.stringify({ conn: 2, line })}\n`);
		await until(() => relay.stdin.length === 1);
		expect(contexts).toEqual([SESSION]);
		const frame = JSON.parse(relay.stdin[0]) as { conn: number; line: string };
		expect(frame.conn).toBe(2);
		const reply = JSON.parse(frame.line) as {
			id: number;
			result: { content: { text: string }[] };
		};
		expect(reply.id).toBe(3);
		expect(JSON.parse(reply.result.content[0].text)).toEqual({
			account_id: 'u_owner',
			chat_id: 'mc_one'
		});
		await runner.close();
	});

	it('logs E2B and Claude Code failures on the server only', async () => {
		const detail = 'E2B 500: template beadsmith-agent quota exceeded for team t_9';
		const failing = setup({ create_error: new Error(detail) });
		await failing.runner.sendMessage('mc_one', {
			session_id: SESSION,
			message_id: 'm1',
			prompt: 'a',
			scope: null
		});
		const events = await collect(failing.runner, 'mc_one', (all) =>
			all.some((e) => e.type === 'result' || e.type === 'error')
		);
		expect(JSON.stringify(events)).not.toContain('quota');
		expect(failing.logs.join('\n')).toContain(detail);
		expect(failing.logs.join('\n')).not.toContain(SESSION);

		const { runner, sandboxes, logs } = setup();
		await runner.sendMessage('mc_one', {
			session_id: SESSION,
			message_id: 'm1',
			prompt: 'a',
			scope: null
		});
		await collect(runner, 'mc_one', (all) => all.some((e) => e.type === 'result'));
		const claude = sandboxes.get('chat-sbx1')!.commands[0];
		claude.err(`${'noise '.repeat(2_000)}Error: rate limited by api.anthropic.com\n`);
		claude.exit(1);
		await until(() => logs.some((line) => line.includes('Claude Code exited (1)')));
		const line = logs.find((entry) => entry.includes('Claude Code exited (1)'))!;
		expect(line).toContain('rate limited');
		expect(line.length).toBeLessThan(2_200);
		await runner.close();
	});

	it('deletes the chat together with its sandbox', async () => {
		const { runner, sandboxes } = setup();
		await runner.sendMessage('mc_one', {
			session_id: SESSION,
			message_id: 'm1',
			prompt: 'a',
			scope: null
		});
		await runner.deleteChat('mc_one');
		expect(sandboxes.get('chat-sbx1')!.killed).toBe(true);
		// A chat the runner never knew is fine.
		await runner.deleteChat('mc_unknown');
		await runner.close();
	});
});
