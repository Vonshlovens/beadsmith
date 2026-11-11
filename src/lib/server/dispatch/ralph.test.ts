import { describe, expect, it } from 'vitest';
import type { MissionEvent } from '#lib/mission-events.js';
import { FakeRalph } from '../../test/fake-ralph.js';
import {
	describeRalphStop,
	parseRalphEvent,
	ralphOutcome,
	ralphRouteAllowed,
	RalphClient,
	RalphError,
	RalphEventMapper,
	type RalphStreamEntry
} from './ralph.js';

const SECRET = 'dolt-password-123';

function setup() {
	const fake = new FakeRalph();
	return { fake, client: new RalphClient(fake.fetch, SECRET) };
}

describe('ralphRouteAllowed', () => {
	it('allows exactly the ADR-0019 routes', () => {
		expect(ralphRouteAllowed('GET', '/v1/runs/loop-1')).toBe(true);
		expect(ralphRouteAllowed('GET', '/v1/runs/loop-1/report')).toBe(true);
		expect(ralphRouteAllowed('GET', '/v1/runs/loop-1/stream')).toBe(true);
		expect(ralphRouteAllowed('POST', '/v1/runs/loop-1/steer')).toBe(true);
		expect(ralphRouteAllowed('POST', '/v1/runs/loop-1/stop')).toBe(true);
	});

	it('refuses starting, restarting, schedules, logs, queries and odd names', () => {
		for (const [method, path] of [
			['POST', '/v1/runs'],
			['POST', '/v1/runs/loop-1/restart'],
			['GET', '/v1/schedules'],
			['POST', '/v1/schedules/nightly/run'],
			['GET', '/v1/runs/loop-1/log'],
			['GET', '/v1/runs/loop-1/stream?after=3'],
			['GET', '/v1/plan'],
			['POST', '/v1/runs/loop-1'],
			['GET', '/v1/runs/loop-1/steer'],
			['DELETE', '/v1/runs/loop-1'],
			['GET', '/v1/runs/..'],
			['GET', '/v1/runs/../report'],
			['GET', '/v1/runs/a%2Fb']
		]) {
			expect(ralphRouteAllowed(method, path), `${method} ${path}`).toBe(false);
		}
	});
});

describe('ralphOutcome', () => {
	it('maps exit codes when no stop reason is known', () => {
		expect(ralphOutcome({ exit_code: 0 })).toEqual({ status: 'succeeded', needs_person: false });
		expect(ralphOutcome({ exit_code: 3 })).toEqual({ status: 'succeeded', needs_person: true });
		expect(ralphOutcome({ exit_code: 130 })).toEqual({ status: 'cancelled', needs_person: false });
		expect(ralphOutcome({ exit_code: 1 })).toEqual({ status: 'failed', needs_person: false });
		expect(ralphOutcome({})).toEqual({ status: 'failed', needs_person: false });
	});

	it('prefers the stop reason: a graceful operator stop exits 0 but is a cancel', () => {
		expect(ralphOutcome({ stop_reason: 'operator_stop', exit_code: 0 }).status).toBe('cancelled');
		expect(ralphOutcome({ stop_reason: 'plan_complete', exit_code: 0 }).status).toBe('succeeded');
		expect(ralphOutcome({ stop_reason: 'plan_exhausted', exit_code: 3 })).toEqual({
			status: 'succeeded',
			needs_person: true
		});
		expect(ralphOutcome({ stop_reason: 'no_progress' }).needs_person).toBe(true);
		expect(ralphOutcome({ stop_reason: 'validate_failed', exit_code: 1 }).status).toBe('failed');
		expect(ralphOutcome({ stop_reason: 'crashed' }).status).toBe('failed');
	});

	it('describes why a loop ended', () => {
		expect(describeRalphStop('plan_complete', 4)).toBe(
			'The loop ended after 4 iterations: no open plan items are left.'
		);
		expect(describeRalphStop('plan_exhausted', 1)).toContain('A person should look.');
		expect(describeRalphStop(null, 0)).toBe('The loop ended after 0 iterations.');
	});
});

