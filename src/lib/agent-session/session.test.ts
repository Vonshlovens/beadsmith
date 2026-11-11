import { afterEach, describe, expect, it } from 'vitest';
import { connectHc, type HcClient } from '#lib/hc/client.js';
import type { MissionEvent } from '#lib/mission-events.js';
import { FakeHcCore, type FakeTerminal } from '#lib/test/fake-hc.js';
import { claudeCode } from './claude-code';
import {
	AgentSession,
	SESSION_LABEL,
	SessionError,
	parseSessionEventId,
	type AgentSessionOptions,
	type SessionState
} from './session';

const SESSION = '0b7c1f2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
const LAUNCH = { session_id: SESSION, cwd: '/home/user/run', config_dir: '/home/user/.claude' };
const TRANSCRIPT = `/home/user/.claude/projects/-home-user-run/${SESSION}.jsonl`;
const TIMING = { poll_ms: 5, startup_ms: 500, settle_ms: 100, turn_ms: 5_000 };

const later = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, ms = 1_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error('condition never held');
		await later(2);
	}
}

const clients: HcClient[] = [];
afterEach(() => {
	for (const client of clients.splice(0)) client.close();
});

async function open(core: FakeHcCore): Promise<HcClient> {
	const client = await connectHc(core.connect());
	clients.push(client);
	return client;
}

/** A fake Claude Code: idle at launch, and a scripted turn per message. */
class FakeClaude {
	readonly core = new FakeHcCore();
	readonly lines: string[] = [];
	/** What a message does; the default answers and ends the turn. */
	onMessage: (t: FakeTerminal, text: string) => void = (t, text) => this.answer(t, `Echo: ${text}`);
	/** Status reported right after launch. */
	launch_status: string | null = 'idle';

	constructor() {
		this.core.onRun = (t) => {
			if (this.launch_status !== null) this.core.setStatus(t.address, this.launch_status);
		};
		this.core.onSend = (t, text) => {
			queueMicrotask(() => {
				this.write({ type: 'user', message: { role: 'user', content: text } });
				this.core.setStatus(t.address, 'working');
				this.onMessage(t, text);
			});
		};
	}

	write(entry: unknown): void {
		this.lines.push(JSON.stringify(entry));
		this.core.files.set(TRANSCRIPT, this.lines.map((l) => `${l}\n`).join(''));
	}

	say(text: string): void {
		this.write({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
	}

	endTurn(t: FakeTerminal, state = 'idle', duration = 42): void {
		this.write({ type: 'system', subtype: 'turn_duration', durationMs: duration });
		this.core.endTurn(t.address, state);
	}

	answer(t: FakeTerminal, text: string): void {
		this.write({
			type: 'assistant',
			message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }] }
		});
		this.write({
			type: 'user',
			message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'out' }] }
		});
		this.say(text);
		this.endTurn(t);
	}
}

function session(extra: Partial<AgentSessionOptions> = {}): {
	session: AgentSession;
	events: MissionEvent[];
	states: SessionState[];
} {
	const events: MissionEvent[] = [];
	const states: SessionState[] = [];
	const s = new AgentSession({
		harness: claudeCode,
		launch: LAUNCH,
		labels: { 'beadsmith-chat': 'c1' },
		onEvent: (e) => events.push(e),
		onState: (state) => states.push(state),
		timing: TIMING,
		...extra
	});
	return { session: s, events, states };
}

const results = (events: MissionEvent[]) => events.filter((e) => e.type === 'result');

