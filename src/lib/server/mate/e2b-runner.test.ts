import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MissionEvent } from '#lib/mission-events.js';
import type {
	InteractiveCommand,
	SandboxCreateInput,
	SandboxDriver,
	SandboxRef
} from '../e2b/sandbox.js';
import { OAUTH_PLACEHOLDER } from '../e2b/sandbox.js';
import { createE2bMateRunner, MATE_WORKDIR } from './e2b-runner.js';

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
		private readonly out: (chunk: string) => void
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
	wait() {
		return this.#done;
	}
}

class FakeChatSandbox implements SandboxRef {
	commands: FakeClaude[] = [];
	execs: string[] = [];
	timeouts: number[] = [];
	killed = false;
	constructor(readonly id: string) {}
	async exec(command: string) {
		this.execs.push(command);
		return { exit_code: 0, stdout: '' };
	}
	async interactive(
		command: string,
		options: { cwd?: string; on_stdout: (chunk: string) => void }
	) {
		const claude = new FakeClaude(command, options.cwd, options.on_stdout);
		this.commands.push(claude);
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
	async writeFile() {}
	async updateNetwork() {}
}

function setup() {
	const sandboxes = new Map<string, FakeChatSandbox>();
	const meta = new Map<string, Record<string, string>>();
	const created: SandboxCreateInput[] = [];
	let now = 0;
	const driver: SandboxDriver = {
		async create(input) {
			created.push(input);
			const sandbox = new FakeChatSandbox(`chat-sbx${sandboxes.size + 1}`);
			sandboxes.set(sandbox.id, sandbox);
			meta.set(sandbox.id, input.metadata);
			return sandbox;
		},
		async connect(id) {
			const sandbox = sandboxes.get(id);
			if (sandbox === undefined || sandbox.killed) throw new Error('gone');
			return sandbox;
		},
		async info(id) {
			const sandbox = sandboxes.get(id);
			return sandbox === undefined ? undefined : { id, state: 'running', metadata: meta.get(id)! };
		},
		async find(query) {
			return [...sandboxes.values()]
				.filter((sandbox) => !sandbox.killed)
				.filter((sandbox) =>
					Object.entries(query).every(([key, value]) => meta.get(sandbox.id)?.[key] === value)
				)
				.map((sandbox) => ({
					id: sandbox.id,
					state: 'running' as const,
					metadata: meta.get(sandbox.id)!
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
		now: () => (now += 61_000)
	});
	return { runner, sandboxes, created };
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