describe('RalphClient records', () => {
	it('reads a run and its iterations, dropping raw fields', async () => {
		const { fake, client } = setup();
		fake.addRun({ name: 'loop-1', status: 'finished', stopReason: 'plan_complete' });
		fake.iterations.set('loop-1', [
			{
				iteration: 1,
				outcome: 'completed',
				startedAt: '2026-11-11T10:00:00.000Z',
				finishedAt: '2026-11-11T10:04:00.000Z',
				durationMs: 240000,
				sessionId: 'abc',
				attachId: 'hc:{"socket":"/tmp/x"}',
				headBefore: 'aaaaaaa',
				headAfter: 'bbbbbbb',
				inputTokens: 100,
				outputTokens: 50,
				costUsd: 0.12,
				lastAssistant: `the password is ${SECRET}`,
				error: null,
				validateOk: true,
				planOpen: 3
			},
			{ iteration: 'two', outcome: 'completed' }
		]);
		const detail = await client.getRun('loop-1');
		expect(detail.run).toEqual({
			id: 'run-loop-1',
			name: 'loop-1',
			mode: 'build',
			status: 'finished',
			alive: true,
			current_iteration: 1,
			max_iterations: 10,
			stop_reason: 'plan_complete',
			started_at: '2026-11-11T10:00:00.000Z',
			updated_at: '2026-11-11T10:05:00.000Z',
			input_tokens: 10,
			output_tokens: 20,
			cost_usd: 0.5
		});
		expect(detail.iterations).toEqual([
			{
				iteration: 1,
				outcome: 'completed',
				started_at: '2026-11-11T10:00:00.000Z',
				finished_at: '2026-11-11T10:04:00.000Z',
				duration_ms: 240000,
				head_before: 'aaaaaaa',
				head_after: 'bbbbbbb',
				input_tokens: 100,
				output_tokens: 50,
				cost_usd: 0.12,
				validate_ok: true,
				plan_open: 3
			}
		]);
		expect(JSON.stringify(detail)).not.toContain(SECRET);
		expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /v1/runs/loop-1']);
	});

	it('reads an unknown stop reason from a newer ralph as none', async () => {
		const { fake, client } = setup();
		fake.addRun({ name: 'loop-1', status: 'finished', stopReason: 'something_new' });
		expect((await client.getRun('loop-1')).run.stop_reason).toBeNull();
	});

	it('rejects a malformed run', async () => {
		const { fake, client } = setup();
		fake.addRun({ name: 'loop-1', mode: 'teleport' as 'build' });
		await expect(client.getRun('loop-1')).rejects.toMatchObject({ status: 0 });
	});

	it('narrows and scrubs a report', async () => {
		const { fake, client } = setup();
		fake.addRun({ name: 'loop-1', status: 'finished', stopReason: 'plan_exhausted' });
		fake.reports.set('loop-1', {
			run: { prompt: 'raw' },
			stopReason: 'plan_exhausted',
			iterations: 2,
			durationMs: 1000,
			outcomes: { completed: 2 },
			tokens: { input: 5, output: 6 },
			costUsd: 0.2,
			commits: ['abc1234 Fix the thing', `def5678 Leak ${SECRET}`],
			diffStat: ' src/a.ts | 2 +-',
			plan: {
				backend: 'beads',
				before: { open: 4, total: 5 },
				after: { open: 1, total: 5, ready: 0 }
			},
			validate: { runs: 2, failures: 1, last: { output: 'raw output' } },
			needsHuman: ['iteration 2: which database?'],
			lastWords: 'raw',
			logPath: '/home/agent/run.log'
		});
		const report = await client.getReport('loop-1');
		expect(report).toEqual({
			stop_reason: 'plan_exhausted',
			iterations: 2,
			duration_ms: 1000,
			input_tokens: 5,
			output_tokens: 6,
			cost_usd: 0.2,
			commits: ['abc1234 Fix the thing', 'def5678 Leak [redacted]'],
			plan: { open_before: 4, open_after: 1, ready_after: 0 },
			validate: { runs: 2, failures: 1 },
			needs_person: ['iteration 2: which database?']
		});
	});

	it('steers and stops', async () => {
		const { fake, client } = setup();
		fake.addRun({ name: 'loop-1' });
		expect(await client.steer('loop-1', '  focus on the API  ')).toBe(1);
		expect(fake.steers).toEqual([{ name: 'loop-1', text: 'focus on the API' }]);
		expect(await client.stop('loop-1', { graceful: true })).toBe('stopping');
		expect(await client.stop('loop-1', { graceful: false })).toBe('stopped');
		expect(fake.stops).toEqual([
			{ name: 'loop-1', graceful: true },
			{ name: 'loop-1', graceful: false }
		]);
	});

	it('refuses empty or oversized steers and bad names before calling ralph', async () => {
		const { fake, client } = setup();
		await expect(client.steer('loop-1', '   ')).rejects.toBeInstanceOf(RalphError);
		await expect(client.steer('loop-1', 'x'.repeat(4001))).rejects.toBeInstanceOf(RalphError);
		await expect(client.getRun('..')).rejects.toBeInstanceOf(RalphError);
		await expect(client.getRun('a/b')).rejects.toBeInstanceOf(RalphError);
		expect(fake.requests).toEqual([]);
	});

	it('turns HTTP failures and an unreachable channel into RalphErrors', async () => {
		const { client } = setup();
		await expect(client.getRun('missing')).rejects.toMatchObject({
			status: 404,
			message: 'ralph has no such run.'
		});
		const down = new RalphClient(async () => {
			throw new Error('connect ECONNREFUSED 127.0.0.1:7420');
		}, SECRET);
		await expect(down.getRun('loop-1')).rejects.toMatchObject({
			status: 0,
			message: 'ralph could not be reached.'
		});
	});
});