describe('AgentSession start', () => {
	it('launches the CLI with labels, waits for its prompt and sends the prompt by paste', async () => {
		const fake = new FakeClaude();
		const { session: s, events, states } = session();
		await s.start(await open(fake.core), { prompt: 'Fix the bug' });
		const t = fake.core.terminal(s.terminal!);
		expect(t.argv).toEqual([
			'claude',
			'--permission-mode',
			'bypassPermissions',
			'--session-id',
			SESSION
		]);
		expect(t.argv.join(' ')).not.toContain('Fix the bug');
		expect(t.cwd).toBe('/home/user/run');
		expect(t.labels).toEqual({ 'beadsmith-chat': 'c1', [SESSION_LABEL]: SESSION });
		expect(t.sent).toEqual(['Fix the bug']);
		await until(() => results(events).length === 1);
		expect(events.map(({ id, type }) => `${id} ${type}`)).toEqual([
			'2.0 tool_call',
			'3.0 tool_call',
			'4.0 assistant',
			'5.9000 result'
		]);
		expect(results(events)[0]).toMatchObject({
			status: 'succeeded',
			text: 'Echo: Fix the bug',
			duration_ms: 42
		});
		expect(states).toEqual(['idle', 'working', 'idle']);
		expect(s.busy).toBe(false);
	});

	it('does not treat the startup idle as the end of a turn', async () => {
		const fake = new FakeClaude();
		fake.onMessage = () => {};
		const { session: s, events } = session();
		await s.start(await open(fake.core), { prompt: 'Work' });
		const t = fake.core.terminal(s.terminal!);
		fake.core.setStatus(t.address, 'idle');
		await later(30);
		expect(results(events)).toHaveLength(0);
		expect(s.busy).toBe(true);
		fake.say('Finished.');
		fake.endTurn(t, 'done');
		await until(() => results(events).length === 1);
		expect(results(events)[0]).toMatchObject({ status: 'succeeded', text: 'Finished.' });
	});

	it('fails a launch that stops at a prompt and kills it rather than answering', async () => {
		const fake = new FakeClaude();
		fake.launch_status = 'blocked';
		const { session: s, states } = session();
		const error = await s.start(await open(fake.core), { prompt: 'x' }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(SessionError);
		expect((error as SessionError).code).toBe('startup');
		expect((error as SessionError).message).toMatch(/first-run/);
		await until(() => [...fake.core.terminals.values()][0].state === 'finished');
		expect([...fake.core.terminals.values()][0].sent).toEqual([]);
		expect(states.at(-1)).toBe('ended');
	});

	it('fails a launch that never reaches its prompt in time', async () => {
		const fake = new FakeClaude();
		fake.launch_status = null;
		const { session: s } = session({ timing: { ...TIMING, startup_ms: 30 } });
		await expect(s.start(await open(fake.core))).rejects.toMatchObject({ code: 'startup' });
	});
});

describe('AgentSession turns', () => {
	it('sends a follow-up to the same terminal and refuses one while working', async () => {
		const fake = new FakeClaude();
		let hold: FakeTerminal | undefined;
		fake.onMessage = (t) => (hold = t);
		const { session: s, events } = session();
		await s.start(await open(fake.core), { prompt: 'One' });
		await until(() => hold !== undefined);
		await expect(s.send('Two')).rejects.toMatchObject({ code: 'conflict' });
		fake.say('First answer.');
		fake.endTurn(hold!);
		await until(() => results(events).length === 1);

		fake.onMessage = (t, text) => fake.answer(t, `Again: ${text}`);
		await s.send('Two');
		await until(() => results(events).length === 2);
		expect(fake.core.terminals.size).toBe(1);
		expect(fake.core.terminal(s.terminal!).sent).toEqual(['One', 'Two']);
		expect(results(events).map((e) => e.text)).toEqual(['First answer.', 'Again: Two']);
		const ids = events.map((e) => parseSessionEventId(e.id)!);
		for (let i = 1; i < ids.length; i++) {
			const [a, b] = [ids[i - 1], ids[i]];
			expect(a.line < b.line || (a.line === b.line && a.index < b.index)).toBe(true);
		}
	});

	it('ends an interrupted turn as cancelled and keeps the CLI', async () => {
		const fake = new FakeClaude();
		fake.onMessage = () => fake.say('Starting…');
		fake.core.onInterrupt = (t) => queueMicrotask(() => fake.core.setStatus(t.address, 'idle'));
		const { session: s, events } = session();
		await s.start(await open(fake.core), { prompt: 'Long job' });
		await until(() => events.some((e) => e.type === 'assistant'));
		await s.interrupt();
		await until(() => results(events).length === 1);
		expect(results(events)[0]).toMatchObject({ status: 'cancelled' });
		expect(fake.core.terminal(s.terminal!).state).toBe('live');
		expect(s.state).toBe('idle');
	});

	it('ends a turn whose terminal reports error as failed', async () => {
		const fake = new FakeClaude();
		fake.onMessage = (t) => {
			fake.write({
				type: 'assistant',
				isApiErrorMessage: true,
				message: { content: [{ type: 'text', text: 'API Error: overloaded' }] }
			});
			fake.endTurn(t, 'error');
		};
		const { session: s, events } = session();
		await s.start(await open(fake.core), { prompt: 'Try' });
		await until(() => results(events).length === 1);
		expect(results(events)[0]).toMatchObject({ status: 'failed', text: 'API Error: overloaded' });
		expect(s.state).toBe('idle');
	});

	it('waits a settle time for the transcript, then ends the turn anyway', async () => {
		const fake = new FakeClaude();
		fake.onMessage = (t) => {
			fake.say('No end record.');
			fake.core.endTurn(t.address, 'idle');
		};
		const { session: s, events } = session();
		await s.start(await open(fake.core), { prompt: 'Go' });
		await until(() => results(events).length === 1);
		expect(results(events)[0]).toMatchObject({ status: 'succeeded', text: 'No end record.' });
		expect(results(events)[0]).not.toHaveProperty('duration_ms');
	});

	it('surfaces blocked as needing a decision and never answers it', async () => {
		const fake = new FakeClaude();
		let hold: FakeTerminal | undefined;
		fake.onMessage = (t) => {
			hold = t;
			fake.core.setStatus(t.address, 'blocked');
		};
		const { session: s, events, states } = session();
		await s.start(await open(fake.core), { prompt: 'Risky' });
		await until(() => s.state === 'blocked');
		expect(states).toContain('blocked');
		expect(hold!.keys).toEqual([]);
		fake.core.setStatus(hold!.address, 'working');
		await until(() => s.state === 'working');
		fake.endTurn(hold!);
		await until(() => results(events).length === 1);
	});

	it('fails a turn whose program exits mid-turn', async () => {
		const fake = new FakeClaude();
		fake.onMessage = (t) => {
			fake.say('Partial.');
			fake.core.exit(t.address, 1);
		};
		const { session: s, events } = session();
		await s.start(await open(fake.core), { prompt: 'Crash' });
		await until(() => s.state === 'ended');
		expect(events.map((e) => e.type)).toEqual(['assistant', 'error', 'result']);
		expect(results(events)[0]).toMatchObject({ status: 'failed' });
		await expect(s.send('more')).rejects.toMatchObject({ code: 'ended' });
	});

	it('cancels by killing the program; a turn under way ends cancelled', async () => {
		const fake = new FakeClaude();
		fake.onMessage = () => {};
		const { session: s, events } = session();
		await s.start(await open(fake.core), { prompt: 'Work' });
		await until(() => s.state === 'working');
		await s.cancel();
		expect(fake.core.terminal(s.terminal!).state).toBe('finished');
		expect(fake.core.terminal(s.terminal!).reason).toBe('killed');
		expect(results(events)).toEqual([expect.objectContaining({ status: 'cancelled' })]);
		expect(events.filter((e) => e.type === 'error')).toEqual([]);
		expect(s.state).toBe('ended');
	});

	it('stops a turn that runs past its limit', async () => {
		const fake = new FakeClaude();
		fake.onMessage = () => {};
		const { session: s, events } = session({ timing: { ...TIMING, turn_ms: 40 } });
		await s.start(await open(fake.core), { prompt: 'Forever' });
		await until(() => s.state === 'ended');
		expect(fake.core.terminal(s.terminal!).reason).toBe('killed');
		expect(events.map((e) => e.type)).toEqual(['error', 'result']);
		expect(results(events)[0]).toMatchObject({ status: 'failed' });
	});

	it('scrubs the Dolt password from events and the result', async () => {
		const fake = new FakeClaude();
		fake.onMessage = (t) => fake.answer(t, 'The password is s3cr3t-dolt-pw.');
		const { session: s, events } = session({ redact: 's3cr3t-dolt-pw' });
		await s.start(await open(fake.core), { prompt: 'Leak it' });
		await until(() => results(events).length === 1);
		expect(JSON.stringify(events)).not.toContain('s3cr3t-dolt-pw');
	});
});

describe('AgentSession pause and resume', () => {
	it('re-attaches to a terminal that kept running and finishes the turn', async () => {
		const fake = new FakeClaude();
		let hold: FakeTerminal | undefined;
		fake.onMessage = (t) => {
			hold = t;
			fake.say('Before the pause.');
		};
		const { session: s, events, states } = session();
		await s.start(await open(fake.core), { prompt: 'Work' });
		await until(() => events.length === 1);
		fake.core.disconnectAll();
		await until(() => s.state === 'disconnected');
		expect(states).toContain('disconnected');

		fake.say('During the pause.');
		fake.endTurn(hold!);
		await s.reconnect(await open(fake.core));
		await until(() => results(events).length === 1);
		expect(events.map((e) => (e.type === 'result' ? e.status : e.type))).toEqual([
			'assistant',
			'assistant',
			'succeeded'
		]);
		expect(fake.core.terminals.size).toBe(1);
		expect(s.state).toBe('idle');
	});

	it('fails the lost turn and resumes the CLI session in a new terminal', async () => {
		const fake = new FakeClaude();
		fake.onMessage = () => {};
		const { session: s, events } = session();
		await s.start(await open(fake.core), { prompt: 'Work' });
		await until(() => s.state === 'working');
		const first = s.terminal!;
		fake.core.disconnectAll();
		await until(() => s.state === 'disconnected');
		fake.core.exit(first, 137, 'killed');

		await s.reconnect(await open(fake.core));
		expect(events.map((e) => e.type)).toEqual(['error', 'result']);
		expect(results(events)[0]).toMatchObject({ status: 'failed' });
		expect(s.terminal).not.toBe(first);
		expect(fake.core.terminal(s.terminal!).argv).toContain('--resume');
		expect(s.state).toBe('idle');

		fake.onMessage = (t, text) => fake.answer(t, `Back: ${text}`);
		await s.send('Continue');
		await until(() => results(events).length === 2);
		expect(results(events)[1]).toMatchObject({ status: 'succeeded', text: 'Back: Continue' });
	});

	it('skips events the client already has when resumed with Last-Event-ID', async () => {
		const fake = new FakeClaude();
		fake.onMessage = () => {};
		fake.write({ type: 'assistant', message: { content: [{ type: 'text', text: 'Seen.' }] } });
		fake.write({ type: 'assistant', message: { content: [{ type: 'text', text: 'Not yet.' }] } });
		const { session: s, events } = session({ after: '1.0' });
		await s.start(await open(fake.core), { resume: true, prompt: 'Next' });
		await until(() => events.length >= 1);
		expect(events[0]).toMatchObject({ id: '2.0', text: 'Not yet.' });
		expect(events.some((e) => e.type === 'assistant' && e.text === 'Seen.')).toBe(false);
	});
});

describe('AgentSession attach', () => {
	it('picks up a turn another session object started, from its mark', async () => {
		const fake = new FakeClaude();
		fake.onMessage = () => {};
		const { session: starter } = session();
		await starter.start(await open(fake.core));
		const mark = await starter.send('Work');
		expect(mark).toEqual({ base: 0, first_line: 1 });
		starter.close();

		const { session: s, events } = session();
		await s.attach(await open(fake.core), { turn: mark });
		await s.settled();
		expect(s.state).toBe('working');
		expect(results(events)).toEqual([]);

		fake.answer(fake.core.terminal(s.terminal!), 'Finished.');
		await until(() => results(events).length === 1);
		expect(results(events)[0]).toMatchObject({ status: 'succeeded', text: 'Finished.' });
		// One terminal throughout: attach followed the live one.
		expect(fake.core.terminals.size).toBe(1);
	});

	it('reports a turn that already ended once settled', async () => {
		const fake = new FakeClaude();
		const { session: starter } = session();
		await starter.start(await open(fake.core));
		const mark = await starter.send('Quick');
		starter.close();
		await later(10);

		const { session: s, events } = session();
		await s.attach(await open(fake.core), { turn: mark });
		await s.settled();
		expect(events.map((e) => e.type)).toEqual(['tool_call', 'tool_call', 'assistant', 'result']);
		expect(results(events)[0]).toMatchObject({ status: 'succeeded', text: 'Echo: Quick' });
	});

	it('fails the turn and ends without relaunching when told not to', async () => {
		const fake = new FakeClaude();
		fake.onMessage = () => {};
		const { session: starter } = session();
		await starter.start(await open(fake.core));
		const mark = await starter.send('Work');
		starter.close();
		fake.core.exit(starter.terminal!, 1);

		const { session: s, events } = session();
		await s.attach(await open(fake.core), { turn: mark, relaunch: false });
		await s.settled();
		expect(events.map((e) => e.type)).toEqual(['error', 'result']);
		expect(results(events)[0]).toMatchObject({ status: 'failed' });
		expect(s.state).toBe('ended');
		expect(fake.core.terminals.size).toBe(1);
	});

	it('launches a fresh CLI when nothing ran yet and starts reading at the end', async () => {
		const fake = new FakeClaude();
		const { session: s, events } = session();
		await s.attach(await open(fake.core));
		expect(fake.core.terminal(s.terminal!).argv).toContain('--session-id');
		await s.send('Hello');
		await until(() => results(events).length === 1);

		// A later attach with no live terminal resumes, and skips earlier turns.
		fake.core.exit(s.terminal!);
		s.close();
		const { session: again, events: later_events } = session();
		await again.attach(await open(fake.core));
		expect(fake.core.terminal(again.terminal!).argv).toContain('--resume');
		expect(later_events).toEqual([]);
	});
});

describe('parseSessionEventId', () => {
	it('reads line and index and refuses anything else', () => {
		expect(parseSessionEventId('12.9001')).toEqual({ line: 12, index: 9001 });
		expect(parseSessionEventId('0.9000')).toEqual({ line: 0, index: 9000 });
		expect(parseSessionEventId('01.0')).toBeUndefined();
		expect(parseSessionEventId('x')).toBeUndefined();
		expect(parseSessionEventId(undefined)).toBeUndefined();
	});
});
