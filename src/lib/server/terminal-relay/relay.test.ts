import { describe, expect, it } from 'vitest';
import { FakeHcCore } from '#lib/test/fake-hc.js';
import { fakeSandboxDriver } from '#lib/test/fake-sandbox-driver.js';
import {
	attachSandboxTerminal,
	RELAY_FINISHED_MESSAGE,
	RELAY_GONE_MESSAGE,
	RELAY_PAUSED_MESSAGE,
	TerminalRelayError,
	type TerminalAttachRequest
} from './relay.js';

function request(mode: 'watch' | 'take_over', received: string[]): TerminalAttachRequest {
	const decoder = new TextDecoder();
	return { mode, cols: 80, rows: 24, onData: (bytes) => void received.push(decoder.decode(bytes)) };
}

async function setup() {
	const core = new FakeHcCore();
	const fake = fakeSandboxDriver(core);
	// The agent's CLI, launched by the session core with its label.
	const client = await fake.connect_hc();
	await client.run({ argv: ['claude'], labels: { 'beadsmith-session': 's1' } });
	client.close();
	const deps = { driver: fake.driver, connect_hc: fake.connect_hc, idle_ms: 60_000 };
	const pick = (live: Parameters<Parameters<typeof attachSandboxTerminal>[2]>[0]) =>
		live.find((terminal) => terminal.labels['beadsmith-session'] === 's1');
	return { core, fake, deps, pick };
}

async function refusal(promise: Promise<unknown>): Promise<TerminalRelayError> {
	const error = await promise.then(
		() => undefined,
		(caught: unknown) => caught
	);
	expect(error).toBeInstanceOf(TerminalRelayError);
	return error as TerminalRelayError;
}

describe('attachSandboxTerminal', () => {
	it('watches the picked terminal without being able to type', async () => {
		const { core, deps, pick } = await setup();
		const received: string[] = [];
		const relay = await attachSandboxTerminal(deps, 'sbx1', pick, request('watch', received));
		const attach = core.calls.find((call) => call.method === 'terminal.attach');
		expect(attach?.params).toMatchObject({ terminal: 't1', observe: true });
		core.output('t1', 'hello');
		await expect.poll(() => received.join('')).toContain('hello');
		expect(() => relay.write(new Uint8Array([97]))).toThrow();
		relay.close();
		await relay.ended;
	});

	it('does not resume a paused sandbox just to look', async () => {
		const { fake, deps, pick } = await setup();
		fake.state.info = { id: 'sbx1', state: 'paused', metadata: {} };
		const error = await refusal(attachSandboxTerminal(deps, 'sbx1', pick, request('watch', [])));
		expect(error.code).toBe('conflict');
		expect(error.message).toBe(RELAY_PAUSED_MESSAGE);
		expect(fake.state.connects).toBe(0);
	});

	it('resumes a paused sandbox to take over, and types into the terminal', async () => {
		const { core, fake, deps, pick } = await setup();
		fake.state.info = { id: 'sbx1', state: 'paused', metadata: {} };
		const relay = await attachSandboxTerminal(deps, 'sbx1', pick, request('take_over', []));
		expect(fake.state.connects).toBe(1);
		relay.write(new TextEncoder().encode('y\r'));
		relay.resize(100, 30);
		await expect.poll(() => core.terminal('t1').typed.length).toBe(2);
		expect(core.terminal('t1').viewer_size).toEqual({ cols: 100, rows: 30 });
		relay.close();
	});

	it('refuses a gone sandbox and a finished terminal', async () => {
		const { core, fake, deps, pick } = await setup();
		core.exit('t1');
		const finished = await refusal(attachSandboxTerminal(deps, 'sbx1', pick, request('watch', [])));
		expect([finished.code, finished.message]).toEqual(['conflict', RELAY_FINISHED_MESSAGE]);
		fake.state.info = undefined;
		const gone = await refusal(attachSandboxTerminal(deps, 'sbx1', pick, request('watch', [])));
		expect([gone.code, gone.message]).toEqual(['conflict', RELAY_GONE_MESSAGE]);
	});

	it('ends with the program and drops its connection', async () => {
		const { core, deps, pick } = await setup();
		const relay = await attachSandboxTerminal(deps, 'sbx1', pick, request('watch', []));
		core.exit('t1', 0);
		expect((await relay.ended).reason).toBe('exited');
		await expect.poll(() => core.connections.size).toBe(0);
	});
});