describe('RalphClient.streamEvents', () => {
	function seed(fake: FakeRalph) {
		fake.addRun({ name: 'loop-1', status: 'finished', stopReason: 'plan_complete' });
		fake.emit('loop-1', { type: 'run_started', mode: 'build', dir: '/home/agent/work' });
		fake.emit('loop-1', { type: 'iteration_started', prompt: 'the whole prompt' });
		fake.emit('loop-1', { type: 'assistant', text: 'Working on it.' });
		fake.emit('loop-1', { type: 'usage', inputTokens: 3 });
		fake.emit('loop-1', { type: 'run_finished', reason: 'plan_complete', iterations: 1 });
	}

	it('reads events until ralph ends the stream', async () => {
		const { fake, client } = setup();
		seed(fake);
		const seen: RalphStreamEntry[] = [];
		const outcome = await client.streamEvents('loop-1', (entry) => {
			seen.push(entry);
		});
		expect(outcome).toBe('terminal');
		expect(seen.map((entry) => `${entry.id}:${entry.event.type}`)).toEqual([
			'2:iteration_started',
			'3:assistant',
			'5:run_finished'
		]);
		expect(JSON.stringify(seen)).not.toContain('the whole prompt');
	});

	it('resumes after Last-Event-ID', async () => {
		const { fake, client } = setup();
		seed(fake);
		const seen: string[] = [];
		await client.streamEvents('loop-1', (entry) => void seen.push(entry.id), {
			last_event_id: '3'
		});
		expect(seen).toEqual(['5']);
		expect(fake.requests.at(-1)?.headers['last-event-id']).toBe('3');
		await expect(
			client.streamEvents('loop-1', () => {}, { last_event_id: 'abc' })
		).rejects.toBeInstanceOf(RalphError);
	});

	it('reports a dropped channel as disconnected', async () => {
		const { fake, client } = setup();
		seed(fake);
		fake.dropStream = true;
		expect(await client.streamEvents('loop-1', () => {})).toBe('disconnected');
	});
});

