/**
 * A scripted interactive Claude Code on a {@link FakeHcCore}, for tests of
 * the session core and its callers. It reports `idle` at launch, writes its
 * session transcript where the real CLI would (under the config directory,
 * named after the `--session-id` or `--resume` argument and the terminal's
 * working directory), and answers each pasted message with one turn unless
 * a test replaces {@link FakeClaude.onMessage}.
 */

import { claudeCode } from '../agent-session/claude-code.js';
import { FakeHcCore, type FakeTerminal } from './fake-hc.js';

export interface FakeClaudeOptions {
	/** Claude Code's config directory in the fake machine (default `/home/user/.claude`). */
	config_dir?: string;
	/** The transcript {@link FakeClaude.write} uses before any terminal ran. */
	transcript?: string;
}

export class FakeClaude {
	readonly core = new FakeHcCore();
	readonly config_dir: string;
	/** What a message does; the default answers and ends the turn. */
	onMessage: (t: FakeTerminal, text: string) => void = (t, text) => this.answer(t, `Echo: ${text}`);
	/** Status reported right after launch; null reports nothing. */
	launch_status: string | null = 'idle';

	readonly #lines = new Map<string, string[]>();
	#current: string | undefined;

	constructor(options: FakeClaudeOptions = {}) {
		this.config_dir = options.config_dir ?? '/home/user/.claude';
		this.#current = options.transcript;
		this.core.onRun = (t) => {
			this.#current = this.transcriptOf(t);
			if (this.launch_status !== null) this.core.setStatus(t.address, this.launch_status);
		};
		this.core.onSend = (t, text) => {
			queueMicrotask(() => {
				this.write({ type: 'user', message: { role: 'user', content: text } }, t);
				this.core.setStatus(t.address, 'working');
				this.onMessage(t, text);
			});
		};
	}

	/** The transcript a terminal's CLI writes. */
	transcriptOf(t: FakeTerminal): string {
		const flag = t.argv.findIndex((arg) => arg === '--session-id' || arg === '--resume');
		const session_id = t.argv[flag + 1] ?? '';
		return claudeCode.transcriptPath({ cwd: t.cwd, config_dir: this.config_dir, session_id });
	}

	/** Lines of a transcript (the latest terminal's by default). */
	lines(path = this.#current): string[] {
		return path === undefined ? [] : (this.#lines.get(path) ?? []);
	}

	/** Append one entry to `t`'s transcript (the latest terminal's without one). */
	write(entry: unknown, t?: FakeTerminal): void {
		const path = t === undefined ? this.#current : this.transcriptOf(t);
		if (path === undefined) throw new Error('fake claude: no transcript yet');
		const lines = this.#lines.get(path) ?? [];
		lines.push(JSON.stringify(entry));
		this.#lines.set(path, lines);
		this.core.files.set(path, lines.map((l) => `${l}\n`).join(''));
	}

	say(text: string, t?: FakeTerminal): void {
		this.write({ type: 'assistant', message: { content: [{ type: 'text', text }] } }, t);
	}

	endTurn(t: FakeTerminal, state = 'idle', duration = 42): void {
		this.write({ type: 'system', subtype: 'turn_duration', durationMs: duration }, t);
		this.core.endTurn(t.address, state);
	}

	answer(t: FakeTerminal, text: string): void {
		this.write(
			{
				type: 'assistant',
				message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }] }
			},
			t
		);
		this.write(
			{
				type: 'user',
				message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'out' }] }
			},
			t
		);
		this.say(text, t);
		this.endTurn(t);
	}
}