describe('RalphEventMapper', () => {
	function mapAll(events: Array<Record<string, unknown>>, secret = SECRET): MissionEvent[] {
		const mapper = new RalphEventMapper(secret);
		const out: MissionEvent[] = [];
		events.forEach((raw, index) => {
			const event = parseRalphEvent({ iteration: 1, ...raw });
			if (event === undefined) return;
			const mapped = mapper.map({ id: String(index + 1), event });
			if (mapped !== undefined) out.push(mapped);
		});
		return out;
	}

	it('maps text, tool calls and results, and the end of the run', () => {
		expect(
			mapAll([
				{ type: 'iteration_started', prompt: 'p' },
				{ type: 'thinking', text: 'Hmm.' },
				{ type: 'assistant', text: `Using ${SECRET} now` },
				{ type: 'tool_call', name: 'Bash', input: 'cat ~/.ssh/id_ed25519' },
				{ type: 'tool_call', name: 'mcp__crew__file.read', input: '{}' },
				{ type: 'tool_result', output: 'private key', isError: false },
				{ type: 'tool_result', output: 'nope', isError: true },
				{ type: 'iteration_finished', outcome: 'completed', durationMs: 5 },
				{ type: 'run_finished', reason: 'plan_complete', iterations: 1 }
			])
		).toEqual([
			{ type: 'thinking', id: '2', text: 'Hmm.' },
			{ type: 'assistant', id: '3', text: 'Using [redacted] now' },
			{ type: 'tool_call', id: '4', call_id: '1.4', name: 'Bash', status: 'running' },
			{
				type: 'tool_call',
				id: '5',
				call_id: '1.5',
				name: 'mcp__crew__file_read',
				status: 'running'
			},
			{ type: 'tool_call', id: '6', call_id: '1.4', name: 'Bash', status: 'completed' },
			{
				type: 'tool_call',
				id: '7',
				call_id: '1.5',
				name: 'mcp__crew__file_read',
				status: 'failed'
			},
			{
				type: 'result',
				id: '9',
				status: 'succeeded',
				text: 'The loop ended after 1 iteration: no open plan items are left.'
			}
		]);
	});

	it('drops a tool result whose call it never saw, and calls left open by a finished iteration', () => {
		expect(
			mapAll([
				{ type: 'tool_result', output: 'x', isError: false },
				{ type: 'tool_call', name: 'Read', input: '' },
				{ type: 'iteration_started', iteration: 2, prompt: 'p' },
				{ type: 'tool_result', iteration: 2, output: 'x', isError: false }
			])
		).toEqual([{ type: 'tool_call', id: '2', call_id: '1.2', name: 'Read', status: 'running' }]);
	});

	it('surfaces errors, questions, failed validation and steer notes', () => {
		expect(
			mapAll([
				{ type: 'error', kind: 'auth', message: 'Authorization: Bearer abcdef' },
				{ type: 'needs_input', reason: 'Which database?' },
				{ type: 'validate', ok: false, results: [{ output: 'raw' }] },
				{ type: 'validate', ok: true, results: [] },
				{ type: 'steer_received', id: 1, kind: 'note', text: 'Skip the docs.' },
				{ type: 'steer_received', id: 2, kind: 'stop', text: 'stop requested by operator' },
				{ type: 'run_finished', reason: 'operator_stop', iterations: 2 }
			])
		).toEqual([
			{ type: 'error', id: '1', message: '[redacted credential] [redacted]' },
			{ type: 'error', id: '2', message: 'Iteration 1 needs a person: Which database?' },
			{ type: 'error', id: '3', message: 'Validation failed after iteration 1.' },
			{ type: 'user', id: '5', text: 'Skip the docs.' },
			{
				type: 'result',
				id: '7',
				status: 'cancelled',
				text: 'The loop ended after 2 iterations: it was stopped.'
			}
		]);
	});

	it('ignores events Beadsmith does not show', () => {
		expect(
			mapAll([
				{ type: 'usage', inputTokens: 1 },
				{ type: 'plan_updated', plan: {} },
				{ type: 'notice', text: 'hi' },
				{ type: 'session', sessionId: 's' },
				{ type: 'assistant', text: '   ' },
				{ type: 'iteration_finished', outcome: 'exploded' },
				'not an object' as unknown as Record<string, unknown>
			])
		).toEqual([]);
	});
});
